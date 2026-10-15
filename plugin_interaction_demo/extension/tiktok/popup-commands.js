// 命令处理与通信：队列、轮询 Python、执行指令
// 约定：本文件通过 popup.html 在 popup.js 之前加载（全局函数）。
// 说明：这里使用 tk_* 前缀避免被 popup.js 内部历史重复定义覆盖。

function tk_getCfg() {
    return (typeof window !== 'undefined' && window.__TK_CONFIG__) || {
        PORT: 8099,
        PLATFORM: 'tiktok',
        BUILD_ID: 'unknown',
        LOOP_THRESHOLD: 5,
    };
}

function tk_getClientId() {
    let id = null;
    try {
        id = localStorage.getItem('plugin_client_id');
    } catch {
        // ignore
    }
    if (!id) {
        id = `client_${Math.random().toString(36).slice(2, 11)}`;
        try {
            localStorage.setItem('plugin_client_id', id);
        } catch {
            // ignore
        }
    }
    return id;
}

async function tk_sendToPython(data) {
    const cfg = tk_getCfg();
    const port = cfg.PORT;
    const platform = cfg.PLATFORM || 'tiktok';

    try {
        data.client_id = tk_getClientId();
        data.platform = platform;

        if (data.extra_data?.comments && typeof updateCommentsDisplay === 'function') {
            updateCommentsDisplay(data.extra_data.comments);
        }

        const response = await fetch(`http://localhost:${port}/data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(`/data 响应异常: ${response.status} ${response.statusText}`);
        }

        const resData = await response.json();
        if (resData.command) {
            void tk_executeIncomingCommand(resData.command, 'post_response');
        }
        if (Array.isArray(resData.commands)) {
            for (const cmd of resData.commands) {
                void tk_executeIncomingCommand(cmd, 'post_response_list');
            }
        }

        try {
            window.__TK_LAST_SEND_ERROR_MESSAGE__ = '';
        } catch {
            // ignore
        }
        return true;
    } catch (e) {
        console.error('[TikTok] 发送给 Python 失败', e);
        try {
            window.__TK_LAST_SEND_ERROR_MESSAGE__ = String(e?.message || e || 'unknown');
        } catch {
            // ignore
        }
        if (typeof logToUI === 'function') {
            logToUI(`发送给 Python 失败: ${e.message}`, 'error');
        }

        return false;
    }
}

let tk_isConnected = false;
let tk_connectionErrorCount = 0;

async function tk_pollPythonCommands() {
    const cfg = tk_getCfg();
    const port = cfg.PORT;

    try {
        const response = await fetch(`http://localhost:${port}/poll?ready=true`);
        if (!response.ok) {
            throw new Error(`/poll 响应异常: ${response.status} ${response.statusText}`);
        }

        if (!tk_isConnected) {
            tk_isConnected = true;
            tk_connectionErrorCount = 0;
            if (typeof updateStatus === 'function') updateStatus('已连接', '#69db7c');
            if (typeof logToUI === 'function') logToUI(`✅ 已连接到 Python 服务 (${port})`, 'success');
        }

        const data = await response.json();
        if (data.command) {
            void tk_executeIncomingCommand(data.command, 'poll');
        }
        if (Array.isArray(data.commands) && data.commands.length > 0) {
            for (const cmd of data.commands) {
                void tk_executeIncomingCommand(cmd, 'poll_list');
            }
        }
    } catch (e) {
        tk_connectionErrorCount += 1;
        if (tk_isConnected) {
            tk_isConnected = false;
            if (typeof updateStatus === 'function') updateStatus('连接失败', '#ff6b6b');
            if (typeof logToUI === 'function') logToUI(`❌ 轮询失败: ${e.message}`, 'error');
        } else if (tk_connectionErrorCount % 10 === 0) {
            if (typeof logToUI === 'function') {
                logToUI(`❌ 轮询失败(累计${tk_connectionErrorCount}次): ${e.message}`, 'warn');
            }
        }
    } finally {
        setTimeout(tk_pollPythonCommands, 200);
    }
}

const TK_COMMAND_NAMES_CN = {
    auto_comment: '自动评论',
    monitor_next: '监控并跳转',
    next_video: '下一个视频',
    refresh_video: '刷新视频流',
    open_comments: '打开评论区',
    like_video: '点赞视频',
    like_top_comment: '高赞点赞',
    like_comment: '点赞评论',
    subscribe: '关注频道',
    subscribe_channel: '关注频道',
    fill_comment: '填充评论',
};

function tk_getCommandNameCN(type) {
    return TK_COMMAND_NAMES_CN[type] || type;
}

let tk_isProcessingCommand = false;
let tk_commandQueue = [];
let tk_monitorCancelToken = 0;

// 防止“跳转风暴”：短时间内连续收到 next_video/monitor_next 时做节流
let tk_lastNextNavAt = 0;

// 最近一次去重的详细原因（供 UI 日志展示）
let tk_lastDropInfo = null;

// 去重：防止 /poll 重复返回同一条指令导致反复点赞/关注（甚至取消）
const tk_recentCommandSigs = new Map();
const tk_recentActionByVideo = new Map();

function tk_extractVideoId(url) {
    try {
        const m = String(url || '').match(/\/video\/(\d+)/);
        return m ? m[1] : '';
    } catch {
        return '';
    }
}

function tk_getCurrentVideoIdFallback() {
    try {
        return String(window.__TK_CURRENT_VIDEO_ID__ || '');
    } catch {
        // ignore
    }

    // 兜底：从当前视频 URL 再提取一次（避免 id 没写入时去重失效）
    try {
        const u = String(window.__TK_CURRENT_VIDEO_URL__ || '');
        const m = u.match(/\/video\/(\d+)/);
        return m ? m[1] : '';
    } catch {
        return '';
    }
}

function tk_commandSig(cmd) {
    if (!cmd) return '';
    const type = String(cmd.type || '').toLowerCase();
    const target = String(cmd.target_url || '');
    const text = String(cmd.text || '');
    const reason = String(cmd.reason || '');
    const id = String(cmd.id || cmd.command_id || cmd.uuid || '');
    // 优先使用服务端 id；否则使用内容签名
    return id ? `id:${id}` : `${type}|${target}|${text}|${reason}`;
}

function tk_shouldDropDuplicateCommand(cmd) {
    tk_lastDropInfo = null;
    const sig = tk_commandSig(cmd);
    if (!sig) return false;
    const now = Date.now();
    const lastAt = tk_recentCommandSigs.get(sig) || 0;
    // 8 秒内同签名指令一律丢弃（覆盖 200ms poll 高频重复）
    if (now - lastAt < 8000) {
        tk_lastDropInfo = {
            reason: 'sig_8s',
            sig,
            ageMs: now - lastAt,
        };
        return true;
    }
    tk_recentCommandSigs.set(sig, now);

    // 对可“反向切换”的动作做更强去重：同一视频的同一动作在较长窗口内最多执行一次
    const type = String(cmd?.type || '').toLowerCase();
    if (type === 'like_video' || type === 'subscribe' || type === 'subscribe_channel') {
        const vid = tk_extractVideoId(cmd?.target_url) || tk_getCurrentVideoIdFallback();
        if (vid) {
            const actionKey = `${vid}|${type}`;
            const lastActionAt = tk_recentActionByVideo.get(actionKey) || 0;
            // 15 分钟内不允许对同一视频重复执行点赞/关注（否则会 toggle 回去）
            if (now - lastActionAt < 15 * 60 * 1000) {
                tk_lastDropInfo = {
                    reason: 'per_video_15m',
                    sig,
                    vid,
                    type,
                    actionKey,
                    ageMs: now - lastActionAt,
                };
                return true; // 去重：拦截重复指令
            }
            tk_recentActionByVideo.set(actionKey, now);
        } else {
            // 没有 vid 时用全局时间戳兜底（防止快速连续指令）
            const globalKey = `_global_${type}`;
            const lastGlobalAt = tk_recentActionByVideo.get(globalKey) || 0;
            if (now - lastGlobalAt < 3000) { // 3秒内不允许重复同类动作
                tk_lastDropInfo = {
                    reason: 'global_3s',
                    sig,
                    type,
                    actionKey: globalKey,
                    ageMs: now - lastGlobalAt,
                };
                return true;
            }
            tk_recentActionByVideo.set(globalKey, now);
        }
    }

    return false;
}

async function tk_executeIncomingCommand(cmd, source = 'unknown') {
    if (!cmd || !cmd.type) return;

    // 只对“会 toggle”的动作打印更详细的入站信息，便于定位重复来源
    try {
        const typeForLog = String(cmd.type || '').toLowerCase();
        if (typeForLog === 'like_video' || typeForLog === 'subscribe' || typeForLog === 'subscribe_channel') {
            const vid = tk_extractVideoId(cmd?.target_url) || tk_getCurrentVideoIdFallback();
            const sig = tk_commandSig(cmd);
            const id = String(cmd.id || cmd.command_id || cmd.uuid || '');
            if (typeof logToUI === 'function') {
                logToUI(
                    `➡️ 收到: ${tk_getCommandNameCN(typeForLog)} (${source})${vid ? ` vid=${vid}` : ''}${id ? ` id=${id}` : ''}${sig ? ` sig=${sig.slice(0, 60)}` : ''}`,
                    'info'
                );
            }
        }
    } catch {
        // ignore
    }

    if (tk_shouldDropDuplicateCommand(cmd)) {
        const type = String(cmd.type || '').toLowerCase();
        const name = tk_getCommandNameCN(type);
        if (typeof logToUI === 'function') {
            const info = tk_lastDropInfo;
            const extra = info
                ? ` reason=${info.reason}${info.vid ? ` vid=${info.vid}` : ''}${Number.isFinite(info.ageMs) ? ` age=${Math.round(info.ageMs)}ms` : ''}`
                : '';
            logToUI(`⛔ 去重忽略: ${name} (${source})${extra}`, 'warn');
        }
        return;
    }

    const type = String(cmd.type || '').toLowerCase();
    const cmdName = tk_getCommandNameCN(type);
    const isMonitorCmd = type === 'monitor_next' || type === 'next_video';

    // 动作指令优先：取消正在进行的 monitor_next（防止“AI 要求点赞但没反应”）
    if (!isMonitorCmd) {
        tk_monitorCancelToken += 1;
        try {
            if (typeof getCurrentTab === 'function') {
                const tab = await getCurrentTab();
                if (tab?.id) {
                    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: _tk_removeMonitorOverlay });
                }
            }
        } catch {
            // ignore
        }
    }

    tk_commandQueue.push({ cmd, source, cmdName });
    if (tk_isProcessingCommand) {
        if (typeof logToUI === 'function') logToUI(`⏸️ 排队指令: ${cmdName} (${source})`, 'warn');
        return;
    }

    tk_isProcessingCommand = true;
    try {
        while (tk_commandQueue.length > 0) {
            const item = tk_commandQueue.shift();
            const nextCmd = item?.cmd;
            const nextSource = item?.source || 'queue';
            const nextName = item?.cmdName || tk_getCommandNameCN(nextCmd?.type);
            try {
                await tk_handleCommand(nextCmd);
                if (typeof logToUI === 'function') logToUI(`✅ 完成: ${nextName} (${nextSource})`, 'success');
            } catch (e) {
                console.error('[TikTok] 指令执行失败', nextCmd, e);
                if (typeof logToUI === 'function') logToUI(`❌ 失败: ${nextName} - ${e.message}`, 'error');
            }
        }
    } finally {
        tk_isProcessingCommand = false;
    }
}

