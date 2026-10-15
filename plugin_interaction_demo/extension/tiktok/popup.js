// ===========================
// TikTok 智能助手 - Popup 主控 (MV3)
// 说明：
// - 注入端函数：popup-inject.js（executeScript 里运行，必须自包含）
// - 命令/队列/轮询：popup-commands.js（tk_* API）
// - UI 小工具：popup-ui.js
// 本文件只做 wiring：采集/过滤/触发 tk_*。
// ===========================

const __TK_CFG__ = (typeof window !== 'undefined' && window.__TK_CONFIG__) || {
    PORT: 8099,
    PLATFORM: 'tiktok',
    BUILD_ID: 'tiktok_popup_main_min_v1',
    LOOP_THRESHOLD: 5,
};

const PORT = __TK_CFG__.PORT;
const PLATFORM = __TK_CFG__.PLATFORM;
const BUILD_ID = __TK_CFG__.BUILD_ID;
const LOOP_THRESHOLD = __TK_CFG__.LOOP_THRESHOLD;

// 供 popup-ui.js 的 updateLoopCountForTime 使用（运行时引用，不要求提前声明）
let currentLoopCount = 0;
let loopState = {
    key: '',
    lastCurrent: 0,
    lastDuration: 0,
};

try {
    window.__TK_PLUGIN_BUILD__ = BUILD_ID;
    console.log(`[Plugin Build] ${BUILD_ID}`);
} catch {
    // ignore
}

function updateLatestCmdUI(cmd) {
    const box = document.getElementById('latest-cmd-box');
    const content = document.getElementById('latest-cmd-content');
    if (!box || !content) return;
    box.style.display = 'block';
    content.textContent = typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
}

function updateCommentsDisplay(comments) {
    const commentsBox = document.getElementById('comments-box');
    const commentsList = document.getElementById('comments-list');
    if (!commentsBox || !commentsList) return;

    if (!comments || comments.length === 0) {
        commentsBox.style.display = 'none';
        return;
    }

    commentsBox.style.display = 'block';
    commentsList.innerHTML = '';

    comments.forEach((comment) => {
        const item = document.createElement('div');
        item.className = 'comment-item';
        item.innerHTML = `
            <div>
                <span class="comment-author">${comment.author || '匿名'}</span>
                <span class="comment-likes">❤️ ${comment.likes || '0'}</span>
            </div>
            <div class="comment-text">${comment.content || ''}</div>
        `;
        commentsList.appendChild(item);
    });
}

function setElementStatus(id, ok) {
    const el = document.getElementById(id);
    if (!el) return;

    el.classList.remove('status-ok', 'status-fail', 'status-unknown');
    if (ok === true) {
        el.textContent = 'OK';
        el.classList.add('status-ok');
    } else if (ok === false) {
        el.textContent = 'NO';
        el.classList.add('status-fail');
    } else {
        el.textContent = '-';
        el.classList.add('status-unknown');
    }
}

async function getCurrentTab() {
    const urlParams = new URLSearchParams(window.location.search);
    const targetWindowId = urlParams.get('targetWindowId');

    const isInjectableUrl = (u) => {
        if (!u || typeof u !== 'string') return false;
        const lower = u.toLowerCase();
        if (lower.startsWith('chrome://')) return false;
        if (lower.startsWith('edge://')) return false;
        if (lower.startsWith('devtools://')) return false;
        if (lower.startsWith('chrome-extension://')) return false;
        return lower.startsWith('http://') || lower.startsWith('https://');
    };

    const isTikTokUrl = (u) => {
        try {
            return isInjectableUrl(u) && String(u).toLowerCase().includes('tiktok.com');
        } catch {
            return false;
        }
    };

    const query = targetWindowId
        ? { active: true, windowId: Number.parseInt(targetWindowId, 10) }
        : { active: true, currentWindow: true };

    const tabs = await chrome.tabs.query(query);
    return tabs.find((t) => isTikTokUrl(t?.url || t?.pendingUrl)) || tabs[0];
}

function _tk_parseCountToIntForFilter(value) {
    const s = String(value || '').trim();
    if (!s) return 0;

    // 兼容 1.2K / 3.4M / 1万 / 2.3万
    const lower = s.toLowerCase().replace(/,/g, '');
    const m = lower.match(/^([0-9]+(?:\.[0-9]+)?)(k|m|b|万)?$/);
    if (m) {
        const num = Number(m[1]) || 0;
        const unit = m[2];
        if (unit === 'k') return Math.round(num * 1_000);
        if (unit === 'm') return Math.round(num * 1_000_000);
        if (unit === 'b') return Math.round(num * 1_000_000_000);
        if (unit === '万') return Math.round(num * 10_000);
        return Math.round(num);
    }

    const onlyDigits = lower.replace(/[^0-9]/g, '');
    return Number(onlyDigits) || 0;
}

