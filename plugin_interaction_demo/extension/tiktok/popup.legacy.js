// ===========================
// TikTok 智能助手 - 独立插件 (MV3)
// 端口: 8099 | 平台: TikTok
// ===========================

const PORT = 8099;
const PLATFORM = 'tiktok';

// 用于排障：确认当前运行脚本版本
const BUILD_ID = '2025-12-26_tiktok_popup_clean_rewrite_v1';
try {
    window.__TK_PLUGIN_BUILD__ = BUILD_ID;
    console.log(`[Plugin Build] ${BUILD_ID}`);
} catch {
    // ignore
}

// ===========================
// UI
// ===========================

const LOOP_THRESHOLD = 5;
let currentLoopCount = 0;
let loopState = {
    key: '',
    lastCurrent: 0,
    lastDuration: 0,
};

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

function updateLoopCountForTime({ url, title, current, duration }) {
    const key = `${url || ''}|${title || ''}`;
    if (key !== loopState.key) {
        loopState = { key, lastCurrent: Number(current) || 0, lastDuration: Number(duration) || 0 };
        currentLoopCount = 0;
        return;
    }

    const lastCurrent = Number(loopState.lastCurrent) || 0;
    const lastDuration = Number(loopState.lastDuration) || 0;
    const cur = Number(current) || 0;
    const dur = Number(duration) || 0;

    // “循环”判定：上一帧接近结束，下一帧回到开头（同一视频）
    // 允许 duration 轻微抖动，因此用 lastDuration 或 dur 中更大的那个做参考。
    const refDur = Math.max(lastDuration, dur);
    if (refDur > 0) {
        const wasNearEnd = lastCurrent >= Math.max(0, refDur - 2);
        const nowNearStart = cur <= 2;
        if (wasNearEnd && nowNearStart) {
            currentLoopCount += 1;
            
            // 循环次数达到阈值：强制下一个（避免网络问题导致一直播放）
            if (currentLoopCount >= LOOP_THRESHOLD) {
                logToUI(`🔄 检测到视频已循环播放 ${currentLoopCount} 次，强制跳转下一个`, 'warn');
                // 异步触发，避免阻塞当前更新
                setTimeout(() => {
                    try {
                        if (typeof executeIncomingCommand !== 'undefined') {
                            void executeIncomingCommand({
                                type: 'monitor_next',
                                reason: 'loop_threshold_reached',
                                watchLimit: 1,
                            });
                        }
                    } catch (e) {
                        console.warn('Loop threshold trigger failed:', e);
                    }
                }, 100);
            }
        }
    }

    loopState.lastCurrent = cur;
    loopState.lastDuration = dur;
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

// ===========================
// Tab helper
// ===========================

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

    const safeLower = (u) => {
        try {
            return String(u || '').toLowerCase();
        } catch {
            return '';
        }
    };

    const isTikTokUrl = (u) => isInjectableUrl(u) && safeLower(u).includes('tiktok.com');

    const safeUrlFromTab = (t) => {
        try {
            // 部分情况下访问其它扩展页的 tab.url 可能触发权限异常
            return t?.url || t?.pendingUrl || '';
        } catch {
            return '';
        }
    };

    if (targetWindowId) {
        const tabs = await chrome.tabs.query({
            active: true,
            windowId: Number.parseInt(targetWindowId, 10),
        });
        const t = tabs?.[0];
        const u = safeUrlFromTab(t);
        if (t && isTikTokUrl(u)) return t;
    }

    // 回退：优先找任意 TikTok 页面 tab（避免当前 active tab 是扩展页/chrome:// 导致 executeScript 报错）
    try {
        const tiktokTabs = await chrome.tabs.query({
            url: ['*://*.tiktok.com/*', '*://tiktok.com/*'],
        });
        const activeTikTok = tiktokTabs.find((t) => t.active && isTikTokUrl(safeUrlFromTab(t)));
        if (activeTikTok) return activeTikTok;
        const anyTikTok = tiktokTabs.find((t) => isTikTokUrl(safeUrlFromTab(t)));
        if (anyTikTok) return anyTikTok;
    } catch {
        // ignore
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs.find((t) => isInjectableUrl(safeUrlFromTab(t)));
}

// ===========================
// Injected functions (run in page)
// ===========================

function _tk_isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
}

function _tk_getActiveContainer() {
    const videos = Array.from(document.querySelectorAll('video'));
    let bestVideo = null;
    let maxScore = -1;

    videos.forEach((v) => {
        const rect = v.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);

        let score = visibleArea;
        if (!v.paused) score *= 1.5;
        if (score > maxScore) {
            maxScore = score;
            bestVideo = v;
        }
    });

    if (bestVideo) {
        return bestVideo.closest('[data-e2e="recommend-list-item-container"]') || document;
    }
    return document;
}

function extractTargetText() {
    // IMPORTANT: 此函数会被 executeScript 单独序列化注入页面。
    // 因此必须完全自包含，不能引用 popup.js 里的其它 helper。

    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

    const getActiveContainer = () => {
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
            if (!v.paused) score *= 1.5;
            if (score > maxScore) {
                maxScore = score;
                bestVideo = v;
            }
        }

        if (bestVideo) {
            return bestVideo.closest('[data-e2e="recommend-list-item-container"]') || document;
        }
        return document;
    };

    const href = (() => {
        try {
            return String(window.location.href || '');
        } catch {
            return '';
        }
    })();

    const videoId = (() => {
        try {
            const m = String(href || '').match(/\/video\/(\d+)/);
            return m ? m[1] : '';
        } catch {
            return '';
        }
    })();

    let title = '等待检测视频...';
    let current = 0;
    let duration = 0;

    if (!window.location.hostname.includes('tiktok.com')) {
        return { title, current, duration, href, videoId };
    }

    const activeRoot = getActiveContainer();
    const isGlobalScope = activeRoot === document;

    const isValidText = (el) => {
        const t = el ? (el.innerText || el.textContent || '') : '';
        return t.trim().length > 0;
    };

    let descEl = null;
    if (isGlobalScope) {
        const descs = Array.from(document.querySelectorAll('[data-e2e="video-desc"]'));
        descEl = descs.find(isVisible);
    } else {
        descEl = activeRoot.querySelector('[data-e2e="video-desc"]');
    }

    if (isValidText(descEl)) {
        title = (descEl.innerText || descEl.textContent).trim();
    } else if (isGlobalScope) {
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc && metaDesc.content) title = metaDesc.content;
    }

    const video = isGlobalScope ? document.querySelector('video') : activeRoot.querySelector('video');
    if (video && !Number.isNaN(video.duration)) {
        current = Math.round(video.currentTime || 0);
        duration = Math.round(video.duration || 0);
    }

    return { title, current, duration, href, videoId };
}

function _tk_setMonitorOverlay(text, tone = 'info') {
    // IMPORTANT: 此函数会被 executeScript 单独序列化注入页面。
    // 因此必须完全自包含。
    try {
        const id = '__pi_tk_monitor_overlay';
        const existing = document.getElementById(id);
        const overlay = existing || document.createElement('div');
        overlay.id = id;

        overlay.style.position = 'fixed';
        overlay.style.left = '12px';
        overlay.style.top = '12px';
        overlay.style.zIndex = '2147483647';
        overlay.style.maxWidth = '60vw';
        overlay.style.padding = '8px 10px';
        overlay.style.borderRadius = '8px';
        overlay.style.fontSize = '12px';
        overlay.style.lineHeight = '1.35';
        overlay.style.whiteSpace = 'pre-line';
        overlay.style.pointerEvents = 'none';

        const colors = {
            info: { bg: 'rgba(0,0,0,0.65)', fg: '#ffffff' },
            warn: { bg: 'rgba(255,193,7,0.90)', fg: '#1b1b1b' },
            success: { bg: 'rgba(40,167,69,0.90)', fg: '#ffffff' },
            error: { bg: 'rgba(220,53,69,0.90)', fg: '#ffffff' },
        };
        const c = colors[String(tone || 'info')] || colors.info;
        overlay.style.background = c.bg;
        overlay.style.color = c.fg;

        overlay.textContent = String(text || '');
        if (!existing) {
            document.documentElement.appendChild(overlay);
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, msg: e?.message || String(e) };
    }
}

function _tk_removeMonitorOverlay() {
    // IMPORTANT: 自包含
    try {
        const el = document.getElementById('__pi_tk_monitor_overlay');
        if (el && el.parentElement) el.parentElement.removeChild(el);
        return { ok: true };
    } catch (e) {
        return { ok: false, msg: e?.message || String(e) };
    }
}

function getLightPageData() {
    // IMPORTANT: 此函数会被 executeScript 单独序列化注入页面。
    // 因此必须完全自包含，不能调用 extractTargetText/_tk_isVisible 等外部函数。

    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

    // 复制 extractTargetText 的核心逻辑（自包含版本）
    let title = '等待检测视频...';
    let current = 0;
    let duration = 0;
    let likeCountStr = '0';
    let commentCountStr = '0';

    if (window.location.hostname.includes('tiktok.com')) {
        const getActiveContainer = () => {
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
                if (!v.paused) score *= 1.5;
                if (score > maxScore) {
                    maxScore = score;
                    bestVideo = v;
                }
            }

            if (bestVideo) {
                return bestVideo.closest('[data-e2e="recommend-list-item-container"]') || document;
            }
            return document;
        };

        const activeRoot = getActiveContainer();
        const isGlobalScope = activeRoot === document;

        const isValidText = (el) => {
            const t = el ? (el.innerText || el.textContent || '') : '';
            return t.trim().length > 0;
        };

        let descEl = null;
        if (isGlobalScope) {
            const descs = Array.from(document.querySelectorAll('[data-e2e="video-desc"]'));
            descEl = descs.find(isVisible);
        } else {
            descEl = activeRoot.querySelector('[data-e2e="video-desc"]');
        }

        if (isValidText(descEl)) {
            title = (descEl.innerText || descEl.textContent).trim();
        } else if (isGlobalScope) {
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc && metaDesc.content) title = metaDesc.content;
        }

        const video = isGlobalScope ? document.querySelector('video') : activeRoot.querySelector('video');
        if (video && !Number.isNaN(video.duration)) {
            current = Math.round(video.currentTime || 0);
            duration = Math.round(video.duration || 0);
        }

        // 点赞/评论数（用于低质量过滤）
        const findVisibleIn = (root, selector) => {
            try {
                const els = Array.from((root || document).querySelectorAll(selector));
                return els.find(isVisible) || null;
            } catch {
                return null;
            }
        };
        const likeEl = isGlobalScope
            ? findVisibleIn(document, '[data-e2e="like-count"]')
            : (activeRoot.querySelector('[data-e2e="like-count"]') || findVisibleIn(document, '[data-e2e="like-count"]'));
        const cmtEl = isGlobalScope
            ? findVisibleIn(document, '[data-e2e="comment-count"]')
            : (activeRoot.querySelector('[data-e2e="comment-count"]') || findVisibleIn(document, '[data-e2e="comment-count"]'));
        if (likeEl && (likeEl.innerText || likeEl.textContent)) likeCountStr = (likeEl.innerText || likeEl.textContent).trim();
        if (cmtEl && (cmtEl.innerText || cmtEl.textContent)) commentCountStr = (cmtEl.innerText || cmtEl.textContent).trim();
    }

    const comments = [];
    if (window.location.hostname.includes('tiktok.com')) {
        const commentItems = Array.from(document.querySelectorAll('[class*="DivCommentItemWrapper"]')).filter(isVisible);
        // 不能只取前 3 条：前几条可能是图片/空内容，导致最终拿不到 3 条文本评论。
        // 改为向下多扫描一些，跳过空内容，直到凑够 3 条。
        for (const item of commentItems.slice(0, 30)) {
            const authorEl = item.querySelector('[data-e2e="comment-username-1"]') || item.querySelector('a[href^="/@"]');
            const contentEl = item.querySelector('[data-e2e="comment-level-1"]') || item.querySelector('p[class*="TUXText"]');
            const likeContainer = item.querySelector('[class*="DivLikeContainer"]');
            const likesStr = likeContainer ? (likeContainer.querySelector('span')?.innerText || '0') : '0';
            const author = authorEl ? (authorEl.innerText || authorEl.textContent || '').trim() : 'User';
            const content = contentEl ? (contentEl.innerText || contentEl.textContent || '').trim() : '';
            if (!content) continue;
            comments.push({ author, content, likes: likesStr });
            if (comments.length >= 3) break;
        }
    }

    return {
        title: title || '',
        url: window.location.href,
        platform: 'tiktok',
        html: '',
        extra_data: {
            comments,
            has_input: false,
            like_count: likeCountStr,
            comment_count: commentCountStr,
            duration,
            current_time: current,
        },
    };
}

function detectElements() {
    // IMPORTANT: executeScript 注入函数必须自包含
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

    const findVisible = (selectors) => {
        for (const sel of selectors) {
            let els = [];
            try {
                els = Array.from(document.querySelectorAll(sel));
            } catch {
                continue;
            }
            const hit = els.find(isVisible);
            if (hit) return hit;
        }
        return null;
    };

    const likeEl = findVisible([
        '[data-e2e="like-icon"]',
        'span[data-e2e="like-icon"]',
        'button[aria-label*="like" i]',
        'button[aria-label*="喜欢" i]',
    ]);

    const subscribeEl = findVisible([
        '[data-e2e="follow-button"]',
        'button[aria-label*="follow" i]',
        'button[aria-label*="关注" i]',
    ]);

    const commentInputEl = findVisible([
        '[data-e2e="comment-input"]',
        'textarea',
        'div[contenteditable="true"]',
    ]);

    const videoEl = findVisible(['video']);

    return {
        has_like: Boolean(likeEl),
        has_subscribe: Boolean(subscribeEl),
        has_comment_input: Boolean(commentInputEl),
        has_next: Boolean(videoEl),
    };
}

function detectCommentAreaTikTok() {
    // IMPORTANT: executeScript 注入函数必须自包含
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

    if (!window.location.hostname.includes('tiktok.com')) {
        return { ok: false, reason: 'not_tiktok', has_input: false, has_list: false, items: 0 };
    }

    const inputEl =
        Array.from(document.querySelectorAll('[data-e2e="comment-input"], textarea, div[contenteditable="true"]')).find(isVisible) ||
        null;

    // 评论项：优先用 DivCommentItemWrapper，其次用 data-e2e comment-level
    const wrappers = Array.from(document.querySelectorAll('div[class*="DivCommentItemWrapper"]')).filter(isVisible);
    const levelNodes = Array.from(document.querySelectorAll('div[data-e2e^="comment-level-"]')).filter(isVisible);

    const items = wrappers.length || levelNodes.length;
    const hasList = items > 0;
    const hasInput = Boolean(inputEl);
    return { ok: true, has_input: hasInput, has_list: hasList, items };
}

function _tk_clickFirstVisible(selectors) {
    for (const sel of selectors) {
        let els = [];
        try {
            els = Array.from(document.querySelectorAll(sel));
        } catch {
            continue;
        }
        const hit = els.find(_tk_isVisible);
        if (hit) {
            hit.click();
            return true;
        }
    }
    return false;
}

function openComments() {
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };
    const clickFirstVisible = (selectors) => {
        for (const sel of selectors) {
            let els = [];
            try {
                els = Array.from(document.querySelectorAll(sel));
            } catch {
                continue;
            }
            const hit = els.find(isVisible);
            if (hit) {
                hit.click();
                return true;
            }
        }
        return false;
    };

    const ok = clickFirstVisible([
        '[data-e2e="feed-comment-icon"]',
        '[data-e2e="comment-icon"]',
        '[data-e2e="comment-button"]',
        'button[aria-label*="comment" i]',
        'button[aria-label*="评论" i]',
    ]);
    return { ok };
}