async function tk_handleCommand(cmd) {
    if (!cmd || !cmd.type) return;

    // 统一大小写，避免外部发送 NEXT_VIDEO 等导致分支匹配失败
    try {
        cmd.type = String(cmd.type || '').toLowerCase();
    } catch {
        // ignore
    }

    const cmdName = tk_getCommandNameCN(cmd.type);

    const cmdBox = document.getElementById('latest-cmd-box');
    const cmdContent = document.getElementById('latest-cmd-content');
    if (cmdBox && cmdContent) {
        cmdBox.style.display = 'block';
        cmdContent.textContent = cmd.type === 'auto_comment' && cmd.text ? `${cmdName}: ${cmd.text}` : cmdName;
    }

    if (typeof getCurrentTab !== 'function') throw new Error('getCurrentTab 未就绪');
    const tab = await getCurrentTab();
    if (!tab) throw new Error('未找到活动标签页');

    if (cmd.target_url && tab.url) {
        const extractId = (url) => {
            if (!url) return null;
            const m = String(url).match(/\/video\/(\d+)/);
            return m ? m[1] : null;
        };
        const targetId = extractId(cmd.target_url);
        const currentId = extractId(tab.url);
        if (targetId && currentId && targetId !== currentId) {
            if (typeof logToUI === 'function') logToUI(`⛔ 忽略过期指令: ${cmdName} (视频已切换)`, 'warn');
            return;
        }
    }

    if (cmd.type === 'monitor_next' || cmd.type === 'next_video') {
        // 全局节流：避免同一瞬间多路逻辑叠加导致连续跳多个
        {
            const now = Date.now();
            if (now - (tk_lastNextNavAt || 0) < 1200) {
                if (typeof logToUI === 'function') {
                    logToUI(`⏳ 已节流: ${cmdName} (过于频繁)`, 'warn');
                }
                return;
            }
            tk_lastNextNavAt = now;
        }

        // next_video：立即跳转（不等待播放）
        if (cmd.type === 'next_video') {
            const run = async (fn, args = []) => {
                const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fn, args });
                return results?.[0]?.result;
            };

            await run(typeof nextVideo === 'function' ? nextVideo : nextVideoTikTok);
            return;
        }

        const watchLimitRaw =
            cmd?.watchLimit ??
            cmd?.watch_limit ??
            cmd?.payload?.watchLimit ??
            cmd?.payload?.watch_limit ??
            cmd?.payload?.watch_limit_seconds ??
            0;
        const watchLimitSec = Math.max(0, Number(watchLimitRaw) || 0);

        const reasonRaw = cmd?.reason ?? cmd?.payload?.reason ?? cmd?.payload?.skip_reason ?? cmd?.payload?.skipReason ?? '';
        const reason = String(reasonRaw || '').slice(0, 80);

        const myToken = tk_monitorCancelToken;

        const setPopupMonitorHint = (text) => {
            try {
                const el = document.getElementById('monitor-hint');
                if (!el) return;
                el.textContent = String(text || '');
            } catch {
                // ignore
            }
        };

        const fmt = (sec) => {
            const s = Math.max(0, Math.floor(Number(sec) || 0));
            const m = Math.floor(s / 60);
            const r = s % 60;
            return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
        };

        const run = async (fn, args = []) => {
            const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fn, args });
            return results?.[0]?.result;
        };

        const showOverlay = async (text, tone = 'info') => {
            try {
                await run(_tk_setMonitorOverlay, [text, tone]);
            } catch {
                // ignore
            }
        };
        const hideOverlay = async () => {
            try {
                await run(_tk_removeMonitorOverlay);
            } catch {
                // ignore
            }
        };

        const info0 = await run(extractTargetText).catch(() => null);
        const dur0 = Number(info0?.duration || 0);
        const isWatchAllHint = watchLimitSec >= 300;

        let targetSec = 0;
        if (watchLimitSec > 0) {
            targetSec = dur0 > 0 ? (isWatchAllHint ? dur0 : Math.min(watchLimitSec, dur0)) : (isWatchAllHint ? 15 : watchLimitSec);
            targetSec = Math.max(1, Math.min(3600, targetSec));
        } else {
            targetSec = dur0 > 0 ? Math.max(1, Math.min(3600, dur0)) : 15;
        }

        await showOverlay(`TikTok 监控播放中...${reason ? ` (${reason})` : ''}`, 'info');
        setPopupMonitorHint(
            `监控: ${watchLimitSec > 0 ? `倒计时 ${fmt(Math.max(0, targetSec - Number(info0?.current || 0)))}` : '等待播完'} (原因: ${reason || '-'})`
        );

        const startTs = Date.now();
        let lastCur = null;
        let stuckTicks = 0;
        let missTicks = 0;

        while (true) {
            if (myToken !== tk_monitorCancelToken) {
                await showOverlay('已取消监控：收到新的动作指令，准备执行...', 'warn');
                setPopupMonitorHint('监控: 已取消(执行新指令)');
                await hideOverlay();
                return;
            }

            const info = await run(extractTargetText).catch(() => null);
            const cur = Number(info?.current || 0);
            const dur = Number(info?.duration || 0);
            const elapsed = (Date.now() - startTs) / 1000;

            if (!info) missTicks += 1;
            else missTicks = 0;

            if (lastCur !== null && Math.abs(cur - lastCur) < 0.1) stuckTicks += 1;
            else stuckTicks = 0;
            lastCur = cur;

            if (watchLimitSec > 0) {
                const t = dur > 0 ? Math.min(targetSec, dur) : targetSec;
                if (dur > 0 && cur >= t) break;
                if (dur <= 0 && elapsed >= t) break;
            } else {
                if (dur > 0 && cur >= Math.max(1, dur - 1)) break;
                if (dur <= 0 && elapsed >= targetSec) break;
            }

            if (stuckTicks >= 8 || missTicks >= 6) {
                await showOverlay('监控读取异常/进度卡住，准备跳转', 'warn');
                break;
            }

            if (watchLimitSec > 0) {
                const t = dur > 0 ? Math.min(targetSec, dur) : targetSec;
                setPopupMonitorHint(`监控: 倒计时 ${fmt(Math.max(0, t - cur))} (原因: ${reason || '-'})`);
            } else if (dur > 0) {
                setPopupMonitorHint(`监控: 等待播完(剩余 ${fmt(Math.max(0, dur - cur))}) (原因: ${reason || '-'})`);
            } else {
                setPopupMonitorHint(`监控: 等待播完(未知时长) (原因: ${reason || '-'})`);
            }

            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        await hideOverlay();
        setPopupMonitorHint('监控: 跳转中...');

        const before = await run(extractTargetText).catch(() => null);
        const beforeKey = `${before?.videoId || ''}|${before?.href || ''}|${before?.duration || 0}`;

        const waitForChange = async (timeoutMs = 2500) => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                const info = await run(extractTargetText).catch(() => null);
                const key = `${info?.videoId || ''}|${info?.href || ''}|${info?.duration || 0}`;
                if (key && key !== beforeKey) return { changed: true, key };
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            return { changed: false, key: beforeKey };
        };

        // 优先使用更可靠的 nextVideo()；其次 nextVideoTikTok() 兜底
        await run(typeof nextVideo === 'function' ? nextVideo : nextVideoTikTok);
        const w1 = await waitForChange(2600);
        if (w1.changed) {
            setPopupMonitorHint('监控: -');
            return;
        }

        // 再试一次
        await run(typeof nextVideo === 'function' ? nextVideo : nextVideoTikTok);
        const w2 = await waitForChange(2800);
        if (w2.changed) {
            setPopupMonitorHint('监控: -');
            return;
        }

        // 键盘兜底
        await run(nextVideoTikTok);
        setPopupMonitorHint('监控: -');
        return;
    }

    if (cmd.type === 'refresh_video') {
        // “刷新视频流”：双击左侧小房子/For You（不会整页 reload，因此不会导致插件重载）。
        const cfg = tk_getCfg();
        const port = cfg.PORT;

        const doNativeClick = async (x, y, why, pressMs = 18, count = 1, intervalMs = 55) => {
            const resp = await fetch(`http://localhost:${port}/native_click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x, y, press_ms: pressMs, count, interval_ms: intervalMs, platform: cfg.PLATFORM, why }),
            });
            if (!resp.ok) throw new Error(`/native_click ${resp.status} ${resp.statusText}`);
            try {
                return await resp.json();
            } catch {
                return null;
            }
        };

        const pointRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_getNativeClickPoint_for_home_refresh,
        });
        const p = pointRes?.[0]?.result;
        if (!p?.ok || p?.point?.screenDevice?.x == null || p?.point?.screenDevice?.y == null) {
            if (typeof logToUI === 'function') {
                logToUI(`⚠️ 刷新视频流失败：无法定位左侧 For You/小房子入口 (${p?.reason || 'no_point'})`, 'warn');
            }
            return;
        }

        const x = Number(p.point.screenDevice.x);
        const y = Number(p.point.screenDevice.y);
        if (typeof logToUI === 'function') {
            logToUI(`🏠 桌面双击(左侧 For You/小房子)：x=${x}, y=${y} dpr=${p.point.dpr}${p?.matchedText ? ` text=${p.matchedText}` : ''}`, 'info');
            logToUI('⚠️ 请确保浏览器窗口在前台且不要遮挡/不要移动鼠标', 'warn');
        }

        await doNativeClick(x, y, 'refresh_video_feed_dblclick', 18, 2, 55);
        return;
    }

    if (cmd.type === 'open_comments') {
        // openComments 是注入函数，必须完整传递给 executeScript
        await chrome.scripting.executeScript({ 
            target: { tabId: tab.id }, 
            func: function openComments() {
                const isVisible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
                };

                // 策略1：直接查找按钮
                const buttonSelectors = [
                    'button[aria-label*="comment" i]',
                    'button[aria-label*="评论" i]',
                    '[data-e2e="comment-button"]',
                    '[data-e2e="browse-comment"]',
                ];
                for (const sel of buttonSelectors) {
                    try {
                        const buttons = Array.from(document.querySelectorAll(sel));
                        const btn = buttons.find(isVisible);
                        if (btn) {
                            btn.click();
                            return { ok: true, method: 'direct_button' };
                        }
                    } catch {}
                }

                // 策略2：通过 comment-icon 找父级 button
                const iconSelectors = [
                    '[data-e2e="comment-icon"]',
                    '[data-e2e="feed-comment-icon"]',
                ];
                for (const sel of iconSelectors) {
                    try {
                        const icons = Array.from(document.querySelectorAll(sel));
                        for (const icon of icons) {
                            if (!isVisible(icon)) continue;
                            // 找最近的 button 父元素
                            let btn = icon.closest('button');
                            if (btn && isVisible(btn)) {
                                btn.click();
                                return { ok: true, method: 'icon_closest_button' };
                            }
                        }
                    } catch {}
                }

                return { ok: false, reason: 'no_button_found' };
            }
        });
        return;
    }

    if (cmd.type === 'like_video') {
        // 先读状态：已点赞则直接返回，避免任何点击导致误触。
        try {
            const state0Res = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: tk_readLikeState_simple,
            });
            const s0 = state0Res?.[0]?.result;
            if (String(s0?.ariaPressed || '').toLowerCase() === 'true') {
                if (typeof logToUI === 'function') {
                    logToUI('✅ 视频点赞：已是点赞状态(无需操作)', 'success');
                }
                return;
            }
        } catch {
            // ignore
        }

        // TikTok 点赞按钮是 toggle；用“视频中心双击”点赞更幂等（一般不会取消）。
        const cfg = tk_getCfg();
        const port = cfg.PORT;

        const doNativeClick = async (x, y, why, pressMs = 18, count = 1, intervalMs = 55) => {
            const resp = await fetch(`http://localhost:${port}/native_click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x, y, press_ms: pressMs, count, interval_ms: intervalMs, platform: cfg.PLATFORM, why }),
            });
            if (!resp.ok) throw new Error(`/native_click ${resp.status} ${resp.statusText}`);
            try {
                return await resp.json();
            } catch {
                return null;
            }
        };

        const verifyLiked = async () => {
            const stateRes = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: tk_readLikeState_simple,
            });
            const s = stateRes?.[0]?.result;
            return { s, pressed: String(s?.ariaPressed || '').toLowerCase() === 'true' };
        };

        // 1) 优先：视频中心坐标 + 桌面层双击
        try {
            const pointRes = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: tk_getNativeClickPoint_for_video_center,
            });
            const p = pointRes?.[0]?.result;
            if (p?.ok && p?.point?.screenDevice?.x != null && p?.point?.screenDevice?.y != null) {
                const x = Number(p.point.screenDevice.x);
                const y = Number(p.point.screenDevice.y);
                if (typeof logToUI === 'function') {
                    logToUI(`🖱️ 桌面双击(视频中心)：x=${x}, y=${y} dpr=${p.point.dpr}`, 'info');
                    if (p.hit) {
                        const h = p.hit;
                        logToUI(
                            `🧭 命中检查(elementFromPoint)：${h.none ? 'none' : `${h.tag} aria=${h.ariaLabel || '-'} e2e=${h.dataE2e || '-'} id=${h.id || '-'}`}`,
                            'info'
                        );
                    }
                    logToUI('⚠️ 请确保浏览器窗口在前台且不要遮挡/不要移动鼠标', 'warn');
                }

                const r = await doNativeClick(x, y, 'like_video_dblclick', 18, 2, 55);
                if (typeof logToUI === 'function' && r) {
                    logToUI(
                        `🖱️ dblclick 返回：count=${r.count || 2} interval_ms=${r.interval_ms || 55} cursor_before=${r.cursor_before || 'null'} cursor_after=${r.cursor_after || 'null'}`,
                        'info'
                    );
                }

                // 给 UI 一点时间更新，再验证（避免太快导致误判触发按钮兜底）
                await new Promise((r3) => setTimeout(r3, 650));
                const v = await verifyLiked();
                if (v.pressed) {
                    if (typeof logToUI === 'function') logToUI('✅ 视频点赞：视频中心双击后已确认 aria-pressed=true', 'success');
                    return;
                }
                // 再等一小会儿复核一次
                await new Promise((r4) => setTimeout(r4, 500));
                const v2 = await verifyLiked();
                if (v2.pressed) {
                    if (typeof logToUI === 'function') logToUI('✅ 视频点赞：延迟复核后确认 aria-pressed=true', 'success');
                    return;
                }
                if (typeof logToUI === 'function') {
                    logToUI(`⚠️ 视频中心双击后仍未确认点赞(aria-pressed=${v2.s?.ariaPressed || ''})`, 'warn');
                }
            }
        } catch (e) {
            if (typeof logToUI === 'function') logToUI(`⚠️ 视频中心双击异常: ${e?.message || e}`, 'warn');
        }

        // 2) 兜底：如果无法获取视频中心（极少数页面结构），再用“按钮坐标单击”
        try {
            const pointRes2 = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: tk_getNativeClickPoint_for_like,
            });
            const p2 = pointRes2?.[0]?.result;
            if (p2?.ok && p2?.point?.screenDevice?.x != null && p2?.point?.screenDevice?.y != null) {
                const x2 = Number(p2.point.screenDevice.x);
                const y2 = Number(p2.point.screenDevice.y);
                if (typeof logToUI === 'function') {
                    logToUI(`🖱️ 兜底桌面单击(点赞按钮)：x=${x2}, y=${y2} dpr=${p2.point.dpr} sel=${p2.selector}`, 'info');
                }
                await doNativeClick(x2, y2, 'like_video_button_fallback', 40);
                await new Promise((r4) => setTimeout(r4, 450));
                const v2 = await verifyLiked();
                if (v2.pressed) {
                    if (typeof logToUI === 'function') logToUI('✅ 视频点赞：按钮兜底单击后已确认 aria-pressed=true', 'success');
                    return;
                }
                if (typeof logToUI === 'function') {
                    logToUI(`⚠️ 按钮兜底单击后仍未确认点赞(aria-pressed=${v2.s?.ariaPressed || ''})`, 'warn');
                }
            } else {
                if (typeof logToUI === 'function') logToUI('⚠️ 无法获取视频中心/按钮坐标，点赞失败', 'warn');
            }
        } catch (e) {
            if (typeof logToUI === 'function') logToUI(`⚠️ 点赞兜底异常: ${e?.message || e}`, 'warn');
        }

        return;
    }

    if (cmd.type === 'like_top_comment') {
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: likeTopCommentTikTokPage });
        const r = results?.[0]?.result;
        if (r?.ok) {
            if (typeof logToUI === 'function') {
                logToUI(
                    `✅ 高赞点赞完成：items=${r.commentItemsCount} pressed ${r.beforePressed}→${r.afterPressed} toggled=${r.toggled}`,
                    'success'
                );
            }
        } else {
            if (typeof logToUI === 'function') logToUI(`⚠️ 高赞点赞失败: ${r?.reason || 'unknown'}`, 'warn');
        }
        return;
    }

    if (cmd.type === 'like_comment') {
        const idxRaw = cmd.index ?? cmd.comment_index ?? cmd.commentIndex ?? 1;
        const idx = Math.max(1, Math.min(50, Number(idxRaw) || 1));
        const matchText = cmd.match_text || cmd.matchText || cmd.comment_text || cmd.text || '';

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: likeCommentMatchTikTokPage,
            args: [matchText, idx],
        });
        const r = results?.[0]?.result;
        if (r?.ok) {
            if (typeof logToUI === 'function') {
                logToUI(
                    `✅ 评论点赞完成：idx=${idx}${r?.matched ? ' (已匹配)' : ' (按序号)'} items=${r.commentItemsCount} pressed ${r.beforePressed}→${r.afterPressed} toggled=${r.toggled}`,
                    'success'
                );
            }
        } else {
            if (typeof logToUI === 'function') logToUI(`⚠️ 评论点赞失败：idx=${idx} reason=${r?.reason || 'unknown'}`, 'warn');
        }
        return;
    }

    if (cmd.type === 'subscribe' || cmd.type === 'subscribe_channel') {
        // TikTok 关注在某些场景会忽略合成事件；改用桌面层真实点击，且避免误点“see more”。
        const cfg = tk_getCfg();
        const port = cfg.PORT;

        const doNativeClick = async (x, y, why, pressMs = 18, count = 1, intervalMs = 55) => {
            const resp = await fetch(`http://localhost:${port}/native_click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x, y, press_ms: pressMs, count, interval_ms: intervalMs, platform: cfg.PLATFORM, why }),
            });
            if (!resp.ok) throw new Error(`/native_click ${resp.status} ${resp.statusText}`);
            try {
                return await resp.json();
            } catch {
                return null;
            }
        };

        const readFollow = async () => {
            const sRes = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: tk_readFollowState_simple,
            });
            return sRes?.[0]?.result;
        };

        // 0) 若已关注，直接返回
        try {
            const s0 = await readFollow();
            if (s0?.ok && s0.followed) {
                if (typeof logToUI === 'function') logToUI('✅ 关注：已关注(无需操作)', 'success');
                return;
            }
        } catch {
            // ignore
        }

        // 1) 获取关注按钮坐标
        try {
            const pointRes = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: tk_getNativeClickPoint_for_follow,
            });
            const p = pointRes?.[0]?.result;
            if (p?.ok && p?.point?.screenDevice?.x != null && p?.point?.screenDevice?.y != null) {
                const x = Number(p.point.screenDevice.x);
                const y = Number(p.point.screenDevice.y);
                if (typeof logToUI === 'function') {
                    logToUI(`🖱️ 桌面点击(关注)：x=${x}, y=${y} dpr=${p.point.dpr} sel=${p.selector || '-'}`, 'info');
                    if (p.hit) {
                        const h = p.hit;
                        logToUI(
                            `🧭 命中检查：${h.none ? 'none' : `${h.tag} aria=${h.ariaLabel || '-'} e2e=${h.dataE2e || '-'} id=${h.id || '-'}`}`,
                            'info'
                        );
                    }
                    if (p.beforeText || p.beforeLabel) {
                        logToUI(`🔎 目标文本/标签：text=${p.beforeText || '-'} label=${p.beforeLabel || '-'}`, 'info');
                    }
                    logToUI('⚠️ 请确保浏览器窗口在前台且不要遮挡/不要移动鼠标', 'warn');
                }

                await doNativeClick(x, y, 'subscribe_click', 18, 1, 55);
                await new Promise((r1) => setTimeout(r1, 650));

                const s1 = await readFollow().catch(() => null);
                if (s1?.ok && s1.followed) {
                    if (typeof logToUI === 'function') logToUI('✅ 关注：已确认关注成功', 'success');
                    return;
                }
            }
        } catch (e) {
            if (typeof logToUI === 'function') logToUI(`⚠️ 桌面关注点击异常: ${e?.message || String(e)}`, 'warn');
        }

        // 2) 兜底：走旧的 DOM click + hasDialog 检测
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: subscribe });
        const r = results?.[0]?.result;
        if (r?.ok) {
            if (r.skipped && r.alreadyFollowed) {
                if (typeof logToUI === 'function') logToUI('✅ 关注：已关注(跳过)', 'success');
            } else if (r.clicked) {
                if (typeof logToUI === 'function') logToUI('✅ 关注：已点击关注', 'success');
            } else {
                if (typeof logToUI === 'function') logToUI('✅ 关注：完成', 'success');
            }
        } else {
            if (typeof logToUI === 'function') logToUI(`⚠️ 关注失败: ${r?.reason || 'unknown'} ${r ? JSON.stringify(r) : ''}`, 'warn');
        }
        return;
    }

    if (cmd.type === 'auto_comment') {
        let text = cmd.text || '';
        if (!text) throw new Error('auto_comment 缺少 text');

        // 规范化：单行、去掉前缀 YES/NO、限制长度（保守 <=120，确保不超 150）
        try {
            text = String(text);
            text = text.replace(/\s+/g, ' ').trim();
            text = text.replace(/^\[?\s*(YES|NO)\s*\]?\s*/i, '').trim();
            if (text.length > 120) text = text.slice(0, 120).trimEnd();
        } catch {
            // ignore
        }

        if (!text) throw new Error('auto_comment 缺少 text');
        const cfg = tk_getCfg();
        const port = cfg.PORT;

        const doNativeClick = async (x, y, why, pressMs = 18, count = 1, intervalMs = 55) => {
            const resp = await fetch(`http://localhost:${port}/native_click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x, y, press_ms: pressMs, count, interval_ms: intervalMs, platform: cfg.PLATFORM, why }),
            });
            if (!resp.ok) throw new Error(`/native_click ${resp.status} ${resp.statusText}`);
            try {
                return await resp.json();
            } catch {
                return null;
            }
        };

        const doNativeType = async (t, intervalMs = 0) => {
            const resp = await fetch(`http://localhost:${port}/native_type`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: String(t || ''), interval_ms: intervalMs, platform: cfg.PLATFORM, why: 'auto_comment_type' }),
            });
            if (!resp.ok) throw new Error(`/native_type ${resp.status} ${resp.statusText}`);
            try {
                return await resp.json();
            } catch {
                return null;
            }
        };

        const doNativeEnter = async () => {
            const resp = await fetch(`http://localhost:${port}/native_key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'enter', count: 1, press_ms: 18, interval_ms: 35, platform: cfg.PLATFORM, why: 'auto_comment_enter' }),
            });
            if (!resp.ok) throw new Error(`/native_key ${resp.status} ${resp.statusText}`);
            try {
                return await resp.json();
            } catch {
                return null;
            }
        };

        if (typeof logToUI === 'function') {
            logToUI('💬 自动评论：桌面点击输入框 → 桌面键入 → Enter 发送', 'info');
            logToUI('⚠️ 请确保浏览器窗口在前台且不要遮挡/不要移动鼠标', 'warn');
        }

        // 1) 找输入框坐标（函数内部会尝试打开评论区）
        const pointRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_getNativeClickPoint_for_comment_input,
        });
        const p = pointRes?.[0]?.result;
        if (!p?.ok || !p?.point?.screenDevice) {
            if (typeof logToUI === 'function') logToUI(`📝 评论坐标获取失败: ${p?.reason || 'unknown'}`, 'warn');
            // 兜底：旧逻辑
            const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: postCommentTikTok, args: [text] });
            const r0 = results?.[0]?.result;
            if (r0?.success) {
                if (typeof logToUI === 'function') logToUI('📝 评论已发送(兜底DOM路径)', 'success');
            } else {
                if (typeof logToUI === 'function') logToUI(`📝 评论未发送: ${r0?.msg || 'unknown'}`, 'warn');
            }
            return;
        }

        const x = Number(p.point.screenDevice.x);
        const y = Number(p.point.screenDevice.y);
        if (typeof logToUI === 'function' && p.hit) {
            const h = p.hit;
            logToUI(
                `🧭 命中检查：${h.none ? 'none' : `${h.tag} aria=${h.ariaLabel || '-'} e2e=${h.dataE2e || '-'} id=${h.id || '-'}`}`,
                'info'
            );
        }

        // 2) 桌面点击聚焦输入框
        await doNativeClick(x, y, 'auto_comment_focus', 18, 1, 55);
        await new Promise((r1) => setTimeout(r1, 180));

        // 3) 桌面键入
        await doNativeType(text, 0);
        await new Promise((r2) => setTimeout(r2, 120));

        // 4) Enter 发送
        await doNativeEnter();
        await new Promise((r3) => setTimeout(r3, 650));

        // 5) 验证是否已发送：优先检测 toast（Comment posted），其次检测输入框清空
        const toast1 = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_detectCommentPostedToast,
        });
        const t1 = toast1?.[0]?.result;
        if (t1?.ok && t1.found) {
            if (typeof logToUI === 'function') logToUI(`📝 评论已发送(Enter，toast=${t1.text || 'found'})`, 'success');
            return;
        }

        const check1 = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_readCommentEditorText,
        });
        const c1 = check1?.[0]?.result;
        if (c1?.ok && c1.empty) {
            if (typeof logToUI === 'function') logToUI('📝 评论已发送(Enter，输入框已清空)', 'success');
            return;
        }

        // 给 UI 再一点时间：避免 Enter 已成功但 toast/输入框状态延迟导致误触发 Post 兜底
        await new Promise((r3b) => setTimeout(r3b, 850));
        const toast1b = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_detectCommentPostedToast,
        });
        const t1b = toast1b?.[0]?.result;
        if (t1b?.ok && t1b.found) {
            if (typeof logToUI === 'function') logToUI(`📝 评论已发送(Enter，toast=${t1b.text || 'found'})`, 'success');
            return;
        }

        const check1b = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_readCommentEditorText,
        });
        const c1b = check1b?.[0]?.result;
        if (c1b?.ok && c1b.empty) {
            if (typeof logToUI === 'function') logToUI('📝 评论已发送(Enter，输入框已清空)', 'success');
            return;
        }

        // 6) 兜底：点发送按钮（仅当 Enter 路径未观察到成功）
        const clickPost = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_clickCommentPostButton,
        });
        const cp = clickPost?.[0]?.result;
        await new Promise((r4) => setTimeout(r4, 650));

        const toast2 = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_detectCommentPostedToast,
        });
        const t2 = toast2?.[0]?.result;
        if (t2?.ok && t2.found) {
            if (typeof logToUI === 'function') logToUI(`📝 评论已发送(Post，toast=${t2.text || 'found'})`, 'success');
            return;
        }

        const check2 = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tk_readCommentEditorText,
        });
        const c2 = check2?.[0]?.result;
        if (c2?.ok && c2.empty) {
            if (typeof logToUI === 'function') logToUI('📝 评论已发送(点击Post，输入框已清空)', 'success');
            return;
        }

        if (typeof logToUI === 'function') {
            logToUI(`📝 评论可能未发送：post=${cp ? JSON.stringify(cp) : '-'} editor=${c2 ? JSON.stringify(c2) : '-'}`, 'warn');
        }
        return;
    }

    if (typeof logToUI === 'function') logToUI(`⚠️ 未实现指令: ${cmd.type}`, 'warn');
}

// 暴露到全局，供 popup.js / popup-ui.js 调用
try {
    window.tk_sendToPython = tk_sendToPython;
    window.tk_pollPythonCommands = tk_pollPythonCommands;
    window.tk_executeIncomingCommand = tk_executeIncomingCommand;
    window.tk_handleCommand = tk_handleCommand;
} catch {
    // ignore
}