/**
 * TikTok 视频质量筛选（参照 YouTube 逻辑）
 * 客户端图二的"已到底:点赞偏好"逻辑移到插件端，不符合条件不发送给客户端
 * @returns {{ reason: string, watchLimit: number, shouldSendToAI: boolean } | null}
 */
function _tk_filterLowQualityVideoForAuto(extraData) {
    const likeRaw = extraData?.like_count;
    const commentRaw = extraData?.comment_count;
    const likeCount = _tk_parseCountToIntForFilter(likeRaw);
    const commentCount = _tk_parseCountToIntForFilter(commentRaw);
    const duration = Number(extraData?.duration || 0);

    // 规则 -1：广告/赞助内容直接跳过（避免 Sponsored 视频循环或干扰采集）
    if (extraData?.is_sponsored) {
        return { reason: '广告/赞助(Sponsored)', watchLimit: 1, shouldSendToAI: false };
    }

    // 检查是否是大数字（带单位 K/M/万，或小数点表示缩写）
    const isLargeNumber = (str) => {
        if (!str) return false;
        const s = String(str).toUpperCase();
        if (s.includes('K') || s.includes('M') || s.includes('B') || s.includes('万')) return true;
        if (s.includes('.')) return true; // 如 1.2 表示 1.2K
        return false;
    };

    const isHighLikes = isLargeNumber(likeRaw) || likeCount >= 1000;
    const isHighComments = isLargeNumber(commentRaw) || commentCount >= 50;

    // 规则 0：时长过短（<10秒）直接跳过
    if (duration > 0 && duration < 10) {
        return { reason: '时长过短(<10s)', watchLimit: 1, shouldSendToAI: false };
    }

    // 规则 1：极低质量（点赞<10 或 评论<5）立即跳过 1-3秒
    if (!isHighLikes && likeCount < 10) {
        const randomWait = Math.floor(Math.random() * 3) + 1;
        return { reason: `点赞极少(${likeCount}<10)`, watchLimit: randomWait, shouldSendToAI: false };
    }
    if (!isHighComments && commentCount < 5) {
        const randomWait = Math.floor(Math.random() * 3) + 1;
        return { reason: `评论极少(${commentCount}<5)`, watchLimit: randomWait, shouldSendToAI: false };
    }

    // 规则 2：中等热度（10 <= 点赞 < 500）看10秒，不发AI
    if (!isHighLikes && likeCount < 500) {
        return { reason: `中等热度(赞${likeCount})`, watchLimit: 10, shouldSendToAI: false };
    }

    // 规则 3：良好热度（500 <= 点赞 < 1000）看30秒，不发AI
    if (!isHighLikes && likeCount < 1000) {
        return { reason: `良好热度(赞${likeCount})`, watchLimit: 30, shouldSendToAI: false };
    }

    // 规则 4：高赞低评（点赞>=1000 但 评论<50）看完但不发AI
    if (isHighLikes && !isHighComments) {
        // 用视频时长作为 watchLimit（避免固定 3600s 导致“播完不跳→进入第二轮循环”）
        const limit = duration > 0 ? duration : 30;
        const capped = Math.max(5, Math.min(limit, 120));
        return { reason: `高赞低评(赞${likeRaw},评${commentCount})`, watchLimit: capped, shouldSendToAI: false };
    }

    // 规则 5：高赞高评（点赞>=1000 且 评论>=50）发送给AI处理
    // 返回 null 表示不过滤，继续发送给客户端
    return null;
}

let lastAutoKey = '';
let lastCaptureSig = '';
let lastCaptureTs = 0;
let lastSentVideoKey = ''; // 记录已上报的视频，避免重复上报
let lastSentStableVideoKey = ''; // 稳定 key（video:id 或 url+title+dur），用于更可靠的去重
let lastObservedVideoKey = '';
let lastSentVideoAt = 0;
let _tk_lastSendErrorAt = 0;
let _tk_lastSendErrorSig = '';
let _tk_openCommentsAttemptKey = '';
let _tk_openCommentsAttemptAt = 0;
let _tk_retryInProgress = false; // 重试中标志，防止定时器干扰
// 防卡死：当我们已经决定“跳过该视频”并正在等待页面点击下一个时，暂停采集/打开评论区等动作
let _tk_skipInProgressKey = '';
let _tk_skipInProgressAt = 0;
let _tk_skipInProgressUntil = 0;
// 每个视频最多尝试打开评论区的次数（避免广告/禁评导致无限循环）
const _tk_openCommentsAttemptCountByKey = new Map();