async function likeVideo() {
    // 增强版点赞：多策略选择器 + 多次尝试 + 深度验证
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top < window.innerHeight &&
            rect.bottom > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) > 0
        );
    };

    // 多种点击方式
    const tryClick = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        // 1. 先尝试原生 click
        try {
            el.click();
        } catch (e) {
            console.warn('Native click failed:', e);
        }

        // 2. 触发完整事件链
        const target = document.elementFromPoint(x, y) || el;
        const opts = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: x + window.screenX,
            screenY: y + window.screenY,
            button: 0,
        };

        try {
            target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
        } catch (e) {
            console.warn('Event chain failed:', e);
        }

        // 3. 如果是可点击父元素，也尝试点父元素
        const clickableParent = el.closest('button, [role="button"], a');
        if (clickableParent && clickableParent !== el) {
            try {
                clickableParent.click();
            } catch (e) {
                // ignore
            }
        }

        return true;
    };

    // 多层选择器策略：从精确到宽泛
    const selectorGroups = [
        // 第一组：精确的 data-e2e 属性
        ['[data-e2e="like-icon"]', '[data-e2e="feed-like-icon"]', '[data-e2e="browse-like-icon"]'],
        // 第二组：带 like 的 span/button（常见结构）
        ['span[data-e2e*="like"]', 'button[data-e2e*="like"]'],
        // 第三组：aria-label 匹配
        ['button[aria-label*="like" i]', 'button[aria-label*="Like"]', '[role="button"][aria-label*="like" i]'],
        // 第四组：中文
        ['button[aria-label*="喜欢"]', '[role="button"][aria-label*="喜欢"]'],
        // 第五组：通过父容器定位（右侧交互栏）
        ['[class*="ActionItem"][class*="like"] button', '[class*="ActionItem"][class*="like"] [role="button"]'],
    ];

    let bestHit = null;
    let bestPressedEl = null;

    // 遍历所有选择器组
    for (const group of selectorGroups) {
        for (const sel of group) {
            try {
                const els = Array.from(document.querySelectorAll(sel));
                const hit = els.find(isVisible);
                if (hit) {
                    bestHit = hit;
                    bestPressedEl = hit.closest('[role="button"][aria-pressed], button[aria-pressed]') || hit;
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        if (bestHit) break;
    }

    if (!bestHit) {
        return { ok: false, reason: 'no_visible_like_button' };
    }

    // 记录点击前状态
    const beforePressed = String(bestPressedEl?.getAttribute?.('aria-pressed') || '');
    const beforeLabel = String(bestPressedEl?.getAttribute?.('aria-label') || '').slice(0, 200);
    const beforeClass = String(bestHit?.className || '').slice(0, 200);

    // 尝试点击（最多3次）
    let clicked = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        tryClick(bestHit);
        await sleep(attempt === 1 ? 200 : 300);

        const afterPressed = String(bestPressedEl?.getAttribute?.('aria-pressed') || '');
        if (beforePressed && afterPressed && beforePressed !== afterPressed) {
            clicked = true;
            break;
        }
    }

    // 最终验证
    await sleep(150);
    const afterPressed = String(bestPressedEl?.getAttribute?.('aria-pressed') || '');
    const afterLabel = String(bestPressedEl?.getAttribute?.('aria-label') || '').slice(0, 200);
    const afterClass = String(bestHit?.className || '').slice(0, 200);
    const toggled = Boolean(beforePressed && afterPressed && beforePressed !== afterPressed);
    const likedState = afterPressed.toLowerCase() === 'true';
    const labelChanged = beforeLabel !== afterLabel;
    const classChanged = beforeClass !== afterClass;
    const hasDialog = Boolean(document.querySelector('[role="dialog"], div[aria-modal="true"]'));

    return {
        ok: true,
        clicked,
        toggled,
        likedState,
        beforePressed,
        afterPressed,
        labelChanged,
        classChanged,
        beforeLabel: beforeLabel.slice(0, 80),
        afterLabel: afterLabel.slice(0, 80),
        hasDialog,
    };
}

function subscribe() {
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };
    const clickFirstVisible = (selectors) => {
        for (const sel of selectors) {
            let els = [];
            try {
                els = Array.from(document.querySelectorAll(sel));
            } catch {
                continue;
            }
            const hit = els.find(isVisible);
            if (hit) {
                hit.click();
                return true;
            }
        }
        return false;
    };

    const ok = clickFirstVisible([
        'button[data-e2e="follow-button"]',
        'button[aria-label*="follow" i]',
        'button[aria-label*="关注" i]',
    ]);
    return { ok };
}

// 仅用于诊断：尝试给第一条热门评论点赞
async function likeTopCommentTikTokPage() {
    try {
        if (!window.location.hostname.includes('tiktok.com')) {
            return { ok: false, reason: 'not_tiktok', href: window.location.href };
        }

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
        };

        const parseCount = (s) => {
            if (!s) return 0;
            const raw = String(s).trim();
            if (!raw) return 0;
            const upper = raw.toUpperCase().replace(/\s+/g, '');
            let m = 1;
            if (upper.includes('K')) m = 1000;
            else if (upper.includes('M')) m = 1000000;
            else if (upper.includes('B')) m = 1000000000;
            else if (upper.includes('万')) m = 10000;
            const num = parseFloat(upper.replace(/,/g, '').replace(/[KMB万]/g, ''));
            return Number.isFinite(num) ? num * m : 0;
        };

        const extractCountText = (item, likeBtn) => {
            // 1) 最常见：按钮内部 span
            let t = (likeBtn && likeBtn.querySelector) ? (likeBtn.querySelector('span')?.innerText || '') : '';
            t = String(t || '').trim();

            // 2) 其次：按钮自身文本
            if (!t) {
                t = String(likeBtn?.innerText || likeBtn?.textContent || '').trim();
            }

            // 3) aria-label 里可能带数值
            if (!t) {
                const al = String(likeBtn?.getAttribute?.('aria-label') || '').trim();
                const m = al.match(/([0-9]+(?:\.[0-9]+)?\s*[KMB万]?)/i);
                if (m && m[1]) t = m[1].trim();
            }

            // 4) 兜底：在评论项里找像数字的 span
            if (!t && item && item.querySelectorAll) {
                const spans = Array.from(item.querySelectorAll('span'));
                let best = '';
                let bestNum = 0;
                for (const sp of spans) {
                    const txt = String(sp.innerText || sp.textContent || '').trim();
                    if (!txt) continue;
                    // 过滤明显不是数值的
                    if (!/^[0-9]+(\.[0-9]+)?\s*[KMB万]?$/.test(txt.replace(/\s+/g, ''))) continue;
                    const n = parseCount(txt);
                    if (n > bestNum) {
                        bestNum = n;
                        best = txt;
                    }
                }
                if (best) t = best;
            }

            return t || '0';
        };

        const clickAtCenter = (el) => {
            if (!el) return { ok: false };
            const rect = el.getBoundingClientRect();
            const x = Math.floor(rect.left + rect.width / 2);
            const y = Math.floor(rect.top + rect.height / 2);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
            if (rect.width <= 0 || rect.height <= 0) return { ok: false };

            // 让命中的目标更像真人点击：先 move，再 pointer/mouse down/up/click
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

            // 兜底：原生 click
            try { el.click(); } catch { /* ignore */ }

            return { ok: true, x, y, rect: { w: rect.width, h: rect.height } };
        };

        // 1) 尝试打开评论区（如果评论未展开）
        const commentBtnSelectors = [
            '[data-e2e="feed-comment-icon"]',
            '[data-e2e="comment-icon"]',
            '[data-e2e="comment-button"]',
            'button[aria-label*="comment" i]',
            'button[aria-label*="评论" i]',
        ];
        let clickedCommentBtn = false;
        for (const sel of commentBtnSelectors) {
            const btn = Array.from(document.querySelectorAll(sel)).find(isVisible);
            if (btn && clickAtCenter(btn).ok) {
                clickedCommentBtn = true;
                break;
            }
        }

        // 给弹层一点时间
        await sleep(350);

        // 2) 查找评论项
        const getCommentItems = () => {
            const byWrapper = Array.from(document.querySelectorAll('div[class*="DivCommentItemWrapper"]')).filter(isVisible);
            if (byWrapper.length) return byWrapper;

            // 兜底：从 comment-level 节点向上找 wrapper
            const levelNodes = Array.from(document.querySelectorAll('div[data-e2e^="comment-level-"]'));
            const items = [];
            for (const n of levelNodes) {
                const w = n.closest && n.closest('div[class*="DivCommentItemWrapper"]');
                if (w && isVisible(w)) items.push(w);
            }
            return items;
        };

        const commentItems = getCommentItems();
        if (!commentItems || commentItems.length === 0) {
            return {
                ok: false,
                reason: 'no_comment_items',
                clickedCommentBtn,
                hasCommentInput: Boolean(document.querySelector('[data-e2e="comment-input"]')),
                hasCommentsTab: Boolean(document.querySelector('#comments')),
                href: window.location.href,
            };
        }

        // 3) 找“高赞评论”的点赞按钮：扫描→解析点赞数→排序
        const pickTopByLikes = (items) => {
            const candidates = [];
            for (const item of items) {
                const btn =
                    item.querySelector('div[class*="DivLikeContainer"][role="button"][aria-pressed]') ||
                    item.querySelector('[role="button"][aria-pressed][aria-label*="Like" i]') ||
                    item.querySelector('[role="button"][aria-pressed][aria-label*="赞" i]');
                if (!btn) continue;
                const pressed = (btn.getAttribute('aria-pressed') || '').toLowerCase();
                const countText = extractCountText(item, btn);
                const countNum = parseCount(countText);
                candidates.push({ item, btn, pressed, countText, countNum });
            }
            if (candidates.length === 0) return null;

            // 点赞数从高到低
            candidates.sort((a, b) => (b.countNum || 0) - (a.countNum || 0));

            // 优先选未点赞的最高赞
            const prefer = candidates.find((x) => x.pressed !== 'true') || candidates[0];
            return {
                picked: prefer,
                top: candidates[0],
                scanned: candidates.length,
            };
        };

        const pickedWrap = pickTopByLikes(commentItems);
        if (!pickedWrap) {
            return {
                ok: false,
                reason: 'no_like_button',
                clickedCommentBtn,
                commentItemsCount: commentItems.length,
            };
        }

        const { picked, top, scanned } = pickedWrap;
        const { item, btn: likeBtn, countText, countNum } = picked;
        try {
            item.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
            // ignore
        }
        await sleep(80);

        const beforePressed = (likeBtn.getAttribute('aria-pressed') || '').toLowerCase();
        const beforeLabel = (likeBtn.getAttribute('aria-label') || '').slice(0, 160);
        const beforeCountText = extractCountText(item, likeBtn);

        const clickInfo = clickAtCenter(likeBtn);
        await sleep(220);

        const afterPressed = (likeBtn.getAttribute('aria-pressed') || '').toLowerCase();
        const afterCountText = extractCountText(item, likeBtn);

        const toggled = beforePressed !== afterPressed;
        const likedState = afterPressed === 'true';

        // 轻量诊断：是否弹出登录/拦截类对话框
        const hasDialog = Boolean(document.querySelector('[role="dialog"], div[aria-modal="true"]'));

        return {
            ok: true,
            clickedCommentBtn,
            commentItemsCount: commentItems.length,
            scannedLikeButtons: scanned,
            pickedCountText: countText,
            pickedCountNum: countNum,
            topCountText: top?.countText || '0',
            topCountNum: top?.countNum || 0,
            beforePressed,
            afterPressed,
            toggled,
            likedState,
            beforeLabel,
            beforeCountText,
            afterCountText,
            clickInfo,
            hasDialog,
        };
    } catch (e) {
        return { ok: false, reason: 'exception', msg: e?.message || String(e) };
    }
}

// 点赞指定序号（从 1 开始）的评论（按页面当前排序/可见顺序）
async function likeCommentByIndexTikTokPage(index) {
    try {
        if (!window.location.hostname.includes('tiktok.com')) {
            return { ok: false, reason: 'not_tiktok', href: window.location.href };
        }

        const idx = Math.max(1, Math.min(50, Number(index) || 1));
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
        };

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
            try {
                el.click();
            } catch {
                /* ignore */
            }
            return { ok: true, x, y, rect: { w: rect.width, h: rect.height } };
        };

        // 1) 尝试打开评论区
        const commentBtnSelectors = [
            '[data-e2e="feed-comment-icon"]',
            '[data-e2e="comment-icon"]',
            '[data-e2e="comment-button"]',
            'button[aria-label*="comment" i]',
            'button[aria-label*="评论" i]',
        ];
        let clickedCommentBtn = false;
        for (const sel of commentBtnSelectors) {
            const btn = Array.from(document.querySelectorAll(sel)).find(isVisible);
            if (btn && clickAtCenter(btn).ok) {
                clickedCommentBtn = true;
                break;
            }
        }

        await sleep(350);

        // 2) 查找评论项
        const getCommentItems = () => {
            const byWrapper = Array.from(document.querySelectorAll('div[class*="DivCommentItemWrapper"]')).filter(isVisible);
            if (byWrapper.length) return byWrapper;

            const levelNodes = Array.from(document.querySelectorAll('div[data-e2e^="comment-level-"]'));
            const items = [];
            for (const n of levelNodes) {
                const w = n.closest && n.closest('div[class*="DivCommentItemWrapper"]');
                if (w && isVisible(w)) items.push(w);
            }
            return items;
        };

        const commentItems = getCommentItems();
        if (!commentItems || commentItems.length === 0) {
            return {
                ok: false,
                reason: 'no_comment_items',
                clickedCommentBtn,
                hasCommentInput: Boolean(document.querySelector('[data-e2e="comment-input"]')),
                href: window.location.href,
            };
        }

        const pickByIndex = (items, i) => {
            const pos = Math.max(0, Math.min(items.length - 1, i - 1));
            const item = items[pos];
            if (!item) return null;
            const btn =
                item.querySelector('div[class*="DivLikeContainer"][role="button"][aria-pressed]') ||
                item.querySelector('[role="button"][aria-pressed][aria-label*="Like" i]');
            if (!btn) return null;
            return { item, btn };
        };

        const picked = pickByIndex(commentItems, idx);
        if (!picked) {
            return {
                ok: false,
                reason: 'no_like_button_for_index',
                clickedCommentBtn,
                commentItemsCount: commentItems.length,
                index: idx,
            };
        }

        const { item, btn: likeBtn } = picked;
        try {
            item.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
            // ignore
        }
        await sleep(80);

        const beforePressed = (likeBtn.getAttribute('aria-pressed') || '').toLowerCase();

        const clickInfo = clickAtCenter(likeBtn);
        await sleep(220);

        const afterPressed = (likeBtn.getAttribute('aria-pressed') || '').toLowerCase();
        const toggled = beforePressed !== afterPressed;
        const likedState = afterPressed === 'true';

        return {
            ok: true,
            index: idx,
            clickedCommentBtn,
            commentItemsCount: commentItems.length,
            beforePressed,
            afterPressed,
            toggled,
            likedState,
            clickInfo,
        };
    } catch (e) {
        return { ok: false, reason: 'exception', msg: e?.message || String(e) };
    }
}

// 优先按 matchText 定位评论，再点赞；找不到匹配时回退 index
async function likeCommentMatchTikTokPage(matchText, indexFallback) {
    try {
        if (!window.location.hostname.includes('tiktok.com')) {
            return { ok: false, reason: 'not_tiktok', href: window.location.href };
        }

        const idx = Math.max(1, Math.min(50, Number(indexFallback) || 1));
        const targetRaw = typeof matchText === 'string' ? matchText : String(matchText || '');
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
        };

        const normalize = (s) => {
            try {
                return String(s || '')
                    .replace(/[\u200B-\u200D\uFEFF]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase();
            } catch {
                return '';
            }
        };

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
            try {
                el.click();
            } catch {
                /* ignore */
            }
            return { ok: true, x, y, rect: { w: rect.width, h: rect.height } };
        };

        // 1) 打开评论区
        const commentBtnSelectors = [
            '[data-e2e="feed-comment-icon"]',
            '[data-e2e="comment-icon"]',
            '[data-e2e="comment-button"]',
            'button[aria-label*="comment" i]',
            'button[aria-label*="评论" i]',
        ];
        let clickedCommentBtn = false;
        for (const sel of commentBtnSelectors) {
            const btn = Array.from(document.querySelectorAll(sel)).find(isVisible);
            if (btn && clickAtCenter(btn).ok) {
                clickedCommentBtn = true;
                break;
            }
        }
        await sleep(350);

        const getCommentItems = () => {
            const byWrapper = Array.from(document.querySelectorAll('div[class*="DivCommentItemWrapper"]')).filter(isVisible);
            if (byWrapper.length) return byWrapper;

            const levelNodes = Array.from(document.querySelectorAll('div[data-e2e^="comment-level-"]'));
            const items = [];
            for (const n of levelNodes) {
                const w = n.closest && n.closest('div[class*="DivCommentItemWrapper"]');
                if (w && isVisible(w)) items.push(w);
            }
            return items;
        };

        const commentItems = getCommentItems();
        if (!commentItems || commentItems.length === 0) {
            return {
                ok: false,
                reason: 'no_comment_items',
                clickedCommentBtn,
                hasCommentInput: Boolean(document.querySelector('[data-e2e="comment-input"]')),
                href: window.location.href,
            };
        }

        const extractItemText = (item) => {
            const candidates = [];
            const push = (el) => {
                try {
                    const t = (el?.innerText || el?.textContent || '').trim();
                    if (t) candidates.push(t);
                } catch {
                    // ignore
                }
            };

            try {
                item.querySelectorAll('div[data-e2e^="comment-level-"], span[data-e2e^="comment-level-"]').forEach(push);
            } catch {
                // ignore
            }
            try {
                item.querySelectorAll('div[class*="DivCommentItemText"], div[class*="DivCommentContent"], p').forEach(push);
            } catch {
                // ignore
            }

            // 取最长的一段作为“评论正文”候选
            let best = '';
            for (const c of candidates) {
                if (c.length > best.length) best = c;
            }
            return best;
        };

        const pickLikeBtn = (item) => {
            return (
                item.querySelector('div[class*="DivLikeContainer"][role="button"][aria-pressed]') ||
                item.querySelector('[role="button"][aria-pressed][aria-label*="Like" i]')
            );
        };

        const targetNorm = normalize(targetRaw);
        let matched = false;
        let matchedIndex = -1;
        let matchedText = '';
        let pickedItem = null;

        // 2) 尝试按文本匹配
        if (targetNorm) {
            let bestScore = -1;
            for (let i = 0; i < commentItems.length; i += 1) {
                const item = commentItems[i];
                const t = extractItemText(item);
                const n = normalize(t);
                if (!n) continue;
                if (n === targetNorm) {
                    bestScore = 10_000;
                    matchedIndex = i;
                    matchedText = t;
                    pickedItem = item;
                    break;
                }
                if (n.includes(targetNorm) || targetNorm.includes(n)) {
                    const score = Math.min(n.length, targetNorm.length);
                    if (score > bestScore) {
                        bestScore = score;
                        matchedIndex = i;
                        matchedText = t;
                        pickedItem = item;
                    }
                }
            }
            if (pickedItem) matched = true;
        }

        // 3) 回退：按序号取
        if (!pickedItem) {
            const pos = Math.max(0, Math.min(commentItems.length - 1, idx - 1));
            pickedItem = commentItems[pos];
            matchedIndex = pos;
        }

        if (!pickedItem) {
            return { ok: false, reason: 'no_target_item', commentItemsCount: commentItems.length, matched: false };
        }

        const likeBtn = pickLikeBtn(pickedItem);
        if (!likeBtn) {
            return {
                ok: false,
                reason: 'no_like_button_for_target',
                commentItemsCount: commentItems.length,
                matched,
                matchedIndex: matchedIndex + 1,
            };
        }

        try {
            pickedItem.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
            // ignore
        }
        await sleep(80);

        const beforePressed = (likeBtn.getAttribute('aria-pressed') || '').toLowerCase();
        const clickInfo = clickAtCenter(likeBtn);
        await sleep(220);
        const afterPressed = (likeBtn.getAttribute('aria-pressed') || '').toLowerCase();

        return {
            ok: true,
            matched,
            matchedIndex: matchedIndex + 1,
            matchedText: matchedText ? matchedText.slice(0, 120) : '',
            targetText: targetRaw ? String(targetRaw).slice(0, 120) : '',
            clickedCommentBtn,
            commentItemsCount: commentItems.length,
            beforePressed,
            afterPressed,
            toggled: beforePressed !== afterPressed,
            likedState: afterPressed === 'true',
            clickInfo,
        };
    } catch (e) {
        return { ok: false, reason: 'exception', msg: e?.message || String(e) };
    }
}

