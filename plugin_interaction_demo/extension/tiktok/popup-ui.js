// UI 相关：只操作 popup.html 的 DOM，不做 executeScript 注入
// 约定：本文件通过 popup.html 在 popup.js 之前加载（全局函数）。

function logToUI(msg, type = 'info') {
    const container = document.getElementById('log-container');
    if (!container) return;

    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    div.style.borderBottom = '1px solid #333';
    div.style.paddingBottom = '2px';

    const time = new Date().toLocaleTimeString();
    let color = '#cccccc';
    let icon = 'ℹ️';
    if (type === 'error') {
        color = '#ff6b6b';
        icon = '❌';
    } else if (type === 'success') {
        color = '#69db7c';
        icon = '✅';
    } else if (type === 'warn') {
        color = '#ffd43b';
        icon = '⚠️';
    } else if (type === 'cmd') {
        color = '#4dabf7';
        icon = '🤖';
    }

    div.innerHTML = `<span style="color:rgba(255,255,255,0.78)">[${time}]</span> <span style="margin-right:4px">${icon}</span><span style="color:${color}">${msg}</span>`;
    container.prepend(div);
    container.scrollTop = 0;
}

function updateStatus(text, color = '#ddd') {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
}

function updateSendStatus(text, color = '#555') {
    const el = document.getElementById('send-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
}

function updateTitleUI(title) {
    const el = document.getElementById('video-title');
    if (!el) return;
    el.textContent = title || '等待检测视频...';
}

function updateTimeUI(currentSec, durationSec) {
    const el = document.getElementById('time-progress');
    if (!el) return;

    const fmt = (sec) => {
        const s = Math.max(0, Number(sec) || 0);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${String(r).padStart(2, '0')}`;
    };

    const loopEl = ` | 循环: ${currentLoopCount}`;
    el.textContent = `时间: ${fmt(currentSec)} / ${fmt(durationSec)}${loopEl}`;
}

function updateLoopCountForTime({ url, title, current, duration, videoKey, videoId }) {
    // 注意：TikTok ForYou/广告等场景 window.location.href 可能带 token 且会变化，
    // 若用 url|title 作为 key 会导致 loopState 反复重置、循环次数无法累加。
    const key = String(videoKey || videoId || url || '') || `${url || ''}|${title || ''}`;
    if (key !== loopState.key) {
        loopState = {
            key,
            lastCurrent: Number(current) || 0,
            lastDuration: Number(duration) || 0,
            lastTriggerAt: 0,
            triggerAttempts: 0,
            mutedUntil: 0,
        };
        currentLoopCount = 0;
        return;
    }

    const now = Date.now();
    const lastCurrent = Number(loopState.lastCurrent) || 0;
    const lastDuration = Number(loopState.lastDuration) || 0;
    const cur = Number(current) || 0;
    const dur = Number(duration) || 0;

    // “循环”判定：上一帧接近结束，下一帧回到开头（同一视频）
    // 允许 duration 轻微抖动，因此用 lastDuration 或 dur 中更大的那个做参考。
    const refDur = Math.max(lastDuration, dur);
    // “循环”判定：
    // - 常规：上一帧接近结束，下一帧回到开头（同一视频）
    // - 兜底：某些广告/直播/特殊视频 duration 读取为 0，但时间会回跳
    const wasNearEnd = refDur > 0 ? (lastCurrent >= Math.max(0, refDur - 2)) : (lastCurrent >= 8);
    const nowNearStart = cur <= 2;
    const timeJumpBack = lastCurrent > cur + 1;
    if (wasNearEnd && nowNearStart && timeJumpBack) {
            currentLoopCount += 1;

            // 循环次数达到阈值：强制下一个（避免网络问题导致一直播放）
            if (currentLoopCount >= LOOP_THRESHOLD) {
                // 熔断/限流：同一视频最多触发 3 次强制跳转；每次至少间隔 45s。
                if (now < (Number(loopState.mutedUntil) || 0)) {
                    // muted
                } else {
                    const lastTriggerAt = Number(loopState.lastTriggerAt) || 0;
                    const triggerAttempts = Number(loopState.triggerAttempts) || 0;

                    if (triggerAttempts >= 3) {
                        // 自动恢复升级：如果多次跳过仍失败，改用更“硬”的 next_video，最后尝试“刷新视频流”(双击左侧小房子/For You)。
                        // 为避免风暴：同一视频最多触发一次“刷新视频流”，且至少间隔 5 分钟。
                        loopState.lastTriggerAt = now;
                        loopState.triggerAttempts = triggerAttempts + 1;

                        logToUI('🧯 循环播放多次未跳走：升级为强制下一个/必要时刷新视频流(自动恢复)', 'warn');
                        currentLoopCount = 0;

                        setTimeout(() => {
                            try {
                                const payload = {
                                    type: 'next_video',
                                    reason: 'loop_threshold_reached_hard',
                                };
                                if (typeof tk_executeIncomingCommand !== 'undefined') {
                                    void tk_executeIncomingCommand(payload);
                                    // 再补一击，防止第一次滚动没生效
                                    setTimeout(() => {
                                        try { void tk_executeIncomingCommand(payload); } catch {}
                                    }, 1400);
                                } else if (typeof executeIncomingCommand !== 'undefined') {
                                    void executeIncomingCommand(payload);
                                    setTimeout(() => {
                                        try { void executeIncomingCommand(payload); } catch {}
                                    }, 1400);
                                }
                            } catch (e) {
                                console.warn('Hard next_video trigger failed:', e);
                            }

                            // 兜底：如果还卡死，尝试“刷新视频流”(不整页 reload，避免插件需要重载)
                            try {
                                const lastRefreshAt = Number(loopState.lastFeedRefreshAt) || 0;
                                if (now - lastRefreshAt < 5 * 60 * 1000) return;
                                loopState.lastFeedRefreshAt = now;

                                const payload2 = {
                                    type: 'refresh_video',
                                    reason: 'loop_threshold_reached_refresh_feed',
                                };
                                logToUI('🏠 自动恢复：双击左侧小房子/For You 刷新视频流', 'warn');
                                if (typeof tk_executeIncomingCommand !== 'undefined') {
                                    void tk_executeIncomingCommand(payload2);
                                } else if (typeof executeIncomingCommand !== 'undefined') {
                                    void executeIncomingCommand(payload2);
                                }
                            } catch {
                                // ignore
                            }
                        }, 120);
                    } else if (now - lastTriggerAt >= 45 * 1000) {
                        loopState.lastTriggerAt = now;
                        loopState.triggerAttempts = triggerAttempts + 1;
                        logToUI(
                            `🔄 检测到视频循环播放，触发强制跳转(第 ${loopState.triggerAttempts} 次)`,
                            'warn'
                        );

                        // 触发后重置计数，避免“循环 216 次”刷屏
                        currentLoopCount = 0;

                        // 异步触发，避免阻塞当前更新
                        setTimeout(() => {
                            try {
                                const payload = {
                                    type: 'monitor_next',
                                    reason: 'loop_threshold_reached',
                                    watchLimit: 1,
                                };
                                if (typeof tk_executeIncomingCommand !== 'undefined') {
                                    void tk_executeIncomingCommand(payload);
                                } else if (typeof executeIncomingCommand !== 'undefined') {
                                    // 兼容旧版本
                                    void executeIncomingCommand(payload);
                                }
                            } catch (e) {
                                console.warn('Loop threshold trigger failed:', e);
                            }
                        }, 120);
                    }
                }
            }
    }

    loopState.lastCurrent = cur;
    loopState.lastDuration = dur;
}