async function updateTitleAndMaybeSend() {
    try {
        const tab = await getCurrentTab();
        if (!tab?.id) return;
        const tabUrl = String(tab.url || tab.pendingUrl || '');
        if (!tabUrl.includes('tiktok.com')) return;

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractTargetText,
        });

        const r = results?.[0]?.result;
        const title = r?.title || '等待检测视频...';
        const current = r?.current || 0;
        const duration = r?.duration || 0;
        const href = r?.href || '';
        const vid = r?.videoId || '';

        // 生成稳定 key：优先 videoId，否则用 cleanHref + title + duration（避免 token 抖动）
        const stableKey = (() => {
            try {
                const v = String(vid || '').trim();
                if (v) return `video:${v}`;
            } catch {}
            try {
                const clean = String(href || tabUrl || '').split('#')[0].split('?')[0];
                if (clean) return `url:${clean}|${title || ''}|d:${Number(duration) || 0}`;
            } catch {}
            return '';
        })();

        updateLoopCountForTime({ url: tabUrl, title, current, duration, videoKey: stableKey, videoId: vid });
        updateTitleUI(title);
        updateTimeUI(current, duration);

        const key = `${tabUrl || ''}|${title}`;
        if (!tabUrl || key === lastAutoKey) return;
        lastAutoKey = key;
    } catch {
        // ignore
    }
}