// 仅用于诊断：尝试在当前视频下发表评论 "good"
async function commentGoodTikTokPage() {
    try {
        if (!window.location.hostname.includes('tiktok.com')) {
            return { ok: false, reason: 'not_tiktok', href: window.location.href };
        }

        const text = 'good';
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
        };

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
            return { ok: true, x, y, rect: { w: rect.width, h: rect.height } };
        };

        // 1) 尝试打开评论区
        const commentBtnSelectors = [
            '[data-e2e="feed-comment-icon"]',
            '[data-e2e="comment-icon"]',
            '[data-e2e="comment-button"]',
            'button[aria-label*="comment" i]',
            'button[aria-label*="评论" i]',
        ];
        let clickedCommentBtn = false;
        for (const sel of commentBtnSelectors) {
            const btn = Array.from(document.querySelectorAll(sel)).find(isVisible);
            if (btn && clickAtCenter(btn).ok) {
                clickedCommentBtn = true;
                break;
            }
        }
        await sleep(350);

        // 2) 找 editor（优先可见且在评论输入区内）
        const container = document.querySelector('[data-e2e="comment-input"]');
        const getEditors = () => {
            const list = [];
            try {
                const fromContainer = container
                    ? Array.from(container.querySelectorAll('[contenteditable="true"][role="textbox"], textarea'))
                    : [];
                list.push(...fromContainer);
            } catch {
                // ignore
            }

            try {
                list.push(...Array.from(document.querySelectorAll('[data-e2e="comment-text"] [contenteditable="true"][role="textbox"]')));
            } catch {
                // ignore
            }

            try {
                list.push(...Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"].public-DraftEditor-content')));
            } catch {
                // ignore
            }

            try {
                list.push(...Array.from(document.querySelectorAll('textarea')));
            } catch {
                // ignore
            }

            const uniq = Array.from(new Set(list));
            const visible = uniq.filter(isVisible);
            // 挑一个面积最大的（通常是主输入框）
            let best = null;
            let bestArea = -1;
            for (const el of visible) {
                const r = el.getBoundingClientRect();
                const area = Math.max(0, r.width) * Math.max(0, r.height);
                if (area > bestArea) {
                    bestArea = area;
                    best = el;
                }
            }
            return { all: uniq, visible, best };
        };

        const ed = getEditors();
        const editor = ed.best;

        if (!editor) {
            return {
                ok: false,
                reason: 'no_editor',
                clickedCommentBtn,
                hasContainer: Boolean(container),
                hasPostBtn: Boolean(document.querySelector('[data-e2e="comment-post"]')),
            };
        }

        const getEditorText = () => {
            try {
                return editor.isContentEditable
                    ? (editor.innerText || editor.textContent || '').trim()
                    : String(editor.value || '').trim();
            } catch {
                return '';
            }
        };

        const getFocusState = () => {
            const active = document.activeElement;
            const isActive = active === editor || (editor.contains && editor.contains(active));
            let focusWithin = false;
            try {
                focusWithin = editor.matches ? editor.matches(':focus') || editor.matches(':focus-within') : false;
            } catch {
                focusWithin = false;
            }
            let selectionInEditor = false;
            try {
                const sel = window.getSelection();
                const n = sel && sel.anchorNode;
                selectionInEditor = !!(n && editor.contains && editor.contains(n));
            } catch {
                selectionInEditor = false;
            }
            return { isActive, focusWithin, selectionInEditor, activeTag: active?.tagName || '' };
        };

        const ensureSelectionAtEnd = () => {
            try {
                if (editor.isContentEditable) {
                    const sel = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(editor);
                    range.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(range);
                } else if (typeof editor.selectionStart === 'number') {
                    const v = editor.value || '';
                    editor.selectionStart = v.length;
                    editor.selectionEnd = v.length;
                }
            } catch {
                // ignore
            }
        };

        // 3) 点击+聚焦（优先点容器再点 editor，尽量让 TikTok 认为是用户操作）
        let containerClick = null;
        try {
            (container || editor).scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
            // ignore
        }
        if (container) {
            containerClick = clickAtCenter(container);
            await sleep(60);
        }
        const editorClick = clickAtCenter(editor);
        await sleep(50);
        try {
            editor.focus({ preventScroll: true });
        } catch {
            try {
                editor.focus();
            } catch {
                // ignore
            }
        }
        await sleep(80);
        ensureSelectionAtEnd();
        await sleep(20);

        const focusBeforeInput = getFocusState();

        // 4) 填入文本：除了 execCommand，还补齐 beforeinput/input 事件
        const dispatchBeforeInput = (data, inputType = 'insertText') => {
            try {
                const evt = new InputEvent('beforeinput', {
                    bubbles: true,
                    cancelable: true,
                    inputType,
                    data,
                });
                editor.dispatchEvent(evt);
                return true;
            } catch {
                return false;
            }
        };

        const dispatchInput = (data, inputType = 'insertText') => {
            try {
                const evt = new InputEvent('input', {
                    bubbles: true,
                    cancelable: false,
                    inputType,
                    data,
                });
                editor.dispatchEvent(evt);
                return true;
            } catch {
                try {
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                } catch {
                    return false;
                }
            }
        };

        let filled = false;
        let fillMethod = 'unknown';
        try {
            if (editor.isContentEditable) {
                // 清空
                dispatchBeforeInput('', 'deleteContentBackward');
                try {
                    document.execCommand('selectAll', false, null);
                    document.execCommand('delete', false, null);
                } catch {
                    // ignore
                }
                dispatchInput('', 'deleteContentBackward');

                // 插入
                dispatchBeforeInput(text, 'insertText');
                try {
                    const ok = document.execCommand('insertText', false, text);
                    fillMethod = ok ? 'execCommand' : 'execCommand_unknown';
                } catch {
                    fillMethod = 'execCommand_error';
                }
                dispatchInput(text, 'insertText');
                ensureSelectionAtEnd();
            } else {
                editor.value = text;
                fillMethod = 'value';
                dispatchInput(text, 'insertText');
            }
            filled = true;
        } catch {
            filled = false;
        }

        await sleep(120);

        // 如果 Post 仍不可点，尝试再点一次输入框（有时需要“激活”状态）
        const focusAfterInput = getFocusState();
        const afterText = getEditorText();
        if (container && (!focusAfterInput.isActive || !focusAfterInput.selectionInEditor)) {
            clickAtCenter(container);
            await sleep(50);
            clickAtCenter(editor);
            await sleep(80);
            ensureSelectionAtEnd();
        }

        const findBtn = () =>
            document.querySelector('[data-e2e="comment-post"]') ||
            document.querySelector('button[aria-label="Post" i]') ||
            document.querySelector('button[type="submit"]');

        const isEnabled = (btn) => {
            if (!btn) return false;
            const aria = String(btn.getAttribute('aria-disabled') || '').toLowerCase();
            return !(btn.disabled || aria === 'true');
        };

        const getBlockingDialogInfo = (anchorEl) => {
            try {
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"], div[aria-modal="true"]'));
                if (!dialogs.length) return null;

                const isDialogVisible = (el) => {
                    try {
                        const r = el.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) return false;
                        if (r.bottom <= 0 || r.right <= 0) return false;
                        if (r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
                        const style = window.getComputedStyle(el);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                        if (String(el.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return false;
                        return true;
                    } catch {
                        return false;
                    }
                };

                const getRect = (el) => {
                    try {
                        const r = el.getBoundingClientRect();
                        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
                    } catch {
                        return null;
                    }
                };

                const intersects = (a, b) => {
                    if (!a || !b) return false;
                    const left = Math.max(a.left, b.left);
                    const right = Math.min(a.right, b.right);
                    const top = Math.max(a.top, b.top);
                    const bottom = Math.min(a.bottom, b.bottom);
                    return right > left && bottom > top;
                };

                const anchorRect = anchorEl ? getRect(anchorEl) : null;
                const pick = dialogs
                    .filter(isDialogVisible)
                    .map((d) => ({ d, r: getRect(d) }))
                    .filter((x) => x.r)
                    .map((x) => {
                        const coversAnchor = anchorRect ? intersects(x.r, anchorRect) : false;
                        // 是否真正“挡住”输入框：在输入框中心点取 elementFromPoint，看是否落在 dialog 内
                        let blocksCenter = false;
                        if (anchorRect) {
                            const cx = Math.floor((anchorRect.left + anchorRect.right) / 2);
                            const cy = Math.floor((anchorRect.top + anchorRect.bottom) / 2);
                            if (Number.isFinite(cx) && Number.isFinite(cy)) {
                                const hit = document.elementFromPoint(cx, cy);
                                blocksCenter = !!(hit && x.d.contains(hit));
                            }
                        }
                        return { dialog: x.d, rect: x.r, coversAnchor, blocksCenter };
                    })
                    // 优先选“中心点被挡住”的，再选相交的
                    .sort((a, b) => {
                        const ka = (a.blocksCenter ? 2 : 0) + (a.coversAnchor ? 1 : 0);
                        const kb = (b.blocksCenter ? 2 : 0) + (b.coversAnchor ? 1 : 0);
                        return kb - ka;
                    })[0];

                if (!pick) return null;
                if (!pick.blocksCenter && !pick.coversAnchor) return null;

                const dialog = pick.dialog;
                const text = (dialog.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 600);
                const buttons = Array.from(dialog.querySelectorAll('button'))
                    .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim())
                    .filter(Boolean)
                    .slice(0, 12);
                const links = Array.from(dialog.querySelectorAll('a[href]'))
                    .map((a) => String(a.getAttribute('href') || '').trim())
                    .filter(Boolean)
                    .slice(0, 12);
                const title =
                    (dialog.querySelector('h1,h2,h3,[data-e2e*="title"],header')?.innerText || '')
                        .trim()
                        .replace(/\s+/g, ' ')
                        .slice(0, 160);
                return {
                    title,
                    text,
                    buttons,
                    links,
                    blocksCenter: pick.blocksCenter,
                    coversAnchor: pick.coversAnchor,
                };
            } catch {
                return null;
            }
        };

        const typeChar = (ch) => {
            const keyCode = ch.charCodeAt(0);
            const common = {
                key: ch,
                code: `Key${ch.toUpperCase()}`,
                keyCode,
                which: keyCode,
                charCode: keyCode,
                bubbles: true,
                cancelable: true,
                composed: true,
            };

            try { editor.dispatchEvent(new KeyboardEvent('keydown', common)); } catch { /* ignore */ }
            try { editor.dispatchEvent(new KeyboardEvent('keypress', common)); } catch { /* ignore */ }
            try {
                editor.dispatchEvent(
                    new InputEvent('beforeinput', {
                        bubbles: true,
                        cancelable: true,
                        inputType: 'insertText',
                        data: ch,
                    })
                );
            } catch {
                // ignore
            }

            if (editor.isContentEditable) {
                try {
                    document.execCommand('insertText', false, ch);
                } catch {
                    // ignore
                }
            } else {
                try {
                    const start = editor.selectionStart || 0;
                    const end = editor.selectionEnd || 0;
                    const before = (editor.value || '').substring(0, start);
                    const after = (editor.value || '').substring(end);
                    editor.value = before + ch + after;
                    editor.selectionStart = start + 1;
                    editor.selectionEnd = start + 1;
                } catch {
                    // ignore
                }
            }

            try {
                editor.dispatchEvent(
                    new InputEvent('input', {
                        bubbles: true,
                        cancelable: false,
                        inputType: 'insertText',
                        data: ch,
                    })
                );
            } catch {
                try { editor.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* ignore */ }
            }

            try { editor.dispatchEvent(new KeyboardEvent('keyup', common)); } catch { /* ignore */ }
        };

        // 5) 等待 Post 变为可点
        let submit = findBtn();
        const beforeEnabled = isEnabled(submit);
        const waitStart = Date.now();
        while (!isEnabled(submit) && (Date.now() - waitStart) < 1500) {
            await sleep(60);
            submit = findBtn();
        }

        const afterEnabled = isEnabled(submit);
        const beforeText = afterText;
        const postAriaDisabled = submit ? String(submit.getAttribute('aria-disabled') || '') : '';
        const postDisabledProp = submit ? Boolean(submit.disabled) : null;
        const postBtnText = submit ? ((submit.innerText || submit.getAttribute('aria-label') || '').trim().slice(0, 80)) : '';

        // 5.5) 如果仍不可点，尝试“逐字键入”再观察一次（有些实现只在键盘链路里更新按钮状态）
        let afterTypingEnabled = afterEnabled;
        let afterTypingText = beforeText;
        if (!afterEnabled) {
            try {
                // 清空后逐字输入
                if (editor.isContentEditable) {
                    try {
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                    } catch {
                        // ignore
                    }
                } else {
                    try {
                        editor.value = '';
                        editor.dispatchEvent(new Event('input', { bubbles: true }));
                    } catch {
                        // ignore
                    }
                }

                await sleep(50);
                for (const ch of text) {
                    typeChar(ch);
                    await sleep(35);
                }
                await sleep(160);
                afterTypingText = getEditorText();
                submit = findBtn();
                afterTypingEnabled = isEnabled(submit);
            } catch {
                // ignore
            }
        }

        if (!afterTypingEnabled) {
            const dialogInfo = getBlockingDialogInfo(container || editor);
            const hasDialog = Boolean(dialogInfo);

            // 如果没有遮挡弹窗，说明“内容存在但按钮不启用”——很多站点会依赖 isTrusted 的真实输入。
            // 这里做一个“半自动”：等待用户在页面里点击/敲键触发真实输入链路，按钮一旦启用就自动点击 Post。
            let waitedUserMs = 0;
            let autoClickedAfterUser = false;
            let autoClickResult = null;

            if (!hasDialog) {
                const maxWait = 8000;
                const step = 200;
                const start = Date.now();
                while ((Date.now() - start) < maxWait) {
                    await sleep(step);
                    waitedUserMs = Date.now() - start;
                    submit = findBtn();
                    if (isEnabled(submit)) {
                        // 尝试自动点击 Post
                        try {
                            const submitClick = submit ? clickAtCenter(submit) : { ok: false };
                            await sleep(150);
                            const sentStart = Date.now();
                            while ((Date.now() - sentStart) < 2000) {
                                if (!getEditorText()) {
                                    autoClickedAfterUser = true;
                                    autoClickResult = {
                                        submitClick,
                                        cleared: true,
                                    };
                                    break;
                                }
                                await sleep(80);
                            }

                            if (!autoClickedAfterUser) {
                                autoClickedAfterUser = true;
                                autoClickResult = {
                                    submitClick,
                                    cleared: false,
                                    afterText: getEditorText(),
                                };
                            }
                        } catch {
                            // ignore
                        }
                        break;
                    }
                }
            }

            if (autoClickedAfterUser) {
                return {
                    ok: true,
                    mode: 'semi_auto',
                    clickedCommentBtn,
                    filled,
                    fillMethod,
                    text,
                    focusBeforeInput,
                    focusAfterInput,
                    beforeText: afterTypingText,
                    waitedUserMs,
                    autoClickedAfterUser,
                    autoClickResult,
                };
            }

            return {
                ok: false,
                reason: 'post_disabled_or_missing',
                clickedCommentBtn,
                filled,
                fillMethod,
                focusBeforeInput,
                focusAfterInput,
                beforeText: afterTypingText,
                hasSubmit: Boolean(submit),
                beforeEnabled,
                afterEnabled: afterTypingEnabled,
                postAriaDisabled: submit ? String(submit.getAttribute('aria-disabled') || '') : postAriaDisabled,
                postDisabledProp: submit ? Boolean(submit.disabled) : postDisabledProp,
                postBtnText,
                hasDialog,
                dialogInfo,
                editorCountAll: ed.all.length,
                editorCountVisible: ed.visible.length,
                attemptedPerCharTyping: true,
                waitedUserMs,
                hint:
                    '已填入文本但 Post 未启用；请在页面里用鼠标点一下输入框或真实敲一个键(例如空格再删除)，看 Post 是否变红。',
            };
        }

        try {
            submit.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
            // ignore
        }

        const submitClick = clickAtCenter(submit);
        await sleep(120);

        // 6) 等待输入框清空确认
        const sentStart = Date.now();
        while ((Date.now() - sentStart) < 2000) {
            if (!getEditorText()) {
                return {
                    ok: true,
                    clickedCommentBtn,
                    filled,
                    fillMethod,
                    text,
                    focusBeforeInput,
                    focusAfterInput,
                    editorClick,
                    containerClick,
                    submitClick,
                    beforeEnabled,
                    afterEnabled,
                    beforeText,
                    cleared: true,
                };
            }
            await sleep(80);
        }

        return {
            ok: true,
            clickedCommentBtn,
            filled,
            fillMethod,
            text,
            focusBeforeInput,
            focusAfterInput,
            editorClick,
            containerClick,
            submitClick,
            beforeEnabled,
            afterEnabled,
            beforeText,
            cleared: false,
            afterText: getEditorText(),
        };
    } catch (e) {
        return { ok: false, reason: 'exception', msg: e?.message || String(e) };
    }
}

function nextVideo() {
    // IMPORTANT: executeScript 注入函数必须自包含
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

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
            if (!v.paused) score *= 1.5;
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
            const canScroll =
                (overflowY === 'auto' || overflowY === 'scroll') &&
                node.scrollHeight > node.clientHeight + 50;
            if (canScroll) return node;
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement || document.body;
    };

    const tryFocus = () => {
        try {
            document.body?.focus?.();
        } catch {
            // ignore
        }
        return true;
    };

    const dispatchKey = (key) => {
        const evtDown = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
        const evtUp = new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true });
        document.dispatchEvent(evtDown);
        window.dispatchEvent(evtDown);
        document.dispatchEvent(evtUp);
        window.dispatchEvent(evtUp);
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

        // 找不到下一条 item，尝试滚动容器
        const scroller = findScrollableAncestor(currentItem);
        const before = scroller?.scrollTop ?? 0;
        const delta = Math.max(450, Math.floor(window.innerHeight * 0.95));
        try {
            scroller.scrollBy({ top: delta, left: 0, behavior: 'smooth' });
        } catch {
            scroller.scrollTop = before + delta;
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

    const focused = tryFocus();
    const byItem = tryScrollToNextItem();
    // 兜底：某些版本会监听键盘/滚轮
    dispatchKey('ArrowDown');
    dispatchKey('PageDown');
    const scrolled = tryScroll();
    return { ok: Boolean(byItem || scrolled || focused), by_item: Boolean(byItem) };
}

async function postComment(text) {
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };
    const clickFirstVisible = (selectors) => {
        for (const sel of selectors) {
            let els = [];
            try {
                els = Array.from(document.querySelectorAll(sel));
            } catch {
                continue;
            }
            const hit = els.find(isVisible);
            if (hit) {
                hit.click();
                return true;
            }
        }
        return false;
    };

    const input = document.querySelector('[data-e2e="comment-input"]') || document.querySelector('textarea');
    if (!input) return { ok: false, reason: 'no_input' };

    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const ok = clickFirstVisible([
        '[data-e2e="comment-post"]',
        'button[aria-label*="post" i]',
        'button[aria-label*="发送" i]',
    ]);
    return { ok };
}

// ===========================
// Python comm
// ===========================

async function sendToPython(data) {
    try {
        const response = await fetch(`http://localhost:${PORT}/data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const resData = await response.json().catch(() => ({}));

        if (resData.command) void executeIncomingCommand(resData.command);
        if (Array.isArray(resData.commands)) {
            for (const c of resData.commands) void executeIncomingCommand(c);
        }
        return true;
    } catch (e) {
        logToUI(`POST /data 失败: ${e.message}`, 'error');
        return false;
    }
}

let isProcessingCommand = false;
let pendingCommands = [];
let currentCommandType = '';
let monitorCancelToken = 0;

async function executeIncomingCommand(cmd) {
    if (!cmd) return;

    const cmdType = String(cmd?.type || '').toLowerCase();
    const isMonitorCmd = cmdType === 'monitor_next' || cmdType === 'next_video';

    if (isProcessingCommand) {
        const curIsMonitor = currentCommandType === 'monitor_next' || currentCommandType === 'next_video';

        // 监控播完过程中，收到动作指令：取消监控并优先执行动作，避免“点了没反应”。
        if (curIsMonitor && !isMonitorCmd) {
            monitorCancelToken += 1;
            pendingCommands.unshift(cmd);
            logToUI(`⏹️ 取消监控，优先执行: ${cmdType || 'unknown'}`, 'warn');
            return;
        }

        pendingCommands.push(cmd);
        logToUI(`⏸️ 排队指令: ${cmdType || 'unknown'} (忙碌中)`, 'warn');
        return;
    }

    isProcessingCommand = true;
    currentCommandType = cmdType;
    try {
        updateLatestCmdUI(cmd);
        logToUI(`收到指令: ${cmd.type || JSON.stringify(cmd)}`, 'cmd');
        await handleCommand(cmd);
    } catch (e) {
        logToUI(`执行指令失败: ${e.message}`, 'error');
    } finally {
        isProcessingCommand = false;
        currentCommandType = '';
        if (pendingCommands.length > 0) {
            const next = pendingCommands.shift();
            setTimeout(() => void executeIncomingCommand(next), 0);
        }
    }
}

async function handleCommand(cmd) {
    const type = (cmd?.type || '').toLowerCase();
    const payload = cmd?.payload || cmd?.data || {};

    const tab = await getCurrentTab();
    if (!tab?.id) throw new Error('no_active_tab');

    const run = async (fn, args = []) => {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: fn,
            args,
        });
        return results?.[0]?.result;
    };

    if (type === 'open_comments') {
        const r = await run(openComments);
        logToUI(r?.ok ? '已尝试打开评论区' : '打开评论区失败/未命中按钮', r?.ok ? 'success' : 'warn');
        return;
    }

    if (type === 'link_test') {
        // 仅用于诊断链路是否畅通
        logToUI('收到 link_test：链路正常', 'success');
        return;
    }

    if (type === 'like_video' || type === 'like') {
        const r = await run(likeVideo);
        if (r?.ok) {
            const pressed = (r?.beforePressed || r?.afterPressed) ? ` pressed ${r?.beforePressed || '-'}→${r?.afterPressed || '-'}` : '';
            const toggled = (r?.toggled === true) ? ' toggled=YES' : (r?.toggled === false ? ' toggled=NO' : '');
            const liked = (typeof r?.likedState === 'boolean') ? ` liked=${r.likedState ? 'YES' : 'NO'}` : '';
            const sel = r?.selector ? ` sel=${r.selector}` : '';
            const dlg = r?.hasDialog ? ' dialog=YES(可能登录/拦截)' : '';
            logToUI(`已尝试点赞${sel}${pressed}${toggled}${liked}${dlg}`, (r?.toggled === false || r?.hasDialog) ? 'warn' : 'success');
        } else {
            logToUI(`点赞失败: ${r?.reason || '未命中按钮'}`, 'warn');
        }
        return;
    }

    if (type === 'like_top_comment') {
        const r = await run(likeTopCommentTikTokPage);
        logToUI(r?.ok ? '已尝试高赞点赞' : `高赞点赞失败: ${r?.reason || 'unknown'}`, r?.ok ? 'success' : 'warn');
        return;
    }

    if (type === 'like_comment') {
        const idxRaw = cmd?.index ?? payload?.index ?? payload?.comment_index ?? payload?.commentIndex ?? 1;
        const idx = Math.max(1, Math.min(50, Number(idxRaw) || 1));
        const matchText =
            payload?.match_text ||
            payload?.matchText ||
            payload?.comment_text ||
            cmd?.match_text ||
            cmd?.matchText ||
            cmd?.comment_text ||
            cmd?.text ||
            '';
        const r = await run(likeCommentMatchTikTokPage, [matchText, idx]);
        logToUI(
            r?.ok ? `已尝试点赞评论 #${idx}${r?.matched ? ' (已匹配)' : ' (按序号)'}` : `点赞评论失败(#${idx}): ${r?.reason || 'unknown'}`,
            r?.ok ? 'success' : 'warn'
        );
        return;
    }

    if (type === 'like_top_comment') {
        const r = await run(likeTopCommentTikTokPage);
        logToUI(r?.ok ? '已尝试高赞点赞' : `高赞点赞失败: ${r?.reason || 'unknown'}`, r?.ok ? 'success' : 'warn');
        return;
    }

    if (type === 'like_comment') {
        const idxRaw = cmd?.index ?? payload?.index ?? payload?.comment_index ?? payload?.commentIndex ?? 1;
        const idx = Math.max(1, Math.min(50, Number(idxRaw) || 1));
        const matchText =
            payload?.match_text ||
            payload?.matchText ||
            payload?.comment_text ||
            cmd?.match_text ||
            cmd?.matchText ||
            cmd?.comment_text ||
            cmd?.text ||
            '';
        const r = await run(likeCommentMatchTikTokPage, [matchText, idx]);
        logToUI(
            r?.ok ? `已尝试点赞评论 #${idx}${r?.matched ? ' (已匹配)' : ' (按序号)'}` : `点赞评论失败(#${idx}): ${r?.reason || 'unknown'}`,
            r?.ok ? 'success' : 'warn'
        );
        return;
    }

    if (type === 'subscribe' || type === 'subscribe_channel') {
        const r = await run(subscribe);
        logToUI(r?.ok ? '已尝试关注' : '关注失败/未命中按钮', r?.ok ? 'success' : 'warn');
        return;
    }

    if (type === 'next_video' || type === 'monitor_next') {
        const watchLimitRaw =
            cmd?.watchLimit ??
            cmd?.watch_limit ??
            payload?.watchLimit ??
            payload?.watch_limit ??
            payload?.watch_limit_seconds ??
            0;
        const watchLimitSec = Math.max(0, Number(watchLimitRaw) || 0);

        const reasonRaw =
            cmd?.reason ??
            payload?.reason ??
            payload?.skip_reason ??
            payload?.skipReason ??
            '';
        const reason = String(reasonRaw || '').slice(0, 80);

        const formatSec = (n) => {
            const s = Math.max(0, Math.floor(Number(n) || 0));
            const m = Math.floor(s / 60);
            const r = s % 60;
            return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
        };

        const setPopupMonitorHint = (text) => {
            try {
                const el = document.getElementById('monitor-hint');
                if (!el) return;
                el.textContent = String(text || '');
            } catch {
                // ignore
            }
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

        // 监控播放进度：
        // - watchLimitSec > 0: 看 N 秒/看完(>=300) 再跳
        // - watchLimitSec = 0: 默认看至接近结束再跳（对应“点赞了就播完下一个”）
        const info0 = await run(extractTargetText).catch(() => null);
        const dur0 = Number(info0?.duration || 0);
        const isWatchAllHint = watchLimitSec >= 300;

        let safeTarget = 0;
        let fallbackTarget = 0;
        if (watchLimitSec > 0) {
            const targetSec = dur0 > 0 ? (isWatchAllHint ? dur0 : Math.min(watchLimitSec, dur0)) : (isWatchAllHint ? 15 : watchLimitSec);
            // watchLimit 可能来自 3600("看完")，这里放宽上限，避免长视频被过早截断
            safeTarget = Math.max(1, Math.min(3600, targetSec));
            fallbackTarget = safeTarget;
        } else {
            // 未指定 watchLimit：默认“看完”语义（duration 不可得时降级为 15s）
            safeTarget = dur0 > 0 ? Math.max(1, Math.min(3600, dur0)) : 15;
            fallbackTarget = safeTarget;
        }

        await showOverlay(
            `TikTok 监控播放中...${reason ? ` (${reason})` : ''}`,
            'info'
        );
        setPopupMonitorHint(
            `监控: ${watchLimitSec > 0 ? `倒计时 ${formatSec(Math.max(0, safeTarget - Number(info0?.current || 0)))}` : '等待播完'} (原因: ${reason || '-'})`
        );

        const myToken = monitorCancelToken;

        const startTs = Date.now();
        let lastCur = null;
        let stuckTicks = 0;
        let missTicks = 0;

        while (true) {
            if (myToken !== monitorCancelToken) {
                await showOverlay('已取消监控：收到新的动作指令，准备执行...', 'warn');
                setPopupMonitorHint('监控: 已取消(执行新指令)');
                break;
            }

            const info = await run(extractTargetText).catch(() => null);
            const cur = Number(info?.current || 0);
            const dur = Number(info?.duration || 0);
            const elapsed = (Date.now() - startTs) / 1000;

            if (!info) {
                missTicks += 1;
            } else {
                missTicks = 0;
            }

            if (lastCur !== null && Math.abs(cur - lastCur) < 0.1) {
                stuckTicks += 1;
            } else {
                stuckTicks = 0;
            }
            lastCur = cur;

            // 目标判断
            if (watchLimitSec > 0) {
                const target = dur > 0 ? Math.min(safeTarget, dur) : safeTarget;
                if (dur > 0 && cur >= target) break;
                if (dur <= 0 && elapsed >= target) break;
            } else {
                // 看至接近结束
                if (dur > 0 && cur >= Math.max(1, dur - 1)) break;
                if (dur <= 0 && elapsed >= fallbackTarget) break;
            }

            // 卡住/取不到进度：避免无限等待
            if (stuckTicks >= 8) {
                await showOverlay(
                    `TikTok 监控播放中...${reason ? `\n原因: ${reason}` : ''}\n检测到进度卡住，准备跳转\n进度: ${formatSec(cur)} / ${dur > 0 ? formatSec(dur) : '未知'}`,
                    'warn'
                );
                break;
            }
            if (missTicks >= 6) {
                await showOverlay(
                    `TikTok 监控播放中...${reason ? `\n原因: ${reason}` : ''}\n无法读取进度，准备跳转`,
                    'warn'
                );
                break;
            }

            // 弹窗倒计时提示（不刷 log，只更新一行状态）
            if (watchLimitSec > 0) {
                const target = dur > 0 ? Math.min(safeTarget, dur) : safeTarget;
                setPopupMonitorHint(
                    `监控: 倒计时 ${formatSec(Math.max(0, target - cur))} (原因: ${reason || '-'})`
                );
            } else {
                if (dur > 0) {
                    setPopupMonitorHint(
                        `监控: 等待播完(剩余 ${formatSec(Math.max(0, dur - cur))}) (原因: ${reason || '-'})`
                    );
                } else {
                    setPopupMonitorHint(
                        `监控: 等待播完(未知时长) (原因: ${reason || '-'})`
                    );
                }
            }

            await showOverlay(
                `TikTok 监控播放中...${reason ? `\n原因: ${reason}` : ''}\n目标: ${watchLimitSec > 0 ? `观看 ${formatSec(safeTarget)}` : '播放完成'}\n进度: ${formatSec(cur)} / ${dur > 0 ? formatSec(dur) : '未知'}`,
                'info'
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        await hideOverlay();
        setPopupMonitorHint('监控: 跳转中...');

        logToUI(
            watchLimitSec > 0
                ? `监控跳转：已等待观看 ${safeTarget}s，准备切到下一个视频`
                : '监控跳转：检测到接近播放结束/到达降级阈值，准备切到下一个视频',
            'info'
        );

        const before = await run(extractTargetText).catch(() => null);
        const beforeKey = `${before?.videoId || ''}|${before?.href || ''}|${before?.duration || 0}`;

        const r1 = await run(nextVideo);
        await new Promise((resolve) => setTimeout(resolve, 900));
        const after1 = await run(extractTargetText).catch(() => null);
        const afterKey1 = `${after1?.videoId || ''}|${after1?.href || ''}|${after1?.duration || 0}`;

        if (afterKey1 && afterKey1 !== beforeKey) {
            logToUI(r1?.by_item ? '已切到下一个视频(滚动列表)' : '已切到下一个视频', 'success');
            return;
        }

        // 未变化：再重试一次（部分页面需要更长滚动/二次吸附）
        const r2 = await run(nextVideo);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const after2 = await run(extractTargetText).catch(() => null);
        const afterKey2 = `${after2?.videoId || ''}|${after2?.href || ''}|${after2?.duration || 0}`;

        if (afterKey2 && afterKey2 !== beforeKey) {
            logToUI(r2?.by_item ? '已切到下一个视频(滚动列表/重试)' : '已切到下一个视频(重试)', 'success');
            setPopupMonitorHint('监控: -');
        } else {
            // 第三次兜底：简单 ArrowDown
            try {
                const r3 = await run(nextVideoTikTok);
                await new Promise((resolve) => setTimeout(resolve, 1200));
                const after3 = await run(extractTargetText).catch(() => null);
                const afterKey3 = `${after3?.videoId || ''}|${after3?.href || ''}|${after3?.duration || 0}`;
                if (afterKey3 && afterKey3 !== beforeKey) {
                    logToUI(r3?.success ? '已切到下一个视频(键盘兜底)' : '已切到下一个视频(兜底)', 'success');
                    setPopupMonitorHint('监控: -');
                    return;
                }
            } catch {
                // ignore
            }

            logToUI('下一个视频未生效：可能是直播/广告/页面未聚焦/正在加载', 'warn');
            setPopupMonitorHint('监控: 跳转失败(可重试)');
        }
        return;
    }

    if (type === 'auto_comment') {
        const text = payload?.text || payload?.comment || cmd?.text || '';
        const r = await run(postComment, [text]);
        logToUI(r?.ok ? '已尝试发表评论' : `发表评论失败: ${r?.reason || 'unknown'}`, r?.ok ? 'success' : 'warn');
        return;
    }

    logToUI(`未知指令: ${type || JSON.stringify(cmd)}`, 'warn');
}

async function pollPythonCommands() {
    try {
        const response = await fetch(`http://localhost:${PORT}/poll?ready=true`);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        updateStatus('已连接', '#69db7c');

        const data = await response.json().catch(() => ({}));
        if (data.command) void executeIncomingCommand(data.command);
        if (Array.isArray(data.commands)) {
            for (const c of data.commands) void executeIncomingCommand(c);
        }
    } catch {
        updateStatus('连接失败', '#ff6b6b');
    } finally {
        setTimeout(() => void pollPythonCommands(), 200);
    }
}

let lastAutoKey = '';

async function updateTitleAndMaybeSend() {
    try {
        const tab = await getCurrentTab();
        if (!tab?.id) return;
        const tabUrl = (() => {
            try {
                return String(tab.url || tab.pendingUrl || '');
            } catch {
                return '';
            }
        })();
        if (!tabUrl) return;
        if (!tabUrl.includes('tiktok.com')) return;

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractTargetText,
        });

        const r = results?.[0]?.result;
        const title = r?.title || '等待检测视频...';
        const current = r?.current || 0;
        const duration = r?.duration || 0;

        updateLoopCountForTime({ url: tabUrl, title, current, duration });
        updateTitleUI(title);
        updateTimeUI(current, duration);

        const key = `${tabUrl || ''}|${title}`;
        if (!tabUrl || key === lastAutoKey) return;
        lastAutoKey = key;
    } catch {
        // 避免出现 Uncaught (in promise) 打断后续逻辑
    }
}

let lastCaptureSig = '';
let lastCaptureTs = 0;

let _tk_lastFilteredKey = '';
let _tk_lastFilteredAt = 0;

let _tk_noCommentKey = '';
let _tk_noCommentFirstAt = 0;
let _tk_noCommentHits = 0;

let _tk_openCommentsAttemptKey = '';
let _tk_openCommentsAttemptAt = 0;

function _tk_parseCountToIntForFilter(value) {
    if (value === null || value === undefined) return 0;
    let s = String(value).trim();
    if (!s) return 0;

    s = s.replace(/,/g, '').replace(/\s+/g, '').toUpperCase();
    const m = s.match(/^([0-9]+(?:\.[0-9]+)?)([KMB])?$/);
    if (!m) {
        const m2 = s.match(/(\d+)/);
        return m2 ? Number(m2[1]) : 0;
    }

    let num = Number(m[1]) || 0;
    const unit = m[2] || '';
    if (unit === 'K') num *= 1000;
    if (unit === 'M') num *= 1000000;
    if (unit === 'B') num *= 1000000000;
    return Math.floor(num);
}

function _tk_filterLowQualityVideoForAuto(extraData) {
    const likeRaw = extraData?.like_count ?? extraData?.likes ?? extraData?.digg_count;
    const commentRaw = extraData?.comment_count ?? extraData?.comments_count;

    const likeCount = _tk_parseCountToIntForFilter(likeRaw);
    const commentCount = _tk_parseCountToIntForFilter(commentRaw);

    // 没有指标就不做过滤，避免误杀
    if (likeCount <= 0 && commentCount <= 0) return null;

    // 与 Python 端保持一致
    const rand13 = () => Math.floor(Math.random() * 3) + 1;
    if (likeCount < 100) return { reason: '点赞极少', watchLimit: rand13() };
    if (likeCount < 500) return { reason: '点赞较少', watchLimit: rand13() };
    if (likeCount < 1000) return { reason: '点赞一般', watchLimit: 10 };
    if (commentCount > 0 && commentCount < 50) return { reason: '高赞低评', watchLimit: 3600 };

    return null;
}

async function autoCaptureLight() {
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
    if (!tabUrl) return;
    if (!tabUrl.includes('tiktok.com')) return;

    // 执行 monitor_next 时，避免自动采集反复触发过滤/上报
    try {
        if (typeof isProcessingCommand !== 'undefined' && isProcessingCommand) return;
    } catch {
        // ignore
    }

    // 采集前：检测并尝试打开评论区；如果尝试后仍检测不到评论区（无输入框且无评论列表），判定疑似广告/直播，直接跳过。
    // 注意：只在同一视频上限频尝试，避免反复点开/打扰；openComments是toggle，已打开就不点击。
    try {
        const key = `${tabUrl || ''}`;
        const now0 = Date.now();
        const shouldAttempt = key !== _tk_openCommentsAttemptKey || (now0 - (_tk_openCommentsAttemptAt || 0)) > 8000;
        if (shouldAttempt) {
            _tk_openCommentsAttemptKey = key;
            _tk_openCommentsAttemptAt = now0;

            // 1) 先检测评论区是否已打开
            let check = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: detectCommentAreaTikTok,
            }).catch(() => null);
            let st = check?.[0]?.result;

            // 2) 如果评论区未打开（无输入框且无列表），点击评论按钮
            if (st && st.ok && !st.has_input && !st.has_list) {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: openComments,
                }).catch(() => null);

                // 3) 等待一点时间让弹层渲染
                await new Promise((r) => setTimeout(r, 350));

                // 4) 再次检测评论区是否存在
                check = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: detectCommentAreaTikTok,
                }).catch(() => null);
                st = check?.[0]?.result;

                if (st && st.ok && !st.has_input && !st.has_list) {
                    // 再给一次机会：部分页面首次点击需要更久
                    await new Promise((r) => setTimeout(r, 650));
                    check = await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: detectCommentAreaTikTok,
                    }).catch(() => null);
                    st = check?.[0]?.result;
                }

                if (st && st.ok && !st.has_input && !st.has_list) {
                    logToUI('🚫 已尝试打开评论区但仍不可用：疑似广告/直播，直接跳过', 'warn');
                    void executeIncomingCommand({
                        type: 'monitor_next',
                        reason: 'no_comment_area_after_open',
                        watchLimit: 1,
                    });
                    return;
                }
            }
        }
    } catch {
        // ignore
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: getLightPageData,
        });
        const data = results?.[0]?.result;
        if (!data) return;

        data.url = tabUrl;

        const current = data.extra_data?.current_time || 0;
        const duration = data.extra_data?.duration || 0;
        updateLoopCountForTime({ url: data.url, title: data.title, current, duration });

        // UI 始终刷新
        updateTitleUI(data.title);
        updateTimeUI(current, duration);
        updateCommentsDisplay(data.extra_data?.comments || []);

        // 疑似广告/直播/评论不可用：抓不到评论，且指标/时长异常 -> 直接跳过（不上传 Python）
        try {
            const commentsArr = Array.isArray(data.extra_data?.comments) ? data.extra_data.comments : [];
            const likeCount = _tk_parseCountToIntForFilter(data.extra_data?.like_count);
            const commentCount = _tk_parseCountToIntForFilter(data.extra_data?.comment_count);
            const dur = Number(data.extra_data?.duration || 0);

            const key = `${data.url || ''}|${data.title || ''}`;
            const noCommentsNow = commentsArr.length === 0 && commentCount === 0;
            const suspiciousNow = noCommentsNow && (dur <= 0 || likeCount <= 0);

            if (suspiciousNow) {
                if (key !== _tk_noCommentKey) {
                    _tk_noCommentKey = key;
                    _tk_noCommentFirstAt = Date.now();
                    _tk_noCommentHits = 1;
                } else {
                    _tk_noCommentHits += 1;
                }

                const elapsedMs = Date.now() - (_tk_noCommentFirstAt || Date.now());
                // 连续命中几次 & 经过一点等待，避免刚切视频就误杀
                if (_tk_noCommentHits >= 4 && elapsedMs >= 4000) {
                    logToUI('🚫 疑似广告/直播/评论不可用：跳过该视频', 'warn');
                    void executeIncomingCommand({
                        type: 'monitor_next',
                        reason: 'suspected_ad_or_live',
                        watchLimit: 1,
                    });
                    return;
                }
            } else {
                // reset
                if (key !== _tk_noCommentKey) {
                    _tk_noCommentKey = key;
                }
                _tk_noCommentFirstAt = 0;
                _tk_noCommentHits = 0;
            }
        } catch {
            // ignore
        }

        const comments = Array.isArray(data.extra_data?.comments) ? data.extra_data.comments : [];
        const commentsSig = comments
            .slice(0, 3)
            .map((c) => `${c?.author || ''}:${c?.content || ''}:${c?.likes || ''}`)
            .join('|');
        const sig = `${data.url || ''}|${data.title || ''}|${commentsSig}`;

        // 避免高频重复上报：有变化才发；另外给一个 10s 的保底
        const now = Date.now();
        const shouldSend = sig !== lastCaptureSig || now - lastCaptureTs > 10_000;
        if (!shouldSend) return;

        lastCaptureSig = sig;
        lastCaptureTs = now;

        data.extra_data = {
            ...(data.extra_data || {}),
            loop_count: currentLoopCount,
            loop_threshold: LOOP_THRESHOLD,
        };

        // 插件端低质量筛选：命中则直接跳过，不上报 Python
        const filterHit = _tk_filterLowQualityVideoForAuto(data.extra_data);
        if (filterHit) {
            const key = `${data.url || ''}|${data.title || ''}|${filterHit.reason}`;
            // 10s 内同一条避免重复触发（monitor_next 会等待一段时间）
            if (key !== _tk_lastFilteredKey || now - _tk_lastFilteredAt > 10_000) {
                _tk_lastFilteredKey = key;
                _tk_lastFilteredAt = now;
                const likeCount = _tk_parseCountToIntForFilter(data.extra_data?.like_count);
                const commentCount = _tk_parseCountToIntForFilter(data.extra_data?.comment_count);
                logToUI(`🚫 已过滤: ${filterHit.reason} (👍${likeCount}, 💬${commentCount})`, 'warn');

                // 直接在插件端触发 monitor_next（watchLimit 由插件端执行等待/播完逻辑）
                void executeIncomingCommand({
                    type: 'monitor_next',
                    reason: `filtered:${filterHit.reason}`,
                    watchLimit: filterHit.watchLimit,
                });
            }
            return;
        }

        await sendToPython(data);
        logToUI('✅ 自动采集并发送视频数据', 'success');
    } catch {
        // 静默：避免刷屏
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
    const tabUrl = (() => {
        try {
            return String(tab.url || tab.pendingUrl || '');
        } catch {
            return '';
        }
    })();
    if (!tabUrl) return;
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

// ===========================
// Init
// ===========================

document.addEventListener('DOMContentLoaded', async () => {
    logToUI(`插件已加载 (BUILD_ID=${BUILD_ID})`, 'info');
    updateStatus('正在连接...', '#ddd');

    const btnCapture = document.getElementById('btn-capture');
    const btnTest = document.getElementById('btn-test');

    if (btnCapture) {
        btnCapture.addEventListener('click', async () => {
            const tab = await getCurrentTab();
            if (!tab?.id) {
                logToUI('未找到活动标签页', 'error');
                return;
            }
            logToUI('捕获当前视频...', 'info');
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: getLightPageData,
                });
                const data = results?.[0]?.result;
                if (!data) {
                    logToUI('未获取到页面数据', 'warn');
                    return;
                }
                data.url = tab.url;

                const current = data.extra_data?.current_time || 0;
                const duration = data.extra_data?.duration || 0;
                updateLoopCountForTime({ url: data.url, title: data.title, current, duration });

                updateTitleUI(data.title);
                updateTimeUI(current, duration);
                updateCommentsDisplay(data.extra_data?.comments || []);

                data.extra_data = {
                    ...(data.extra_data || {}),
                    loop_count: currentLoopCount,
                    loop_threshold: LOOP_THRESHOLD,
                };

                // 手动捕获也做低质量筛选（命中则不上传，直接插件端跳过）
                const filterHit = _tk_filterLowQualityVideoForAuto(data.extra_data);
                if (filterHit) {
                    const likeCount = _tk_parseCountToIntForFilter(data.extra_data?.like_count);
                    const commentCount = _tk_parseCountToIntForFilter(data.extra_data?.comment_count);
                    logToUI(`🚫 已过滤: ${filterHit.reason} (👍${likeCount}, 💬${commentCount})`, 'warn');
                    void executeIncomingCommand({
                        type: 'monitor_next',
                        reason: `filtered:${filterHit.reason}`,
                        watchLimit: filterHit.watchLimit,
                    });
                    return;
                }

                await sendToPython(data);
                logToUI('✅ 已发送视频数据', 'success');
            } catch (e) {
                logToUI(`捕获失败: ${e.message}`, 'error');
            }
        });
    }

    if (btnTest) {
        btnTest.addEventListener('click', async () => {
            logToUI('👍 测试：尝试给热门评论点赞...', 'info');
            try {
                const tab = await getCurrentTab();
                if (!tab?.id) throw new Error('no_active_tab');

                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: likeTopCommentTikTokPage,
                });
                const r = results?.[0]?.result;
                if (r?.ok) {
                    logToUI(
                        `✅ 点赞测试完成：items=${r.commentItemsCount} pressed ${r.beforePressed}→${r.afterPressed} toggled=${r.toggled} count ${r.beforeCountText}→${r.afterCountText}`,
                        'success'
                    );
                } else {
                    logToUI(`⚠️ 点赞失败: ${r?.reason || 'unknown'} ${r ? JSON.stringify(r) : ''}`, 'warn');
                }
            } catch (e) {
                logToUI(`❌ 点赞测试异常: ${e.message}`, 'error');
            }
        });
    }

    await updateTitleAndMaybeSend().catch(() => {});
    setInterval(() => {
        updateTitleAndMaybeSend().catch(() => {});
    }, 1000);

    // 自动化：无需点击“捕获当前视频”，持续采集并在变化时自动上报
    autoCaptureLight().catch(() => {});
    setInterval(() => {
        autoCaptureLight().catch(() => {});
    }, 1500);

    // 自动化：元素检测状态刷新
    updateElementDetection().catch(() => {});
    setInterval(() => {
        updateElementDetection().catch(() => {});
    }, 1500);

    void pollPythonCommands();
});