// 直接在插件端监控并跳过视频（和 YouTube 一样）
function startMonitorAndSkip(tabId, reason, watchLimit = 5) {
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (skipReason, limit) => {
            console.log(`[TikTok Plugin] 启动监控跳过 (原因: ${skipReason}, 限时: ${limit}s)...`);

            // 只允许一个监控器运行，避免重复 setInterval 导致“第二次循环/刷屏”
            try {
                const prev = window.__TK_SKIP_MONITOR__;
                if (prev && prev.intervalId) {
                    clearInterval(prev.intervalId);
                }
            } catch {
                // ignore
            }
            
            const showStatus = (text, color = '#4caf50') => {
                let el = document.getElementById('plugin-monitor-status');
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'plugin-monitor-status';
                    el.style.position = 'fixed';
                    el.style.top = '80px';
                    el.style.left = '50%';
                    el.style.transform = 'translateX(-50%)';
                    el.style.padding = '10px 20px';
                    el.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
                    el.style.color = 'white';
                    el.style.borderRadius = '25px';
                    el.style.zIndex = '99999';
                    el.style.fontSize = '14px';
                    el.style.fontWeight = 'bold';
                    el.style.pointerEvents = 'none';
                    el.style.transition = 'opacity 0.3s';
                    el.style.boxShadow = '0 3px 10px rgba(0,0,0,0.4)';
                    document.body.appendChild(el);
                }
                el.textContent = text;
                el.style.color = color;
                el.style.opacity = '1';
            };
            
            let statusText = `⌛ 自动观看 ${limit}秒...`;
            let statusColor = '#4dabf7';
            
            if (skipReason === 'suspected_ad_or_live') {
                statusText = '🚫 疑似广告/直播，即将跳过...';
                statusColor = '#ff922b';
            } else if (skipReason.startsWith('filtered:')) {
                const filterDetail = skipReason.replace('filtered:', '');
                statusText = `🚫 已过滤: ${filterDetail}`;
                statusColor = '#ff6b6b';
            }
            
            showStatus(statusText, statusColor);

            const pickBestVideo = () => {
                const videos = Array.from(document.querySelectorAll('video'));
                let best = null;
                let bestScore = -1;
                for (const v of videos) {
                    const rect = v.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    const vw = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
                    const vh = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
                    const area = Math.max(0, vw) * Math.max(0, vh);
                    let score = area;
                    try { if (!v.paused) score *= 1.5; } catch { }
                    if (score > bestScore) {
                        bestScore = score;
                        best = v;
                    }
                }
                return best;
            };

            // 如果用户手动切换到新视频，必须立刻取消当前监控并隐藏提示，避免“已过滤”卡在旧视频上
            const getVideoSig = () => {
                try {
                    const v = pickBestVideo();
                    if (!v) return '';
                    const src = String(v.currentSrc || v.src || '').trim();
                    if (src) return src;
                    // 兜底：用 DOM 标题文本（不一定稳定，但比没有强）
                    const t = String(
                        document.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"], h1, h2')
                            ?.innerText ||
                            ''
                    ).trim();
                    return t;
                } catch {
                    return '';
                }
            };

            const initialSig = getVideoSig();

            const tryNext = () => {
                const isAdLike = (() => {
                    const s = String(skipReason || '').toLowerCase();
                    return s === 'suspected_ad_or_live' || s.includes('sponsored') || s.includes('广告') || s.includes('赞助') || s.includes('推广');
                })();

                const getActiveVideo = () => {
                    const videos = Array.from(document.querySelectorAll('video'));
                    let bestVideo = null;
                    let maxScore = -1;
                    for (const v of videos) {
                        const rect = v.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
                        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
                        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
                        let score = visibleArea;
                        try { if (!v.paused) score *= 1.5; } catch { }
                        if (score > maxScore) {
                            maxScore = score;
                            bestVideo = v;
                        }
                    }
                    return bestVideo;
                };

                const findListRoot = (currentItem, selector) => {
                    let node = currentItem?.parentElement || null;
                    for (let i = 0; i < 12 && node; i += 1) {
                        const cnt = node.querySelectorAll(selector).length;
                        if (cnt >= 2) return node;
                        node = node.parentElement;
                    }
                    return currentItem?.parentElement || document.body;
                };

                const findScrollableAncestor = (startEl) => {
                    let node = startEl;
                    for (let i = 0; i < 18 && node; i += 1) {
                        const style = window.getComputedStyle(node);
                        const overflowY = style?.overflowY;
                        const canScroll = (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 50;
                        if (canScroll) return node;
                        node = node.parentElement;
                    }
                    return document.scrollingElement || document.documentElement || document.body;
                };

                const tryFocus = () => {
                    try { document.body?.focus?.(); } catch { }
                    return true;
                };

                const dispatchKey = (key) => {
                    try {
                        const evtDown = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
                        const evtUp = new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true });
                        document.dispatchEvent(evtDown);
                        window.dispatchEvent(evtDown);
                        document.dispatchEvent(evtUp);
                        window.dispatchEvent(evtUp);
                    } catch {
                        // ignore
                    }
                };

                const tryScrollToNextItem = () => {
                    const activeVideo = getActiveVideo();
                    if (!activeVideo) return false;

                    const itemSelector = '[data-e2e="recommend-list-item-container"]';
                    const currentItem = activeVideo.closest(itemSelector);
                    if (!currentItem) return false;

                    const listRoot = findListRoot(currentItem, itemSelector);
                    const items = Array.from(listRoot.querySelectorAll(itemSelector));
                    const idx = items.indexOf(currentItem);
                    if (idx >= 0 && idx < items.length - 1) {
                        const nextItem = items[idx + 1];
                        try {
                            nextItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        } catch {
                            // ignore
                        }
                        return true;
                    }

                    const scroller = findScrollableAncestor(currentItem);
                    const before = scroller?.scrollTop ?? 0;
                    const delta = Math.max(450, Math.floor(window.innerHeight * 0.95));
                    try {
                        scroller.scrollBy({ top: delta, left: 0, behavior: 'smooth' });
                    } catch {
                        try { scroller.scrollTop = before + delta; } catch { }
                    }
                    return (scroller?.scrollTop ?? 0) !== before;
                };

                const tryScroll = () => {
                    const scroller = document.scrollingElement || document.documentElement || document.body;
                    const before = scroller ? scroller.scrollTop : window.scrollY;
                    const delta = Math.max(450, Math.floor(window.innerHeight * 0.95));
                    try {
                        window.scrollBy({ top: delta, left: 0, behavior: 'smooth' });
                    } catch {
                        window.scrollBy(0, delta);
                    }

                    try {
                        const wheel = new WheelEvent('wheel', { deltaY: delta, bubbles: true, cancelable: true });
                        document.dispatchEvent(wheel);
                        window.dispatchEvent(wheel);
                    } catch {
                        // ignore
                    }

                    const after = scroller ? scroller.scrollTop : window.scrollY;
                    return after !== before;
                };

                // 广告/赞助/直播：尽量“单步”跳，避免一次触发滚动过头连续跳多个
                if (isAdLike) {
                    const byItem = tryScrollToNextItem();
                    if (!byItem) {
                        tryFocus();
                        dispatchKey('ArrowDown');
                    }
                    return Boolean(byItem);
                }

                const focused = tryFocus();
                const byItem = tryScrollToNextItem();
                dispatchKey('ArrowDown');
                dispatchKey('PageDown');
                const scrolled = tryScroll();
                return Boolean(byItem || scrolled || focused);
            };

            const startTime = Date.now();
            const intervalId = setInterval(() => {
                // 1) 手动/外部切换：立即取消
                try {
                    const curSig = getVideoSig();
                    if (initialSig && curSig && curSig !== initialSig) {
                        clearInterval(intervalId);
                        const statusEl = document.getElementById('plugin-monitor-status');
                        if (statusEl) statusEl.style.opacity = '0';
                        try { window.__TK_SKIP_MONITOR__ = null; } catch {}
                        return;
                    }
                } catch {
                    // ignore
                }

                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const remaining = Math.max(0, Math.floor(limit) - elapsed);

                // 如果视频已经结束（播完），直接切下一个（不等满 limit）
                let ended = false;
                try {
                    const v = pickBestVideo();
                    if (v && Number.isFinite(v.duration) && v.duration > 0) {
                        const cur = Number(v.currentTime || 0);
                        const dur = Number(v.duration || 0);
                        if (cur >= dur - 0.25) ended = true;
                    }
                } catch {
                    // ignore
                }

                if (!ended && remaining > 0) {
                    showStatus(`${statusText.split('...')[0]}... (剩余${remaining}秒)`, statusColor);
                    return;
                }

                clearInterval(intervalId);
                showStatus('⌛ 正在跳转下一个视频...', '#69db7c');
                setTimeout(() => {
                    // 多试几次，避免 TikTok 吞掉一次滚动
                    const isAdLike = (() => {
                        const s = String(skipReason || '').toLowerCase();
                        return s === 'suspected_ad_or_live' || s.includes('sponsored') || s.includes('广告') || s.includes('赞助') || s.includes('推广');
                    })();
                    const maxAttempts = isAdLike ? 2 : 5;
                    let attempts = 0;
                    const step = () => {
                        attempts += 1;
                        const ok = tryNext();
                        if (attempts < maxAttempts) {
                            setTimeout(step, ok ? 420 : 520);
                        } else {
                            const statusEl = document.getElementById('plugin-monitor-status');
                            if (statusEl) statusEl.style.opacity = '0';
                        }
                    };
                    step();
                }, 250);
            }, 500);

            try {
                window.__TK_SKIP_MONITOR__ = { intervalId, at: Date.now(), reason: skipReason, limit };
            } catch {
                // ignore
            }
        },
        args: [reason, watchLimit]
    }).catch(err => {
        console.warn('[TikTok] startMonitorAndSkip 执行失败:', err);
    });
}