// ===========================
// END (important): 本文件必须只包含这一份实现。
// ===========================

/*
 * 下方为历史残留/重复实现（曾导致：Unexpected token '}' / Illegal return / 重复声明）。
 * 已整体注释掉，确保 popup.js 只有一份可执行实现。


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

// ===========================
// Tab helper
// ===========================

async function getCurrentTab() {
    const urlParams = new URLSearchParams(window.location.search);
    const targetWindowId = urlParams.get('targetWindowId');

    if (targetWindowId) {
        const tabs = await chrome.tabs.query({
            active: true,
            windowId: Number.parseInt(targetWindowId, 10),
        });
        return tabs[0];
    }

    const tabs = await chrome.tabs.query({ active: true });
    return tabs.find(
        (t) =>
            t.url &&
            !t.url.startsWith('chrome-extension://') &&
            !t.url.startsWith('devtools://')
    );
}

// ===========================
// Page injected helpers
// ===========================

function _tk_isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
}

function _tk_getActiveContainer() {
    const videos = Array.from(document.querySelectorAll('video'));
    let bestVideo = null;
    let maxScore = -1;

    videos.forEach((v) => {
        const rect = v.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);

        let score = visibleArea;
        if (!v.paused) score *= 1.5;
        if (score > maxScore) {
            maxScore = score;
            bestVideo = v;
        }
    });

    if (bestVideo) {
        return bestVideo.closest('[data-e2e="recommend-list-item-container"]') || document;
    }
    return document;
}

function extractTargetText() {
    let title = '等待检测视频...';
    let current = 0;
    let duration = 0;

    if (!window.location.hostname.includes('tiktok.com')) {
        return { title, current, duration };
    }

    const activeRoot = _tk_getActiveContainer();
    const isGlobalScope = activeRoot === document;

    const isValidText = (el) => el && (el.innerText || el.textContent) && (el.innerText || el.textContent).trim().length > 0;

    let descEl = null;
    if (isGlobalScope) {
        const descs = Array.from(document.querySelectorAll('[data-e2e="video-desc"]'));
        descEl = descs.find(_tk_isVisible);
    } else {
        descEl = activeRoot.querySelector('[data-e2e="video-desc"]');
    }

    if (isValidText(descEl)) {
        title = (descEl.innerText || descEl.textContent).trim();
    } else if (isGlobalScope) {
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc && metaDesc.content) title = metaDesc.content;
    }

    const video = isGlobalScope ? document.querySelector('video') : activeRoot.querySelector('video');
    if (video && !Number.isNaN(video.duration)) {
        current = Math.round(video.currentTime || 0);
        duration = Math.round(video.duration || 0);
    }

    return { title, current, duration };
}

function getLightPageData() {
    // WARNING: 此函数也可能被注入执行，必须自包含。
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

    let title = '等待检测视频...';
    let current = 0;
    let duration = 0;
    let likeCountStr = '0';
    let commentCountStr = '0';

    const getActiveContainer = () => {
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
            if (!v.paused) score *= 1.5;
            if (score > maxScore) {
                maxScore = score;
                bestVideo = v;
            }
        }

        if (bestVideo) {
            return bestVideo.closest('[data-e2e="recommend-list-item-container"]') || document;
        }
        return document;
    };

    if (window.location.hostname.includes('tiktok.com')) {
        const activeRoot = getActiveContainer();
        const isGlobalScope = activeRoot === document;

        const isValidText = (el) => {
            const t = el ? (el.innerText || el.textContent || '') : '';
            return t.trim().length > 0;
        };

        let descEl = null;
        if (isGlobalScope) {
            const descs = Array.from(document.querySelectorAll('[data-e2e="video-desc"]'));
            descEl = descs.find(isVisible);
        } else {
            descEl = activeRoot.querySelector('[data-e2e="video-desc"]');
        }

        if (isValidText(descEl)) {
            title = (descEl.innerText || descEl.textContent).trim();
        } else if (isGlobalScope) {
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc && metaDesc.content) title = metaDesc.content;
        }

        const video = isGlobalScope ? document.querySelector('video') : activeRoot.querySelector('video');
        if (video && !Number.isNaN(video.duration)) {
            current = Math.round(video.currentTime || 0);
            duration = Math.round(video.duration || 0);
        }

        const findVisibleIn = (root, selector) => {
            try {
                const els = Array.from((root || document).querySelectorAll(selector));
                return els.find(isVisible) || null;
            } catch {
                return null;
            }
        };
        const likeEl = isGlobalScope
            ? findVisibleIn(document, '[data-e2e="like-count"]')
            : (activeRoot.querySelector('[data-e2e="like-count"]') || findVisibleIn(document, '[data-e2e="like-count"]'));
        const cmtEl = isGlobalScope
            ? findVisibleIn(document, '[data-e2e="comment-count"]')
            : (activeRoot.querySelector('[data-e2e="comment-count"]') || findVisibleIn(document, '[data-e2e="comment-count"]'));
        if (likeEl && (likeEl.innerText || likeEl.textContent)) likeCountStr = (likeEl.innerText || likeEl.textContent).trim();
        if (cmtEl && (cmtEl.innerText || cmtEl.textContent)) commentCountStr = (cmtEl.innerText || cmtEl.textContent).trim();
    }

    // 评论：向下扫描一些，跳过空内容，尽量凑够 3 条文本评论
    const comments = [];
    if (window.location.hostname.includes('tiktok.com')) {
        const commentItems = Array.from(document.querySelectorAll('[class*="DivCommentItemWrapper"]')).filter(isVisible);
        for (const item of commentItems.slice(0, 30)) {
            const authorEl = item.querySelector('[data-e2e="comment-username-1"]') || item.querySelector('a[href^="/@"]');
            const contentEl = item.querySelector('[data-e2e="comment-level-1"]') || item.querySelector('p[class*="TUXText"]');
            const likeContainer = item.querySelector('[class*="DivLikeContainer"]');
            const likesStr = likeContainer ? (likeContainer.querySelector('span')?.innerText || '0') : '0';
            const author = authorEl ? (authorEl.innerText || authorEl.textContent || '').trim() : 'User';
            const content = contentEl ? (contentEl.innerText || contentEl.textContent || '').trim() : '';
            if (!content) continue;
            comments.push({ author, content, likes: likesStr });
            if (comments.length >= 3) break;
        }
    }

    return {
        title: title || '',
        url: window.location.href,
        platform: 'tiktok',
        html: '',
        extra_data: {
            comments,
            has_input: false,
            like_count: likeCountStr,
            comment_count: commentCountStr,
            duration,
            current_time: current,
        },
    };
}

function _tk_clickFirstVisible(selectors) {
    for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel));
        const hit = els.find(_tk_isVisible);
        if (hit) {
            hit.click();
            return true;
        }
    }
    return false;
}

function openComments() {
    // 尽量点击“评论”按钮
    const ok = _tk_clickFirstVisible([
        '[data-e2e="comment-icon"]',
        '[data-e2e="comment-button"]',
        'button[aria-label*="comment" i]',
        'button[aria-label*="评论" i]',
    ]);
    return { ok };
}

function likeVideo() {
    // Robust click with elementFromPoint (Self-contained)
    const clickAtCenter = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x <= 0 || y <= 0) return false;

        const target = document.elementFromPoint(x, y) || el;
        const common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1 };
        
        const fire = (type, Ctor) => { try { target.dispatchEvent(new Ctor(type, common)); } catch(e){} };
        
        fire('pointermove', PointerEvent);
        fire('mousemove', MouseEvent);
        fire('pointerdown', PointerEvent);
        fire('mousedown', MouseEvent);
        fire('pointerup', PointerEvent);
        fire('mouseup', MouseEvent);
        fire('click', MouseEvent);
        try { el.click(); } catch(e){}
        return true;
    };

    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

    const selectors = [
        '[data-e2e="like-icon"]',
        'button[aria-label*="like" i]',
        'button[aria-label*="喜欢" i]',
        'span[data-e2e="like-icon"]'
    ];

    for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel));
        const hit = els.find(isVisible);
        if (hit) {
            clickAtCenter(hit);
            return { ok: true };
        }
    }
    return { ok: false };
}

function subscribe() {
    // TikTok 的关注按钮结构会变，这里尽量用通用文本/aria
    const ok = _tk_clickFirstVisible([
        'button[data-e2e="follow-button"]',
        'button[aria-label*="follow" i]',
        'button:has(span:contains("Follow"))',
    ]);
    return { ok };
}

function nextVideo() {
    // 下一个视频：滚轮/键盘方式更稳
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
    return { ok: true };
}

function postComment(text) {
    // TikTok 评论输入区通常是 Draft.js 的 contenteditable，不是 textarea。
    const container = document.querySelector('[data-e2e="comment-input"]');
    const editor =
        (container && container.querySelector('[contenteditable="true"][role="textbox"]')) ||
        document.querySelector('[data-e2e="comment-text"] [contenteditable="true"][role="textbox"]') ||
        document.querySelector('[contenteditable="true"][role="textbox"].public-DraftEditor-content') ||
        document.querySelector('textarea');

    const detectCommentsOff = () => {
        const needles = [
            'comments are turned off',
            'comments off',
            'comment off',
            '评论已关闭',
            '已关闭评论',
            '关闭了评论',
            '评论功能已关闭',
        ];
        const candidates = Array.from(document.querySelectorAll('div,span,p')).slice(0, 2000);
        for (const el of candidates) {
            const t = (el.innerText || el.textContent || '').trim();
            if (!t) continue;
            const lower = t.toLowerCase();
            if (needles.some((n) => lower.includes(n))) return true;
        }
        return false;
    };

    if (!editor) {
        const hasPostBtn = Boolean(document.querySelector('[data-e2e="comment-post"]'));
        const hasCommentBtn = Boolean(
            document.querySelector('[data-e2e="feed-comment-icon"], [data-e2e="comment-icon"], [data-e2e="comment-button"]')
        );
        const commentsOff = detectCommentsOff();
        return {
            ok: false,
            reason: commentsOff ? 'comments_off' : 'no_input',
            diag: { hasPostBtn, hasCommentBtn, commentsOff },
        };
    }
    if (!text || !String(text).trim()) return { ok: false, reason: 'empty_text' };

    const clickEl = (el) => {
        if (!el) return;
        try {
            el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } catch {
            // ignore
        }
    };

    // 先把输入区滚到可见并模拟点击获取焦点（TikTok Web 端常见：不点一下无法输入）
    try {
        (container || editor).scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
        // ignore
    }

    clickEl(container);
    clickEl(editor);
    try {
        editor.focus();
    } catch {
        // ignore
    }

    // 给 React/Draft.js 一点时间处理 focus/click
    await new Promise((r) => setTimeout(r, 60));

    // 尽量让 React/Draft.js 正确感知输入变化
    try {
        if (editor.isContentEditable) {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            document.execCommand('insertText', false, String(text));
        } else {
            editor.value = String(text);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } catch {
        // ignore
    }

    const findPostBtn = () =>
        document.querySelector('[data-e2e="comment-post"]') ||
        document.querySelector('button[aria-label*="post" i]') ||
        document.querySelector('button[aria-label*="发送" i]');

    const isEnabled = (btn) => {
        if (!btn) return false;
        const aria = String(btn.getAttribute('aria-disabled') || '').toLowerCase();
        return !(btn.disabled || aria === 'true');
    };

    // Draft.js/React 更新按钮状态可能有延迟：等待最多 1.5s
    let btn = findPostBtn();
    const waitStart = Date.now();
    while (!isEnabled(btn) && (Date.now() - waitStart) < 1500) {
        await new Promise(r => setTimeout(r, 60));
        btn = findPostBtn();
    }

    if (!isEnabled(btn)) {
        // 兜底：尝试 Enter 提交
        try {
            const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
            editor.dispatchEvent(ev);
        } catch {
            // ignore
        }
        return { ok: false, reason: 'post_button_disabled_or_missing' };
    }

    try {
        btn.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
        // ignore
    }

    // 尽量模拟真实点击链路
    try {
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } catch {
        btn.click();
    }

    // 点击后等待输入框清空作为“已提交”的信号（最多 2s）
    const sentStart = Date.now();
    const getEditorText = () => {
        try {
            return editor.isContentEditable ? (editor.innerText || '').trim() : String(editor.value || '').trim();
        } catch {
            return '';
        }
    };
    while ((Date.now() - sentStart) < 2000) {
        const t = getEditorText();
        if (!t) return { ok: true };
        await new Promise(r => setTimeout(r, 80));
    }

    return { ok: true, reason: 'clicked_but_not_cleared' };
}

// ===========================
// Python comm
// ===========================

async function sendToPython(data) {
    try {
        const response = await fetch(`http://localhost:${PORT}/data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const resData = await response.json().catch(() => ({}));

        // 兼容：服务端可能用 command/commands
        if (resData.command) {
            void executeIncomingCommand(resData.command);
        }
        if (Array.isArray(resData.commands)) {
            for (const c of resData.commands) void executeIncomingCommand(c);
        }

        return true;
    } catch (e) {
        logToUI(`POST /data 失败: ${e.message}`, 'error');
        return false;
    }
}

let isProcessingCommand = false;
let pendingCommand = null;

async function executeIncomingCommand(cmd) {
    if (!cmd) return;

    if (isProcessingCommand) {
        pendingCommand = cmd;
        return;
    }

    isProcessingCommand = true;
    try {
        updateLatestCmdUI(cmd);
        logToUI(`收到指令: ${cmd.type || cmd}`, 'cmd');
        await handleCommand(cmd);
    } catch (e) {
        logToUI(`执行指令失败: ${e.message}`, 'error');
    } finally {
        isProcessingCommand = false;
        if (pendingCommand) {
            const next = pendingCommand;
            pendingCommand = null;
            setTimeout(() => void executeIncomingCommand(next), 0);
        }
    }
}

async function handleCommand(cmd) {
    const type = (cmd?.type || '').toLowerCase();
    const payload = cmd?.payload || cmd?.data || {};

    const tab = await getCurrentTab();
    if (!tab?.id) throw new Error('no_active_tab');

    const run = async (fn, args = []) => {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: fn,
            args,
        });
        return results?.[0]?.result;
    };

    if (type === 'open_comments') {
        const r = await run(openComments);
        logToUI(r?.ok ? '已尝试打开评论区' : '打开评论区失败/未命中按钮', r?.ok ? 'success' : 'warn');
        return;
    }

    if (type === 'like_video' || type === 'like') {
        const r = await run(likeVideo);
        logToUI(r?.ok ? '已尝试点赞' : '点赞失败/未命中按钮', r?.ok ? 'success' : 'warn');
        return;
    }

    if (type === 'subscribe' || type === 'subscribe_channel') {
        const r = await run(subscribe);
        logToUI(r?.ok ? '已尝试关注' : '关注失败/未命中按钮', r?.ok ? 'success' : 'warn');
        return;
    }

    if (type === 'next_video' || type === 'monitor_next') {
        const watchLimitRaw =
            cmd?.watchLimit ??
            cmd?.watch_limit ??
            payload?.watchLimit ??
            payload?.watch_limit ??
            payload?.watch_limit_seconds ??
            0;
        const watchLimitSec = Math.max(0, Number(watchLimitRaw) || 0);

        if (watchLimitSec > 0) {
            const info0 = await run(extractTargetText).catch(() => null);
            const dur0 = Number(info0?.duration || 0);
            const isWatchAllHint = watchLimitSec >= 300;
            const targetSec = dur0 > 0 ? (isWatchAllHint ? dur0 : Math.min(watchLimitSec, dur0)) : (isWatchAllHint ? 15 : watchLimitSec);
            const safeTarget = Math.max(1, Math.min(180, targetSec));

            logToUI(`等待观看 ${safeTarget}s 后跳转...`, 'info');
            const startTs = Date.now();
            while (true) {
                const info = await run(extractTargetText).catch(() => null);
                const cur = Number(info?.current || 0);
                const dur = Number(info?.duration || 0);
                const target = dur > 0 ? (isWatchAllHint ? Math.min(dur, safeTarget) : Math.min(safeTarget, dur)) : safeTarget;
                const elapsed = (Date.now() - startTs) / 1000;

                if (cur >= target) break;
                if (dur <= 0 && elapsed >= target) break;
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }

        await run(nextVideo);
        logToUI(watchLimitSec > 0 ? '到点跳转：已尝试切到下一个视频' : '已尝试切到下一个视频', 'success');
        return;
    }

    if (type === 'auto_comment') {
        const text = payload?.text || payload?.comment || cmd?.text || '';
        // 先尝试打开评论区（否则输入框可能不存在）
        try {
            await run(openComments);
        } catch {
            // ignore
        }
        await new Promise((resolve) => setTimeout(resolve, 350));

        const r = await run(postComment, [text]);
        if (r?.ok) {
            logToUI('已尝试发表评论', 'success');
        } else {
            const diag = r?.diag ? ` diag=${JSON.stringify(r.diag)}` : '';
            logToUI(`发表评论失败: ${r?.reason || 'unknown'}${diag}`, 'warn');
        }
        return;
    }

    logToUI(`未知指令: ${type || JSON.stringify(cmd)}`, 'warn');
}

async function pollPythonCommands() {
    try {
        const response = await fetch(`http://localhost:${PORT}/poll?ready=true`);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

        updateStatus('已连接', '#69db7c');

        const data = await response.json().catch(() => ({}));
        if (data.command) {
            void executeIncomingCommand(data.command);
        }
        if (Array.isArray(data.commands)) {
            for (const c of data.commands) void executeIncomingCommand(c);
        }
    } catch (e) {
        updateStatus('连接失败', '#ff6b6b');
    } finally {
        setTimeout(() => void pollPythonCommands(), 200);
    }
}

let lastAutoKey = '';

async function updateTitleAndMaybeSend() {
    const tab = await getCurrentTab();
    if (!tab?.id) return;

    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractTargetText,
    });

    const r = results?.[0]?.result;
    const title = r?.title || '等待检测视频...';
    const current = r?.current || 0;
    const duration = r?.duration || 0;

    updateTitleUI(title);
    updateTimeUI(current, duration);

    const key = `${tab.url || ''}|${title}`;
    if (!tab.url || key === lastAutoKey) return;
    lastAutoKey = key;

    // 仅在“视频变化”时轻量上报一次
    const payload = {
        title,
        url: tab.url,
        platform: PLATFORM,
        html: '',
        extra_data: {
            comments: [],
            has_input: false,
            like_count: '0',
            comment_count: '0',
            duration,
            current_time: current,
        },
    };
    await sendToPython(payload);
}

// ===========================
// Init
// ===========================

document.addEventListener('DOMContentLoaded', async () => {
    logToUI(`插件已加载 (BUILD_ID=${BUILD_ID})`, 'info');
    updateStatus('正在连接...', '#ddd');

    const btnCapture = document.getElementById('btn-capture');
    const btnTest = document.getElementById('btn-test');

    if (btnCapture) {
        btnCapture.addEventListener('click', async () => {
            const tab = await getCurrentTab();
            if (!tab?.id) {
                logToUI('未找到活动标签页', 'error');
                return;
            }
            logToUI('捕获当前视频...', 'info');
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: getLightPageData,
                });
                const data = results?.[0]?.result;
                if (!data) {
                    logToUI('未获取到页面数据', 'warn');
                    return;
                }
                data.url = tab.url;
                updateTitleUI(data.title);
                updateTimeUI(data.extra_data?.current_time || 0, data.extra_data?.duration || 0);
                updateCommentsDisplay(data.extra_data?.comments || []);
                await sendToPython(data);
                logToUI('✅ 已发送视频数据', 'success');
            } catch (e) {
                logToUI(`捕获失败: ${e.message}`, 'error');
            }
        });
    }

    if (btnTest) {
        btnTest.addEventListener('click', async () => {
            logToUI('🔗 测试 Python 连接...', 'info');
            try {
                const response = await fetch(`http://localhost:${PORT}/poll?ready=true`);
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                logToUI('✅ 连接成功!', 'success');
                updateStatus('已连接', '#69db7c');
            } catch (e) {
                logToUI(`❌ 连接失败: ${e.message}`, 'error');
                updateStatus('连接失败', '#ff6b6b');
            }
        });
    }

    // 1) UI 刷新/自动上报（1s）
    await updateTitleAndMaybeSend();
    setInterval(() => {
        void updateTitleAndMaybeSend();
    }, 1000);

    // 2) 指令轮询（200ms）
    void pollPythonCommands();
});


    const hasInput = !!document.querySelector('[data-e2e="comment-input"]');

    return {
        title,
        url: window.location.href,
        html: document.documentElement.outerHTML,
        platform: 'tiktok',
        extra_data: {
            comments,
            has_input: hasInput,
            like_count: likeCountStr,
            comment_count: commentCountStr,
            duration,
            current_time: currentTime,
        },
    };
}

function trySubscribe() {
    try {
        if (!window.location.hostname.includes('tiktok.com')) {
            return { success: false, msg: '非 TikTok 页面' };
        }

        const activeRoot = _tk_getActiveContainer();
        const isGlobalScope = activeRoot === document;

        const isVisible = _tk_isVisible;
        let followBtn = null;

        if (isGlobalScope) {
            const btns = Array.from(document.querySelectorAll('[data-e2e="feed-follow"]'));
            followBtn = btns.find(isVisible) || null;
        } else {
            const candidate = activeRoot.querySelector('[data-e2e="feed-follow"]');
            followBtn = candidate && isVisible(candidate) ? candidate : null;
        }

        if (!followBtn) {
            return { success: false, msg: '未找到可见的关注按钮 (可能已关注)' };
        }

        followBtn.click();
        return { success: true, msg: '已点击关注 (TikTok)' };
    } catch (e) {
        return { success: false, msg: `关注操作出错: ${e.message}` };
    }
}

function autoOpenComments() {
    try {
        if (!window.location.hostname.includes('tiktok.com')) {
            return { success: false, msg: '非 TikTok 页面' };
        }

        const activeRoot = _tk_getActiveContainer();
        const isGlobalScope = activeRoot === document;
        let commentBtn = null;

        if (isGlobalScope) {
            const btns = Array.from(document.querySelectorAll('[data-e2e="feed-comment-icon"]'));
            commentBtn = btns.find(_tk_isVisible) || null;
        } else {
            commentBtn = activeRoot.querySelector('[data-e2e="feed-comment-icon"]');
        }

        if (commentBtn) {
            commentBtn.click();
            return { success: true, msg: '已点击 TikTok 评论按钮' };
        }
        return { success: false, msg: '未找到 TikTok 评论按钮' };
    } catch (e) {
        return { success: false, msg: `自动打开评论出错: ${e.message}` };
    }
}

function tryLikeTikTok() {
    try {
        if (!window.location.hostname.includes('tiktok.com')) {
            return { success: false, msg: '非 TikTok 页面' };
        }

        // 常见：data-e2e like 按钮/图标
        const candidates = Array.from(document.querySelectorAll('[data-e2e="like-icon"], [data-e2e="feed-like-icon"], button[aria-label*="Like"], button[aria-label*="like"]'));
        const btn = candidates.find(_tk_isVisible) || null;
        if (!btn) return { success: false, msg: '未找到可见点赞按钮' };
        btn.click();
        return { success: true, msg: '已点击点赞' };
    } catch (e) {
        return { success: false, msg: `点赞操作出错: ${e.message}` };
    }
}

function nextVideoTikTok() {
    try {
        const event = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            code: 'ArrowDown',
            keyCode: 40,
            bubbles: true,
        });
        document.dispatchEvent(event);
        // 备用：滚动
        window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
        return { success: true, msg: '已尝试切换下一个视频' };
    } catch (e) {
        return { success: false, msg: `切换视频失败: ${e.message}` };
    }
}

async function postCommentTikTok(text) {
    try {
        const container = document.querySelector('[data-e2e="comment-input"]');
        const editor =
            (container && container.querySelector('[contenteditable="true"][role="textbox"]')) ||
            document.querySelector('[data-e2e="comment-text"] [contenteditable="true"][role="textbox"]') ||
            document.querySelector('[contenteditable="true"][role="textbox"].public-DraftEditor-content') ||
            document.querySelector('textarea');

        if (!editor) return { success: false, msg: '未找到评论输入框(contenteditable/textarea)' };
        if (!text || !String(text).trim()) return { success: false, msg: '评论内容为空' };

        editor.focus();

        // Draft.js / React：尽量用 execCommand 走浏览器输入链路
        if (editor.isContentEditable) {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            document.execCommand('insertText', false, String(text));
        } else {
            editor.value = String(text);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const findBtn = () =>
            document.querySelector('[data-e2e="comment-post"]') ||
            document.querySelector('button[aria-label="Post" i]') ||
            document.querySelector('button[type="submit"]');

        const isEnabled = (btn) => {
            if (!btn) return false;
            const aria = String(btn.getAttribute('aria-disabled') || '').toLowerCase();
            return !(btn.disabled || aria === 'true');
        };

        // 等待 Post 从 disabled 变为可点击（Draft.js 状态更新有延迟）
        let submit = findBtn();
        const waitStart = Date.now();
        while (!isEnabled(submit) && (Date.now() - waitStart) < 1500) {
            await new Promise(r => setTimeout(r, 60));
            submit = findBtn();
        }

        if (!isEnabled(submit)) {
            // 兜底：尝试 Enter
            try {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            } catch {
                // ignore
            }
            return { success: false, msg: '已填入评论，但 Post 按钮仍为禁用/未找到(可能未触发 Draft.js 输入链路/未登录/被风控/需验证码)' };
        }

        try {
            submit.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
            // ignore
        }

        // 模拟真实点击链路
        try {
            submit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            submit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } catch {
            submit.click();
        }

        // 等待输入框清空来确认提交（最多 2s）
        const sentStart = Date.now();
        const getText = () => {
            try {
                return editor.isContentEditable ? (editor.innerText || '').trim() : String(editor.value || '').trim();
            } catch {
                return '';
            }
        };

        while ((Date.now() - sentStart) < 2000) {
            if (!getText()) return { success: true, msg: '已点击发送评论(输入框已清空)' };
            await new Promise(r => setTimeout(r, 80));
        }

        return { success: true, msg: '已点击发送评论(但输入框未清空，可能被拦截/风控/网络慢)' };
    } catch (e) {
        return { success: false, msg: `评论失败: ${e.message}` };
    }
}

// ===========================
// Python communication
// ===========================

function getClientId() {
                    // 先滚动到输入区并点击获取焦点（否则 Web 端可能不接受输入）
                    try {
                        (container || editor).scrollIntoView({ block: 'center', inline: 'center' });
                    } catch {
                        // ignore
                    }
                    clickEl(container);
                    clickEl(editor);
                    try {
                        editor.focus();
                    } catch {
                        // ignore
                    }
                    await new Promise((r) => setTimeout(r, 60));
    if (!id) {
        id = `client_${Math.random().toString(36).slice(2, 11)}`;
        localStorage.setItem('plugin_client_id', id);
    }
    return id;
}

async function sendToPython(data) {
    try {
        data.client_id = getClientId();
        data.platform = PLATFORM;

        if (data.extra_data?.comments) {
            updateCommentsDisplay(data.extra_data.comments);
        }

        const response = await fetch(`http://localhost:${PORT}/data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(`/data 响应异常: ${response.status} ${response.statusText}`);
        }

        const resData = await response.json();
        if (resData.command) {
            void executeIncomingCommand(resData.command, 'post_response');
        }
        if (Array.isArray(resData.commands)) {
            for (const cmd of resData.commands) {
                void executeIncomingCommand(cmd, 'post_response_list');
            }
        }
    } catch (e) {
        console.error('[TikTok] 发送给 Python 失败', e);
        logToUI(`发送给 Python 失败: ${e.message}`, 'error');
    }
}

let isConnected = false;
let connectionErrorCount = 0;

async function pollPythonCommands() {
    try {
        const response = await fetch(`http://localhost:${PORT}/poll?ready=true`);
        if (!response.ok) {
            throw new Error(`/poll 响应异常: ${response.status} ${response.statusText}`);
        }

        if (!isConnected) {
            isConnected = true;
            connectionErrorCount = 0;
            updateStatus('已连接', '#69db7c');
            logToUI('✅ 已连接到 Python 服务 (8099)', 'success');
        }

        const data = await response.json();
        if (data.command) {
            void executeIncomingCommand(data.command, 'poll');
        }
        if (Array.isArray(data.commands) && data.commands.length > 0) {
            for (const cmd of data.commands) {
                void executeIncomingCommand(cmd, 'poll_list');
            }
        }
    } catch (e) {
        connectionErrorCount += 1;
        if (isConnected) {
            isConnected = false;
            updateStatus('连接失败', '#ff6b6b');
            logToUI(`❌ 轮询失败: ${e.message}`, 'error');
        } else if (connectionErrorCount % 10 === 0) {
            // 避免刷屏
            logToUI(`❌ 轮询失败(累计${connectionErrorCount}次): ${e.message}`, 'warn');
        }
    } finally {
        setTimeout(pollPythonCommands, 200);
    }
}

// ===========================
// Command execution pipeline
// ===========================

const COMMAND_NAMES_CN = {
    auto_comment: '自动评论',
    monitor_next: '监控并跳转',
    next_video: '下一个视频',
    open_comments: '打开评论区',
    like_video: '点赞视频',
    like_top_comment: '高赞点赞',
    like_comment: '点赞评论',
    subscribe: '关注频道',
    subscribe_channel: '关注频道',
    fill_comment: '填充评论',
};

function getCommandNameCN(type) {
    return COMMAND_NAMES_CN[type] || type;
}

let isProcessingCommand = false;
let pendingCommand = null;

async function executeIncomingCommand(cmd, source = 'unknown') {
    if (!cmd || !cmd.type) return;

    const cmdName = getCommandNameCN(cmd.type);
    const isHighPriority = cmd.type === 'monitor_next' || cmd.type === 'next_video';

    if (isProcessingCommand && !isHighPriority) {
        pendingCommand = cmd;
        logToUI(`⏸️ 暂存指令: ${cmdName} (忙碌中)`, 'warn');
        return;
    }

    isProcessingCommand = true;
    try {
        await handleCommand(cmd);
        logToUI(`✅ 完成: ${cmdName} (${source})`, 'success');
    } catch (e) {
        console.error('[TikTok] 指令执行失败', cmd, e);
        logToUI(`❌ 失败: ${cmdName} - ${e.message}`, 'error');
    } finally {
        isProcessingCommand = false;
        if (pendingCommand) {
            const next = pendingCommand;
            pendingCommand = null;
            setTimeout(() => void executeIncomingCommand(next, 'pending'), 0);
        }
    }
}

async function handleCommand(cmd) {
    const cmdName = getCommandNameCN(cmd.type);

    // UI: 最新指令
    const cmdBox = document.getElementById('latest-cmd-box');
    const cmdContent = document.getElementById('latest-cmd-content');
    if (cmdBox && cmdContent) {
        cmdBox.style.display = 'block';
        cmdContent.textContent = cmd.type === 'auto_comment' && cmd.text ? `${cmdName}: ${cmd.text}` : cmdName;
    }

    // 选中目标 tab
    const tab = await getCurrentTab();
    if (!tab) throw new Error('未找到活动标签页');

    // URL/视频ID 校验（如果 Python 侧带 target_url）
    if (cmd.target_url && tab.url) {
        const extractId = (url) => {
            if (!url) return null;
            // TikTok 常见：/video/<id>
            const m = String(url).match(/\/video\/(\d+)/);
            return m ? m[1] : null;
        };
        const targetId = extractId(cmd.target_url);
        const currentId = extractId(tab.url);
        if (targetId && currentId && targetId !== currentId) {
            logToUI(`⛔ 忽略过期指令: ${cmdName} (视频已切换)`, 'warn');
            return;
        }
    }

    // 执行
    if (cmd.type === 'monitor_next' || cmd.type === 'next_video') {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: nextVideoTikTok,
        });
        return;
    }

    if (cmd.type === 'open_comments') {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: autoOpenComments,
        });
        return;
    }

    if (cmd.type === 'like_video') {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: likeVideo,
        });
        const r = results?.[0]?.result;
        if (r?.ok) {
            const status = [];
            if (r.clicked) status.push('已点击');
            if (r.toggled) status.push(`toggle ${r.beforePressed}→${r.afterPressed}`);
            if (r.likedState) status.push('已点赞');
            if (r.labelChanged) status.push('label变化');
            if (r.classChanged) status.push('class变化');
            if (r.hasDialog) status.push('⚠️弹窗');
            
            logToUI(
                `✅ 视频点赞：${status.join(' | ')}${r.beforeLabel ? ` [${r.beforeLabel}]` : ''}`,
                'success'
            );
        } else {
            logToUI(`⚠️ 视频点赞失败: ${r?.reason || 'unknown'}`, 'warn');
        }
        return;
    }

    if (cmd.type === 'like_top_comment') {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: likeTopCommentTikTokPage,
        });
        const r = results?.[0]?.result;
        if (r?.ok) {
            logToUI(
                `✅ 高赞点赞完成：items=${r.commentItemsCount} pressed ${r.beforePressed}→${r.afterPressed} toggled=${r.toggled}`,
                'success'
            );
        } else {
            logToUI(`⚠️ 高赞点赞失败: ${r?.reason || 'unknown'}`, 'warn');
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
            logToUI(
                `✅ 评论点赞完成：idx=${idx}${r?.matched ? ' (已匹配)' : ' (按序号)'} items=${r.commentItemsCount} pressed ${r.beforePressed}→${r.afterPressed} toggled=${r.toggled}`,
                'success'
            );
        } else {
            logToUI(`⚠️ 评论点赞失败：idx=${idx} reason=${r?.reason || 'unknown'}`, 'warn');
        }
        return;
    }

    if (cmd.type === 'subscribe' || cmd.type === 'subscribe_channel') {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: trySubscribe,
        });
        return;
    }

    if (cmd.type === 'auto_comment') {
        const text = cmd.text || '';
        if (!text) throw new Error('auto_comment 缺少 text');
        // MV3 注入函数必须自包含：不能在页面侧引用 popup.js 里的其他函数。
        // 所以这里分两次注入：先打开评论区，再发表评论。
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: autoOpenComments,
            });
        } catch {
            // ignore
        }

        // 给评论区展开一点时间
        await new Promise(r => setTimeout(r, 350));

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: postCommentTikTok,
            args: [text],
        });
        const r = results?.[0]?.result;
        if (r?.success) {
            logToUI('📝 评论已发送', 'success');
        } else {
            logToUI(`📝 评论未发送: ${r?.msg || 'unknown'}`, 'warn');
        }
        return;
    }

    // 未实现的指令类型：仅记录
    logToUI(`⚠️ 未实现指令: ${cmd.type}`, 'warn');
}

// ===========================
// Main loop
// ===========================

let lastSeenTitle = '';

async function updateTitleAndMaybeSend() {
    try {
        const tab = await getCurrentTab();
        if (!tab || !tab.url || tab.url.startsWith('chrome://')) return;

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractTargetText,
        });

        const data = results?.[0]?.result;
        if (!data) return;

        const titleEl = document.getElementById('video-title');
        if (titleEl && data.title) titleEl.textContent = data.title;

        const timeEl = document.getElementById('time-progress');
        if (timeEl && data.timeInfo) {
            const formatTime = (sec) => {
                const m = Math.floor(sec / 60);
                const s = sec % 60;
                return `${m}:${String(s).padStart(2, '0')}`;
            };
            timeEl.textContent = `时间: ${formatTime(data.timeInfo.current)} / ${formatTime(data.timeInfo.duration)}`;
        }

        // 新视频：采集完整数据并上报
        if (data.title && data.title !== lastSeenTitle) {
            lastSeenTitle = data.title;
            logToUI(`📹 检测到新视频: ${data.title.substring(0, 40)}`, 'info');

            const contentResults = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: getPageContent,
            });

            const content = contentResults?.[0]?.result;
            if (content) {
                content.url = tab.url;
                await sendToPython(content);
                logToUI('✅ 已同步视频数据，等待指令...', 'success');
            }
        }
    } catch (e) {
        // 静默，避免刷屏
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    updateStatus('正在连接...', '#ddd');
    logToUI(`TikTok 插件已加载 (${BUILD_ID})`, 'info');

    const btnCapture = document.getElementById('btn-capture');
    const btnTest = document.getElementById('btn-test');

    if (btnCapture) {
        btnCapture.addEventListener('click', async () => {
            logToUI('🎬 手动捕获当前视频...', 'info');
            const tab = await getCurrentTab();
            if (!tab) {
                logToUI('未找到活动标签页', 'error');
                return;
            }

            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: getPageContent,
            });
            const data = results?.[0]?.result;
            if (!data) {
                logToUI('未获取到页面数据', 'warn');
                return;
            }
            data.url = tab.url;
            await sendToPython(data);
            logToUI('✅ 已发送视频数据', 'success');
        });
    }

    if (btnTest) {
        btnTest.addEventListener('click', async () => {
            logToUI('🔗 测试 Python 连接...', 'info');
            try {
                const response = await fetch(`http://localhost:${PORT}/poll?ready=true`);
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                logToUI('✅ 连接成功!', 'success');
                updateStatus('已连接', '#69db7c');
            } catch (e) {
                logToUI(`❌ 连接失败: ${e.message}`, 'error');
                updateStatus('连接失败', '#ff6b6b');
            }
        });
    }

    // 1) 启动 UI 刷新/自动上报（1s）
    await updateTitleAndMaybeSend();
    setInterval(() => {
        void updateTitleAndMaybeSend();
    }, 1000);

    // 2) 启动指令轮询（200ms）
    void pollPythonCommands();
});
    
    if (log.detail) {
      const detailDiv = document.createElement('div');
      detailDiv.style.color = '#aaa';
      detailDiv.style.fontSize = '10px';
      detailDiv.style.marginLeft = '20px';
      detailDiv.style.whiteSpace = 'pre-wrap';
      detailDiv.innerText = log.detail;
      div.appendChild(detailDiv);
    }
    debugContent.appendChild(div);
  });
}

// 注入页面的分析函数
function analyzePageStructure() {
  const logs = [];
  const addLog = (icon, msg, color = '#fff', detail = '') => {
    logs.push({ icon, message: msg, color, detail });
  };

  addLog('🚀', '开始分析当前页面结构...', '#2196f3');
  addLog('ℹ️', `页面标题: ${document.title}`, '#fff');
  addLog('🔗', `URL: ${window.location.href}`, '#fff');

  // 1. 检查 Meta 标签
  const metaTitle = document.querySelector('meta[name="title"]');
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaTitle) addLog('✅', '找到 Meta Title', '#4caf50', metaTitle.content);
  else addLog('⚠️', '未找到 Meta Title', '#ff9800');
  
  if (metaDesc) addLog('✅', '找到 Meta Description', '#4caf50', metaDesc.content.substring(0, 50) + '...');

  // 2. 检查常见标题元素
  const h1s = document.querySelectorAll('h1');
  addLog('🔎', `找到 ${h1s.length} 个 H1 标签`, '#2196f3');
  h1s.forEach((h1, i) => {
    addLog('📄', `H1 [#${i}]: ${h1.innerText.substring(0, 30)}...`, '#fff', `Class: ${h1.className}\nID: ${h1.id}`);
  });

  // 3. 检查平台特定结构
  if (window.location.hostname.includes('tiktok.com')) {
      addLog('🎵', '检测到 TikTok 页面', '#e91e63');
      
      // 检查标题
      const descEl = document.querySelector('[data-e2e="video-desc"]');
      if (descEl) addLog('✅', '找到标题元素 [data-e2e="video-desc"]', '#4caf50', descEl.innerText);
      else addLog('❌', '未找到标题元素', '#f44336');

      // 检查互动数据
      const likeEl = document.querySelector('[data-e2e="like-count"]');
      if (likeEl) addLog('❤️', `找到点赞数: ${likeEl.innerText}`, '#ff4081');
      else addLog('⚠️', '未找到点赞元素', '#ff9800');

      const commentEl = document.querySelector('[data-e2e="comment-count"]');
      if (commentEl) addLog('💬', `找到评论数: ${commentEl.innerText}`, '#2196f3');
      else addLog('⚠️', '未找到评论数元素', '#ff9800');

      // 检查评论列表
      const comments = document.querySelectorAll('[data-e2e="comment-level-1"]');
      addLog('📝', `找到 ${comments.length} 条可见评论 (by content)`, '#fff');

      const usernames = document.querySelectorAll('[data-e2e="comment-username-1"]');
      addLog('👤', `找到 ${usernames.length} 个评论作者`, '#fff');

      const items = document.querySelectorAll('[class*="DivCommentItemWrapper"]');
      addLog('📦', `找到 ${items.length} 个评论容器`, '#fff');
      
  } else {
      const ytdApp = document.querySelector('ytd-app');
      if (ytdApp) addLog('📺', '检测到 TikTok 应用容器', '#e91e63');

      const shortsContainer = document.querySelector('ytd-shorts');
      if (shortsContainer) {
        addLog('📱', '检测到 Shorts 容器 (ytd-shorts)', '#e91e63');
      }
  }
  return logs;
}

// 注入到页面的函数：获取完整 HTML 及关键信息
function getPageContent() {
  // 辅助函数：安全获取文本
  const getText = (selector, root = document) => {
    const el = root.querySelector(selector);
    return el ? el.innerText.trim() : null;
  };

  // 统一平台检测逻辑 (基于 URL)
  const currentUrl = window.location.href.toLowerCase();
  const isTikTok = true; // TikTok 专用版本
  console.log(`[Plugin] Platform Check: URL=${currentUrl}, isTikTok=${isTikTok}`);

  // 辅助函数：解析数字 (支持 K, M, B, 万)
  const parseCount = (s) => {
      if (!s) return 0;
      let m = 1;
      const upper = s.toUpperCase();
      if (upper.includes('K')) m = 1000;
      else if (upper.includes('M')) m = 1000000;
      else if (upper.includes('B')) m = 1000000000;
      else if (upper.includes('万')) m = 10000;
      
      return parseFloat(s.replace(/,/g, '').replace(/[KkMmBb万]/g, '')) * m;
  };

  // --- TikTok 逻辑 ---
  if (isTikTok) {
      console.log("[Plugin] 进入 TikTok 处理流程");
      let topComments = [];
      let commentCountStr = "0";
      let likeCountStr = "0";
      let duration = 0;
      let currentTime = 0;
      let realTitle = "";
      let hasInput = false;

      // 0. 定位当前活跃的视频容器
      const getActiveContainer = () => {
          // 策略：找到可视面积最大且（可选）正在播放的视频
          const videos = Array.from(document.querySelectorAll('video'));
          let bestVideo = null;
          let maxScore = -1;
          
          videos.forEach(v => {
              const rect = v.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return;
              
              // 计算可视面积
              const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
              const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
              const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
              
              // 评分：面积 * (播放中 ? 1.5 : 1)
              let score = visibleArea;
              if (!v.paused) score *= 1.5;
              
              if (score > maxScore) {
                  maxScore = score;
                  bestVideo = v;
              }
          });

          if (bestVideo) {
              // 尝试找到包含该视频的 Feed 容器
              const feedItem = bestVideo.closest('[data-e2e="recommend-list-item-container"]');
              if (feedItem) return feedItem;
              
              // 如果没找到 Feed 容器 (可能是 Modal 模式)，尝试找 Modal 容器
              // Modal 容器通常包含 video 和 评论区
              // 我们可以尝试找一个共同祖先，或者直接返回 document (但在提取时严格检查可见性)
              return document;
          }
          
          return document;
      };
      
      const activeRoot = getActiveContainer();
      const isGlobalScope = activeRoot === document;

      // 辅助：检查元素是否真正可见
      const isVisible = (el) => {
          if (!el) return false;
          if (el.offsetParent === null) return false; // display: none
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
      };

      // 1. 获取标题
      // 如果是全局范围，必须找可见的 desc
      let descEl = null;
      if (isGlobalScope) {
          const descs = Array.from(document.querySelectorAll('[data-e2e="video-desc"]'));
          descEl = descs.find(isVisible);
      } else {
          descEl = activeRoot.querySelector('[data-e2e="video-desc"]');
      }

      if (descEl) realTitle = descEl.innerText;
      else {
          // 备用：Meta (仅当找不到可见元素时)
          if (isGlobalScope) {
              const metaDesc = document.querySelector('meta[name="description"]');
              if (metaDesc) realTitle = metaDesc.content;
          }
      }

      // 2. 获取点赞数
      const likeEl = isGlobalScope ? 
          Array.from(document.querySelectorAll('[data-e2e="like-count"]')).find(isVisible) : 
          activeRoot.querySelector('[data-e2e="like-count"]');
      if (likeEl) likeCountStr = likeEl.innerText;

      // 3. 获取评论数
      const commentCountEl = isGlobalScope ?
          Array.from(document.querySelectorAll('[data-e2e="comment-count"]')).find(isVisible) :
          activeRoot.querySelector('[data-e2e="comment-count"]');
      if (commentCountEl) commentCountStr = commentCountEl.innerText;

      // 4. 获取评论列表
      let allComments = [];
      
      // 确定评论查找范围
      // 如果 activeRoot 里没有评论 (Modal 模式)，则在 document 里找可见的评论
      let commentScope = activeRoot;
      if (!isGlobalScope && activeRoot.querySelectorAll('[class*="DivCommentItemWrapper"]').length === 0) {
          commentScope = document;
      }

      const items = commentScope.querySelectorAll('[class*="DivCommentItemWrapper"]');
      if (items.length > 0) {
          for (let i = 0; i < Math.min(items.length, 30); i++) { // 增加扫描数量
              const root = items[i];
              
              // 严格的可见性检查
              if (!isVisible(root)) continue;

              const authorEl = root.querySelector('[data-e2e="comment-username-1"]') || root.querySelector('a[href^="/@"]');
              const contentEl = root.querySelector('[data-e2e="comment-level-1"]') || root.querySelector('p[class*="TUXText"]');
              const likeContainer = root.querySelector('[class*="DivLikeContainer"]');
              
              const author = authorEl ? authorEl.innerText : "";
              const content = contentEl ? contentEl.innerText : "";
              
              // 过滤无效数据
              if (!author && !content) continue;

              const likesStr = likeContainer ? (likeContainer.querySelector('span') ? likeContainer.querySelector('span').innerText : "0") : "0";
              
              allComments.push({
                  author: author || "User",
                  content: content,
                  likes: likesStr,
                  likeNum: parseCount(likesStr)
              });
          }
      } 
      
      // 如果策略A失败，尝试策略B (直接找 content)
      if (allComments.length === 0) {
           const commentElements = commentScope.querySelectorAll('[data-e2e="comment-level-1"]');
           for (let i = 0; i < Math.min(commentElements.length, 30); i++) {
              const c = commentElements[i];
              if (!isVisible(c)) continue;

              const root = c.closest('[class*="DivCommentItemWrapper"]') || c.parentElement.parentElement; 
              if (root) {
                  const authorEl = root.querySelector('[data-e2e="comment-username-1"]');
                  const likeContainer = root.querySelector('[class*="DivLikeContainer"]');
                  const likesStr = likeContainer ? (likeContainer.querySelector('span') ? likeContainer.querySelector('span').innerText : "0") : "0";

                  allComments.push({
                      author: authorEl ? authorEl.innerText : "User",
                      content: c.innerText,
                      likes: likesStr,
                      likeNum: parseCount(likesStr)
                  });
              }
           }
      }

      // 按点赞数降序排序
      allComments.sort((a, b) => b.likeNum - a.likeNum);
      
      // 取前3名
      topComments = allComments.slice(0, 3).map(c => ({
          author: c.author,
          content: c.content,
          likes: c.likes
      }));

      // 5. 检查输入框
      const inputEl = document.querySelector('[data-e2e="comment-input"]');
      hasInput = !!inputEl;

      // 6. 获取时间
      // 优先用 bestVideo (如果存在)
      const video = (activeRoot === document) ? document.querySelector('video') : activeRoot.querySelector('video');
      if (video && !isNaN(video.duration)) {
          duration = Math.round(video.duration);
          currentTime = Math.round(video.currentTime);
      }

      return {
          title: realTitle,
          url: window.location.href,
          html: document.documentElement.outerHTML,
          // 统一使用 isTikTok 变量
          platform: isTikTok ? 'tiktok' : 'tiktok',
          extra_data: {
              comments: topComments,
              has_input: hasInput,
              like_count: likeCountStr,
              comment_count: commentCountStr,
              duration: duration,
              current_time: currentTime
          }
      };
  }
}

// 获取平台对应的端口
function getPlatformPort(platform) {
    return PORT; // 固定使用 8099
}

function getClientId() {
    let id = localStorage.getItem('plugin_client_id');
    if (!id) {
        id = 'client_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('plugin_client_id', id);
    }
    return id;
}

async function sendToPython(data) {
  try {
    data.client_id = getClientId();
    
    // 更新热门评论显示
    if (data.extra_data && data.extra_data.comments) {
        updateCommentsDisplay(data.extra_data.comments);
    }
    
    // 根据平台选择端口
    const port = getPlatformPort(data.platform);
    
    // 调试：显示发送的平台信息
    console.log(`[Plugin → Python] 发送数据到端口 ${port}: platform=${data.platform}, url=${data.url}`);
    
    const response = await fetch(`http://localhost:${port}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (response.ok) {
        const resData = await response.json();
        
        // 调试：显示收到的指令
        if (resData.command) {
            console.log(`[Python → Plugin] 从端口 ${port} 收到指令:`, resData.command);
        }
        
        // 处理返回的指令 (支持单指令 command 或多指令 commands)
        if (resData.command) {
            handleCommand(resData.command);
        }
        if (resData.commands && Array.isArray(resData.commands)) {
            resData.commands.forEach(cmd => handleCommand(cmd));
        }
    }
  } catch (e) {
    console.error("发送给Python失败", e);
    logToUI(`连接 Python 失败: ${e.message}`, 'error');
  }
}

function updateStatus(text, color) {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = text;
    status.style.color = color;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PYTHON_MSG') {
    const msgBox = document.getElementById('msg-box');
    const msgContent = document.getElementById('msg-content');
    
    if (msgBox && msgContent) {
        msgContent.textContent = request.message;
        msgBox.style.display = 'block';
        
        // 闪烁一下提醒
        msgBox.style.backgroundColor = '#e6f7ff';
        setTimeout(() => msgBox.style.backgroundColor = '#fff', 300);
    }
  }
});

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

    if (type === 'error') { color = '#ff6b6b'; icon = '❌'; }
    if (type === 'success') { color = '#69db7c'; icon = '✅'; }
    if (type === 'warn') { color = '#ffd43b'; icon = '⚠️'; }
    if (type === 'cmd') { color = '#4dabf7'; icon = '🤖'; }

    div.innerHTML = `<span style="color: #666;">[${time}]</span> <span style="margin-right:4px">${icon}</span><span style="color: ${color}">${msg}</span>`;
    
    // 改为插入到最前面 (最新的在上面)
    container.prepend(div);
    container.scrollTop = 0;
}

document.getElementById('clear-logs').addEventListener('click', (e) => {
    e.preventDefault();
    const container = document.getElementById('log-container');
    if (container) container.innerHTML = '<div style="color: #666;">等待指令...</div>';
});

// 辅助函数：获取当前活动标签页（兼容独立窗口模式）
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

    const isTikTokUrl = (u) => isInjectableUrl(u) && u.toLowerCase().includes('tiktok.com');

    // 1) 独立窗口模式：先尝试目标窗口的 active tab，但必须是可注入的 TikTok 页面
    if (targetWindowId) {
        const tabs = await chrome.tabs.query({
            active: true,
            windowId: Number.parseInt(targetWindowId, 10),
        });
        const t = tabs?.[0];
        if (t && isTikTokUrl(t.url)) return t;
    }

    // 2) 回退：优先找任意 TikTok 页面 tab（避免当前 active tab 是扩展页导致 executeScript 报错）
    try {
        const tiktokTabs = await chrome.tabs.query({
            url: ['*://*.tiktok.com/*', '*://tiktok.com/*'],
        });
        const activeTikTok = tiktokTabs.find((t) => t.active && isTikTokUrl(t.url));
        if (activeTikTok) return activeTikTok;
        const anyTikTok = tiktokTabs.find((t) => isTikTokUrl(t.url));
        if (anyTikTok) return anyTikTok;
    } catch {
        // ignore
    }

    // 3) 最后回退：当前窗口 active 的可注入页面
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs.find((t) => isInjectableUrl(t.url));
}


// --- 轮询 Python 指令 ---
let isConnected = true;
let connectionErrorCount = 0;

async function pollPythonCommands() {
    try {
        // TikTok 专用 - 只轮询 8099 端口
        const response = await fetch(`http://localhost:${PORT}/poll`);
        
        if (response.ok) {
            if (!isConnected) {
                isConnected = true;
                logToUI('✅ 已连接到 Python 服务', 'success');
                connectionErrorCount = 0;
                const status = document.getElementById('status');
                if(status) {
                    status.textContent = '已连接';
                    status.style.color = '#69db7c';
                }
            }
            
            const data = await response.json();
            
            // 兼容处理: 支持 command (单数) 和 commands (复数)
            if (data.command) {
                console.log(`[Plugin Poll TikTok:${PORT}] 收到指令:`, data.command);
                handleCommand(data.command);
            }
            
            if (data.commands && data.commands.length > 0) {
                console.log(`[Plugin Poll TikTok:${PORT}] 收到指令列表:`, data.commands);
                for (const cmd of data.commands) {
                    handleCommand(cmd);
                }
            }
        }
    } catch (e) {
        // 连接失败处理
        if (isConnected) {
            isConnected = false;
            logToUI(`❌ 连接 Python 失败: ${e.message}`, 'error');
            const status = document.getElementById('status');
            if(status) {
                status.textContent = '连接失败';
                status.style.color = '#ff6b6b';
            }
        }
    }
    
    // 继续轮询
    setTimeout(pollPythonCommands, 1000);
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    logToUI('插件已加载，等待操作...', 'info');
    
    const btnCapture = document.getElementById('btn-capture');
    const btnTest = document.getElementById('btn-test');
    const status = document.getElementById('status');

    if (btnCapture) {
        btnCapture.addEventListener('click', async () => {
            logToUI('正在捕获当前视频...', 'info');
            const tab = await getCurrentTab();
            if (tab) {
                logToUI(`目标标签页: ${tab.title}`, 'info');
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: getPageContent
                }, (results) => {
                    if (chrome.runtime.lastError) {
                        logToUI('执行脚本失败: ' + chrome.runtime.lastError.message, 'error');
                        return;
                    }
                    if (results && results[0] && results[0].result) {
                        const data = results[0].result;
                        // 确保 URL 和 Title 正确
                        data.url = tab.url;
                        // data.title 已经在 getPageContent 中获取了
                        sendToPython(data);
                        logToUI('已发送视频数据', 'success');
                        
                        // 更新 UI
                        const titleBox = document.getElementById('video-title');
                        const timeBox = document.getElementById('time-progress');
                        if (titleBox) titleBox.textContent = data.title || '未知标题';
                        if (timeBox) timeBox.textContent = `时间: ${data.extra_data.current_time} / ${data.extra_data.duration}`;
                    } else {
                        logToUI('未获取到页面数据', 'warn');
                    }
                });
            } else {
                logToUI('未找到活动标签页', 'error');
            }
        });
    } else {
        console.error('未找到 btn-capture 元素');
    }

    if (btnTest) {
        btnTest.addEventListener('click', async () => {
            logToUI('正在测试连接...', 'info');
            try {
                const response = await fetch(`http://localhost:${PORT}/poll`);
                if (response.ok) {
                    logToUI('连接成功!', 'success');
                    if(status) {
                        status.textContent = '已连接';
                        status.style.color = '#69db7c';
                    }
                } else {
                    logToUI('连接失败: ' + response.status, 'error');
                    if(status) {
                        status.textContent = '连接失败';
                        status.style.color = '#ff6b6b';
                    }
                }
            } catch (e) {
                logToUI('连接错误: ' + e.message, 'error');
                if(status) {
                    status.textContent = '连接错误';
                    status.style.color = '#ff6b6b';
                }
            }
        });
    } else {
        console.error('未找到 btn-test 元素');
    }
    
    // 启动轮询
    pollPythonCommands();
});

*/