async function autoCaptureLight(retryCount = 0) {
    // 如果正在重试中且是定时器调用（retryCount=0），则跳过
    if (_tk_retryInProgress && retryCount === 0) {
        return;
    }
    
    const isLastTry = retryCount >= 2;
    let tab;
    try {
        tab = await getCurrentTab();
    } catch {
        return;
    }
    if (!tab?.id) return;

    const tabUrl = (() => {
        try {
            return String(tab.url || tab.pendingUrl || '');
        } catch {
            return '';
        }
    })();
    if (!tabUrl.includes('tiktok.com')) return;

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: getLightPageData,
        });
        const data = results?.[0]?.result;
        if (!data) return;

        // 检测视频切换：如果URL或标题变了，清空已上报标记
        // TikTok 在“Following/ForYou”页签时，tab.url 可能是 /following；必须用页面内的 window.location.href
        const pageUrl = (() => {
            try {
                return String(data.url || '');
            } catch {
                return '';
            }
        })();
        const effectiveUrl = pageUrl || tabUrl;
        data.tab_url = tabUrl;
        data.url = effectiveUrl;

        const extractVideoId = (u) => {
            try {
                const m = String(u || '').match(/\/video\/(\d+)/);
                return m ? m[1] : '';
            } catch {
                return '';
            }
        };

        const videoId = extractVideoId(effectiveUrl);
        try {
            window.__TK_CURRENT_VIDEO_ID__ = videoId || '';
            window.__TK_CURRENT_VIDEO_URL__ = effectiveUrl || '';
        } catch {
            // ignore
        }

        // ===== 阶段 A.3：使用统一的稳定 videoKey 提取（与 popup-inject.js 一致）=====
        const extractStableVideoKey = (url) => {
            // 策略 1：优先从 URL 提取视频 ID
            try {
                const match = String(url || '').match(/\/video\/(\d+)/);
                if (match && match[1]) {
                    const vid = match[1].trim();
                    if (vid) return `video:${vid}`;
                }
            } catch { }
            
            // 策略 2：兜底使用 URL（去除 query 和 hash）
            try {
                const cleanUrl = String(url || '').split('#')[0].split('?')[0];
                if (cleanUrl && cleanUrl.length > 10) {
                    // 如果是 feed/foryou/following 这类 URL 可能不含视频 id，则拼上标题/时长保证“新视频可检测”
                    if (/\/(foryou|following|friends|explore)\b/i.test(cleanUrl)) {
                        const d = Number(data.extra_data?.duration || 0);
                        return `url:${cleanUrl}|${data.title || ''}|d:${d || 0}`;
                    }
                    return `url:${cleanUrl}`;
                }
            } catch { }
            
            // 最后：使用带标题的组合 key
            return `${url || ''}|${data.title || ''}`;
        };
        const currentVideoKey = extractStableVideoKey(effectiveUrl);

        // 检测视频切换：新视频出现时重置采集签名/重试标志
        if (currentVideoKey && currentVideoKey !== lastObservedVideoKey) {
            console.log(`[TikTok自动采集] 检测到新视频: ${currentVideoKey}`);
            lastObservedVideoKey = currentVideoKey;
            lastCaptureSig = '';
            _tk_retryInProgress = false;
            _tk_openCommentsAttemptKey = '';
            _tk_openCommentsAttemptAt = 0;
            _tk_openCommentsAttemptCountByKey.clear();
            _tk_skipInProgressKey = '';
            _tk_skipInProgressAt = 0;
        }

        const current = data.extra_data?.current_time || 0;
        const duration = data.extra_data?.duration || 0;
        updateLoopCountForTime({ url: data.url, title: data.title, current, duration, videoKey: currentVideoKey, videoId: videoId });

        updateTitleUI(data.title);
        updateTimeUI(current, duration);
        updateCommentsDisplay(data.extra_data?.comments || []);

        // 如果正在对当前视频执行“跳过”（等待点击下一个），暂停采集避免重复开评论/重复过滤刷屏
        if (retryCount === 0 && currentVideoKey && currentVideoKey === _tk_skipInProgressKey) {
            const age = Date.now() - (_tk_skipInProgressAt || 0);
            // 在“跳过窗口”内完全静默；超过窗口再允许采集继续（以防跳过失败需要再次触发）
            if (_tk_skipInProgressUntil && Date.now() < _tk_skipInProgressUntil) return;
            // 兼容旧逻辑兜底：至少 8 秒
            if (age < 8000) return;
        }

        // 按照 YouTube 方式：采集时无评论 → 打开 → 等待 → 重新采集
        const commentsArr = Array.isArray(data.extra_data?.comments) ? data.extra_data.comments : [];
        const commentCount = _tk_parseCountToIntForFilter(data.extra_data?.comment_count);
        const likeCount = _tk_parseCountToIntForFilter(data.extra_data?.like_count);
        const dur = Number(data.extra_data?.duration || 0);
        // 改进判断：如果评论数>0但提取不到评论，说明评论区可能没打开
        const noCommentsNow = commentsArr.length === 0 && commentCount === 0;
        const hasCountButNoComments = commentCount > 0 && commentsArr.length === 0;

        console.log(`[TikTok自动采集] retryCount=${retryCount}, noCommentsNow=${noCommentsNow}, hasCountButNoComments=${hasCountButNoComments}, isLastTry=${isLastTry}, commentsArr.length=${commentsArr.length}, commentCount=${commentCount}`);

        // 先做低质量过滤（尤其是低赞无评论的“广告/禁评”）：不要去打开评论区，直接跳过
        const filterHitEarly = _tk_filterLowQualityVideoForAuto(data.extra_data);
        if (filterHitEarly && (filterHitEarly.reason === 'low_like_no_comment' || filterHitEarly.reason === 'no_like_no_comment' || filterHitEarly.reason === 'duration_too_short')) {
            logToUI(`🚫 已过滤: ${filterHitEarly.reason} (👍${likeCount}, 💬${commentCount})`, 'warn');
            _tk_skipInProgressKey = currentVideoKey;
            _tk_skipInProgressAt = Date.now();
            _tk_skipInProgressUntil = Date.now() + Math.max(8, Math.min(filterHitEarly.watchLimit || 5, 120)) * 1000 + 1500;
            startMonitorAndSkip(tab.id, `filtered:${filterHitEarly.reason}`, filterHitEarly.watchLimit);
            return;
        }

        if ((noCommentsNow || hasCountButNoComments) && !isLastTry) {
            // 第一次采集无评论：尝试打开评论区
            if (retryCount === 0) {
                // 用稳定的 currentVideoKey 作为 key，避免 URL/title 抖动导致反复尝试
                const key = currentVideoKey || `${data.url || ''}|${data.title || ''}`;
                const now0 = Date.now();
                const shouldAttempt = key !== _tk_openCommentsAttemptKey || (now0 - (_tk_openCommentsAttemptAt || 0)) > 8000;

                const attemptCount = _tk_openCommentsAttemptCountByKey.get(key) || 0;
                // 每个视频最多尝试打开评论区 2 次；超过次数就不再开，直接走重试/过滤/继续处理逻辑
                const attemptAllowed = attemptCount < 2;
                
                console.log(`[TikTok自动打开评论] shouldAttempt=${shouldAttempt}, key=${key}, lastKey=${_tk_openCommentsAttemptKey}`);
                
                if (shouldAttempt && attemptAllowed) {
                    _tk_openCommentsAttemptKey = key;
                    _tk_openCommentsAttemptAt = now0;
                    _tk_openCommentsAttemptCountByKey.set(key, attemptCount + 1);
                    logToUI('🔍 检测到无评论，尝试打开评论区...', 'info');
                    
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: function openComments() {
                                const isVisible = (el) => {
                                    if (!el) return false;
                                    const rect = el.getBoundingClientRect();
                                    return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
                                };

                                // 使用和 likeTopComment 相同的强力点击方法
                                const clickAtCenter = (el) => {
                                    if (!el) return { ok: false };
                                    const rect = el.getBoundingClientRect();
                                    const x = Math.floor(rect.left + rect.width / 2);
                                    const y = Math.floor(rect.top + rect.height / 2);
                                    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
                                    if (rect.width <= 0 || rect.height <= 0) return { ok: false };

                                    const target = document.elementFromPoint(x, y) || el;
                                    const common = {
                                        bubbles: true,
                                        cancelable: true,
                                        composed: true,
                                        clientX: x,
                                        clientY: y,
                                        screenX: x,
                                        screenY: y,
                                        button: 0,
                                        buttons: 1,
                                    };

                                    const fire = (type, Ctor, extra = {}) => {
                                        try {
                                            target.dispatchEvent(new Ctor(type, { ...common, ...extra }));
                                            return true;
                                        } catch {
                                            return false;
                                        }
                                    };

                                    fire('pointermove', PointerEvent, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
                                    fire('mousemove', MouseEvent);
                                    fire('pointerdown', PointerEvent, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
                                    fire('mousedown', MouseEvent);
                                    fire('pointerup', PointerEvent, { pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 });
                                    fire('mouseup', MouseEvent, { buttons: 0 });
                                    fire('click', MouseEvent, { buttons: 0, detail: 1 });

                                    try { el.click(); } catch { /* ignore */ }

                                    return { ok: true };
                                };

                                // 使用和 likeTopComment 相同的选择器顺序
                                const commentBtnSelectors = [
                                    '[data-e2e="feed-comment-icon"]',
                                    '[data-e2e="comment-icon"]',
                                    '[data-e2e="comment-button"]',
                                    'button[aria-label*="comment" i]',
                                    'button[aria-label*="评论" i]',
                                ];
                                
                                for (const sel of commentBtnSelectors) {
                                    const btn = Array.from(document.querySelectorAll(sel)).find(isVisible);
                                    if (btn) {
                                        console.log(`[TikTok打开评论] 找到按钮: ${sel}`);
                                        const result = clickAtCenter(btn);
                                        if (result.ok) {
                                            console.log('[TikTok打开评论] 点击成功');
                                            return { ok: true, selector: sel };
                                        }
                                    }
                                }

                                console.log('[TikTok打开评论] 未找到可见的评论按钮');
                                return { ok: false };
                            },
                        });
                    } catch (e) {
                        console.warn('尝试打开评论区失败:', e);
                    }
                }
            }
            
            // 标记重试中，等待 1000ms 后重新采集（TikTok评论区DOM加载较慢）
            console.log(`[TikTok自动采集] 将在1000ms后重试，retryCount将变为 ${retryCount + 1}`);
            _tk_retryInProgress = true;
            setTimeout(() => autoCaptureLight(retryCount + 1), 1000);
            return;
        }

        // 重试后仍无评论：判断是否过滤/跳过
        if (isLastTry && (noCommentsNow || hasCountButNoComments)) {
            _tk_retryInProgress = false; // 清除重试标志
            
            // 如果时长/点赞异常：疑似广告/直播，直接跳过
            if (dur <= 0 || likeCount <= 0) {
                logToUI('🚫 疑似广告/直播/评论不可用：跳过该视频', 'warn');
                _tk_skipInProgressKey = currentVideoKey;
                _tk_skipInProgressAt = Date.now();
                _tk_skipInProgressUntil = Date.now() + 3000;
                startMonitorAndSkip(tab.id, 'suspected_ad_or_live', 1);
                return;
            }
            // 否则：正常视频只是没评论，继续处理
            logToUI('ℹ️ 视频无评论但指标正常，继续处理', 'info');
        }

        // 低质量过滤（命中则不上传 Python，插件端直接跳过）
        const filterHit = _tk_filterLowQualityVideoForAuto(data.extra_data);
        if (filterHit) {
            const likeCount = _tk_parseCountToIntForFilter(data.extra_data?.like_count);
            const commentCount = _tk_parseCountToIntForFilter(data.extra_data?.comment_count);
            logToUI(`🚫 已过滤: ${filterHit.reason} (👍${likeCount}, 💬${commentCount})`, 'warn');
            _tk_skipInProgressKey = currentVideoKey;
            _tk_skipInProgressAt = Date.now();
            _tk_skipInProgressUntil = Date.now() + Math.max(8, Math.min(filterHit.watchLimit || 5, 120)) * 1000 + 1500;
            startMonitorAndSkip(tab.id, `filtered:${filterHit.reason}`, filterHit.watchLimit);
            return;
        }

        // 去重上报：有变化才发，另给 10s 保底
        const comments = Array.isArray(data.extra_data?.comments) ? data.extra_data.comments : [];
        const commentsSig = comments
            .slice(0, 3)
            .map((c) => `${c?.author || ''}:${c?.content || ''}:${c?.likes || ''}`)
            .join('|');
        const sig = `${currentVideoKey || ''}|${data.title || ''}|${commentsSig}`;
        const videoKey = `${data.url || ''}|${data.title || ''}`; // URL|标题（不含评论）

        // 已成功上报过：直接跳过
        if ((lastSentVideoKey && videoKey === lastSentVideoKey) || (lastSentStableVideoKey && currentVideoKey && currentVideoKey === lastSentStableVideoKey)) {
            _tk_retryInProgress = false;
            console.log(`[TikTok自动采集] 该视频已上报过，跳过: ${data.title?.slice(0, 30)}`);
            return;
        }

        const now = Date.now();

        // 发送失败后的退避：同一份 sig，10 秒内不反复打 /data
        if (_tk_lastSendErrorSig && sig === _tk_lastSendErrorSig && (now - (_tk_lastSendErrorAt || 0)) < 10_000) {
            _tk_retryInProgress = false;
            return;
        }

        // 只有“真正成功发送过”的 sig 才会写入 lastCaptureSig/lastCaptureTs
        const shouldSend = sig !== lastCaptureSig || now - lastCaptureTs > 60_000;
        if (!shouldSend) {
            _tk_retryInProgress = false;
            console.log(`[TikTok自动采集] 数据未变化，跳过上报`);
            return;
        }

        _tk_retryInProgress = false;
        console.log(`[TikTok自动采集] 准备上报数据，comments数量: ${comments.length}`);

        data.extra_data = {
            ...(data.extra_data || {}),
            loop_count: currentLoopCount,
            loop_threshold: LOOP_THRESHOLD,
        };

        if (typeof tk_sendToPython === 'function') {
            const ok = await tk_sendToPython(data);
            if (ok) {
                logToUI('✅ 自动采集并发送视频数据', 'success');
                if (typeof updateSendStatus === 'function') {
                    const t = new Date().toLocaleTimeString();
                    updateSendStatus(`发送: ✅ ${t}`, '#28a745');
                }
                // 只有成功发送才更新“已发送”与 sig
                lastCaptureSig = sig;
                lastCaptureTs = now;
                lastSentVideoKey = videoKey;
                if (currentVideoKey) lastSentStableVideoKey = currentVideoKey;
                lastSentVideoAt = now;
                _tk_lastSendErrorAt = 0;
                _tk_lastSendErrorSig = '';
            } else {
                _tk_lastSendErrorAt = now;
                _tk_lastSendErrorSig = sig;
                logToUI('❌ 自动采集：发送到客户端失败(将自动重试)', 'warn');
                if (typeof updateSendStatus === 'function') {
                    const msg = (() => {
                        try {
                            return String(window.__TK_LAST_SEND_ERROR_MESSAGE__ || '');
                        } catch {
                            return '';
                        }
                    })();
                    updateSendStatus(`发送: ❌ ${msg || '失败(将重试)'}`, '#dc3545');
                }
            }
        }
    } catch {
        // ignore
    }
}

async function updateElementDetection() {
    let tab;
    try {
        tab = await getCurrentTab();
    } catch {
        return;
    }
    if (!tab?.id) return;
    const tabUrl = String(tab.url || tab.pendingUrl || '');
    if (!tabUrl.includes('tiktok.com')) return;

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: detectElements,
        });
        const r = results?.[0]?.result;
        if (!r) return;

        setElementStatus('status-subscribe', r.has_subscribe);
        setElementStatus('status-like', r.has_like);
        setElementStatus('status-comment-input', r.has_comment_input);
        setElementStatus('status-next', r.has_next);
    } catch {
        setElementStatus('status-subscribe', null);
        setElementStatus('status-like', null);
        setElementStatus('status-comment-input', null);
        setElementStatus('status-next', null);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    logToUI(`插件已加载 (BUILD_ID=${BUILD_ID})`, 'info');
    updateStatus('正在连接...', '#ddd');

    if (typeof updateSendStatus === 'function') {
        updateSendStatus('发送: -', '#555');
    }

    await updateTitleAndMaybeSend().catch(() => {});
    setInterval(() => updateTitleAndMaybeSend().catch(() => {}), 1000);

    autoCaptureLight().catch(() => {});
    setInterval(() => autoCaptureLight().catch(() => {}), 1500);

    updateElementDetection().catch(() => {});
    setInterval(() => updateElementDetection().catch(() => {}), 1500);

    if (typeof tk_pollPythonCommands === 'function') {
        void tk_pollPythonCommands();
    }
});
