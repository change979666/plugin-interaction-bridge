// 注入页面函数集合：这些函数会通过 chrome.scripting.executeScript 注入到 tiktok.com 页面
// 要求：函数必须自包含，不能引用 popup 页面作用域变量。

// ===== 阶段 A：稳定 videoKey 提取 =====
// 用于生成稳定且唯一的视频标识，供 guard/去重使用
function getStableVideoKey() {
    // 策略 1：优先从 URL 提取视频 ID（最稳定）
    try {
        const href = String(location.href || '');
        const match = href.match(/\/video\/(\d+)/);
        if (match && match[1]) {
            const videoId = match[1].trim();
            if (videoId) return `video:${videoId}`;
        }
    } catch {
        // ignore
    }

    // 策略 2：从全局变量中提取（如果已经被其他逻辑写入）
    try {
        const vid = String(window.__TK_CURRENT_VIDEO_ID__ || '').trim();
        if (vid && vid.length > 5) return `video:${vid}`;
    } catch {
        // ignore
    }

    // 策略 3：尝试从页面 DOM 中寻找稳定标识
    try {
        // TikTok 视频容器通常有 data-e2e 属性
        const container = document.querySelector('[data-e2e="recommend-list-item-container"]');
        if (container) {
            // 尝试从容器或其子元素中提取任何形式的 ID
            const allElements = container.querySelectorAll('[id], [data-id], [data-video-id]');
            for (const el of allElements) {
                const id = el.id || el.getAttribute('data-id') || el.getAttribute('data-video-id');
                if (id && id.length > 5 && /^\d+$/.test(id)) {
                    return `video:${id}`;
                }
            }
        }
    } catch {
        // ignore
    }

    // 策略 4：从当前播放的 video 元素的属性中提取
    try {
        const videos = Array.from(document.querySelectorAll('video'));
        for (const v of videos) {
            const rect = v.getBoundingClientRect();
            if (rect.width > 100 && rect.height > 100 && !v.paused) {
                // 检查 video 元素及其父元素的属性
                let parent = v.parentElement;
                for (let i = 0; i < 5 && parent; i++) {
                    const id = parent.id || parent.getAttribute('data-id') || parent.getAttribute('data-video-id');
                    if (id && id.length > 5 && /^\d+$/.test(id)) {
                        return `video:${id}`;
                    }
                    parent = parent.parentElement;
                }
            }
        }
    } catch {
        // ignore
    }

    // 策略 5：兜底使用 URL（去除 query 和 hash）
    try {
        const href = String(location.href || '');
        const cleanUrl = href.split('#')[0].split('?')[0];
        if (cleanUrl && cleanUrl.length > 10) return `url:${cleanUrl}`;
    } catch {
        // ignore
    }

    // 最后的最后：使用带时间戳的兜底 key（不推荐，但至少不会空）
    return `fallback:${Date.now()}`;
}

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

function _tk_getElementScreenPoint(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const vvLeft = vv?.offsetLeft || 0;
    const vvTop = vv?.offsetTop || 0;

    // Chrome 常见换算：
    // - 横向边框/阴影： (outerWidth - innerWidth) / 2
    // - 纵向浏览器 UI 高度： (outerHeight - innerHeight)
    const borderX = (window.outerWidth - window.innerWidth) / 2;
    const chromeY = (window.outerHeight - window.innerHeight);

    const cssX = rect.left + vvLeft + rect.width / 2;
    const cssY = rect.top + vvTop + rect.height / 2;

    const screenCssX = window.screenX + borderX + cssX;
    const screenCssY = window.screenY + chromeY + cssY;
    const dpr = window.devicePixelRatio || 1;

    return {
        ok: true,
        css: { x: cssX, y: cssY },
        screenCss: { x: screenCssX, y: screenCssY },
        screenDevice: { x: Math.round(screenCssX * dpr), y: Math.round(screenCssY * dpr) },
        dpr,
        debug: {
            screenX: window.screenX,
            screenY: window.screenY,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            borderX,
            chromeY,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            vvLeft,
            vvTop,
        },
    };
}

function _tk_findLikeButtonForNative() {
    const selectors = [
        'button[aria-pressed][aria-label*="like" i]',
        'button[aria-pressed][aria-label*="Like"]',
        '[data-e2e="like-icon"]',
        '[data-e2e="feed-like-icon"]',
        '[data-e2e="browse-like-icon"]',
        'button[aria-label*="like" i]',
        'button[aria-label*="喜欢"]',
        '[role="button"][aria-label*="like" i]',
    ];

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

    for (const sel of selectors) {
        let els = [];
        try {
            els = Array.from(document.querySelectorAll(sel));
        } catch {
            continue;
        }
        const hit = els.find(isVisible);
        if (!hit) continue;
        if (hit.tagName !== 'BUTTON' && !hit.getAttribute('role')) {
            const parentBtn = hit.closest('button, [role="button"]');
            if (parentBtn && isVisible(parentBtn)) return { el: parentBtn, selector: `${sel} -> parent` };
        }
        return { el: hit, selector: sel };
    }
    return null;
}

function tk_getNativeClickPoint_for_like() {
    // 注意：此函数会被 executeScript 单独序列化注入页面，必须自包含。
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

    const findLikeButton = () => {
        const selectors = [
            'button[aria-pressed][aria-label*="like" i]',
            'button[aria-pressed][aria-label*="Like"]',
            '[data-e2e="like-icon"]',
            '[data-e2e="feed-like-icon"]',
            '[data-e2e="browse-like-icon"]',
            'button[aria-label*="like" i]',
            'button[aria-label*="喜欢"]',
            '[role="button"][aria-label*="like" i]',
        ];

        for (const sel of selectors) {
            let els = [];
            try {
                els = Array.from(document.querySelectorAll(sel));
            } catch {
                continue;
            }
            const hit = els.find(isVisible);
            if (!hit) continue;
            if (hit.tagName !== 'BUTTON' && !hit.getAttribute('role')) {
                const parentBtn = hit.closest('button, [role="button"]');
                if (parentBtn && isVisible(parentBtn)) {
                    return { el: parentBtn, selector: `${sel} -> parent` };
                }
            }
            return { el: hit, selector: sel };
        }
        return null;
    };

    const getElementScreenPoint = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const vvLeft = vv?.offsetLeft || 0;
        const vvTop = vv?.offsetTop || 0;

        const borderX = (window.outerWidth - window.innerWidth) / 2;
        const chromeY = (window.outerHeight - window.innerHeight);

        const cssX = rect.left + vvLeft + rect.width / 2;
        const cssY = rect.top + vvTop + rect.height / 2;

        const screenCssX = window.screenX + borderX + cssX;
        const screenCssY = window.screenY + chromeY + cssY;
        const dpr = window.devicePixelRatio || 1;

        return {
            ok: true,
            css: { x: cssX, y: cssY },
            screenCss: { x: screenCssX, y: screenCssY },
            screenDevice: {
                x: Math.round(screenCssX * dpr),
                y: Math.round(screenCssY * dpr),
            },
            dpr,
            debug: {
                screenX: window.screenX,
                screenY: window.screenY,
                outerWidth: window.outerWidth,
                outerHeight: window.outerHeight,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                borderX,
                chromeY,
                rect: {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                },
                vvLeft,
                vvTop,
            },
        };
    };

    const found = findLikeButton();
    if (!found?.el) return { ok: false, reason: 'no_like_button' };

    try {
        found.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
        // ignore
    }

    // 额外调试：确认此按钮中心点在视口中命中的元素
    let hitInfo = null;
    try {
        const r = found.el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        if (hit) {
            hitInfo = {
                at: { x: cx, y: cy },
                tag: String(hit.tagName || ''),
                id: String(hit.id || ''),
                role: String(hit.getAttribute?.('role') || ''),
                ariaLabel: String(hit.getAttribute?.('aria-label') || ''),
                dataE2e: String(hit.getAttribute?.('data-e2e') || ''),
                cls: String(hit.className || '').slice(0, 120),
            };
        } else {
            hitInfo = { at: { x: cx, y: cy }, none: true };
        }
    } catch {
        // ignore
    }

    const p = getElementScreenPoint(found.el);
    if (!p?.ok) return { ok: false, reason: 'no_point' };

    return {
        ok: true,
        selector: found.selector,
        point: p,
        hit: hitInfo,
        href: String(location.href || ''),
        title: String(document.title || ''),
        ariaPressed: String(found.el.getAttribute('aria-pressed') || ''),
        ariaLabel: String(found.el.getAttribute('aria-label') || ''),
    };
}

function tk_readLikeState_simple() {
    // 注意：此函数会被 executeScript 单独序列化注入页面，必须自包含。
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

    const selectors = [
        'button[aria-pressed][aria-label*="like" i]',
        'button[aria-pressed][aria-label*="Like"]',
        '[data-e2e="like-icon"]',
        '[data-e2e="feed-like-icon"]',
        '[data-e2e="browse-like-icon"]',
        'button[aria-label*="like" i]',
        'button[aria-label*="喜欢"]',
        '[role="button"][aria-label*="like" i]',
    ];

    for (const sel of selectors) {
        let els = [];
        try {
            els = Array.from(document.querySelectorAll(sel));
        } catch {
            continue;
        }
        const hit = els.find(isVisible);
        if (!hit) continue;
        const el =
            hit.tagName !== 'BUTTON' && !hit.getAttribute('role')
                ? hit.closest('button, [role="button"]')
                : hit;
        if (!el || !isVisible(el)) continue;
        return {
            ok: true,
            ariaPressed: String(el.getAttribute('aria-pressed') || ''),
            ariaLabel: String(el.getAttribute('aria-label') || ''),
            selector: sel,
        };
    }

    return { ok: false, reason: 'no_like_button' };
}

function tk_getNativeClickPoint_for_video_center() {
    // 注意：此函数会被 executeScript 单独序列化注入页面，必须自包含。
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
        if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) <= 0) return false;
        return true;
    };

    const pickBestVideo = () => {
        const videos = Array.from(document.querySelectorAll('video'));
        let best = null;
        let bestScore = -1;
        for (const v of videos) {
            if (!isVisible(v)) continue;
            const rect = v.getBoundingClientRect();
            const vw = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
            const vh = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
            const area = Math.max(0, vw) * Math.max(0, vh);
            let score = area;
            try {
                if (!v.paused) score *= 1.5;
            } catch {
                // ignore
            }
            if (score > bestScore) {
                bestScore = score;
                best = v;
            }
        }
        return best;
    };

    const getRectSafeScreenPoint = (rect) => {
        const vv = window.visualViewport;
        const vvLeft = vv?.offsetLeft || 0;
        const vvTop = vv?.offsetTop || 0;

        const borderX = (window.outerWidth - window.innerWidth) / 2;
        const chromeY = (window.outerHeight - window.innerHeight);

        // 用偏左的“安全区”点，避免压到右侧操作栏导致误触（like/share 等）
        const cssX = rect.left + vvLeft + rect.width * 0.42;
        const cssY = rect.top + vvTop + rect.height * 0.50;

        const screenCssX = window.screenX + borderX + cssX;
        const screenCssY = window.screenY + chromeY + cssY;
        const dpr = window.devicePixelRatio || 1;

        return {
            ok: true,
            css: { x: cssX, y: cssY },
            screenCss: { x: screenCssX, y: screenCssY },
            screenDevice: { x: Math.round(screenCssX * dpr), y: Math.round(screenCssY * dpr) },
            dpr,
            debug: {
                screenX: window.screenX,
                screenY: window.screenY,
                outerWidth: window.outerWidth,
                outerHeight: window.outerHeight,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                borderX,
                chromeY,
                rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                vvLeft,
                vvTop,
            },
        };
    };

    const video = pickBestVideo();
    if (!video) return { ok: false, reason: 'no_video' };

    try {
        video.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
        // ignore
    }

    const rect = video.getBoundingClientRect();
    const p = getRectSafeScreenPoint(rect);
    if (!p?.ok) return { ok: false, reason: 'no_point' };

    // 调试：看看中心点压到谁（避免压到遮罩层按钮）
    let hit = null;
    try {
        const cx = Math.round(rect.left + rect.width * 0.42);
        const cy = Math.round(rect.top + rect.height * 0.50);
        const el = document.elementFromPoint(cx, cy);
        if (el) {
            hit = {
                at: { x: cx, y: cy },
                tag: String(el.tagName || ''),
                id: String(el.id || ''),
                role: String(el.getAttribute?.('role') || ''),
                ariaLabel: String(el.getAttribute?.('aria-label') || ''),
                dataE2e: String(el.getAttribute?.('data-e2e') || ''),
                cls: String(el.className || '').slice(0, 120),
            };
        } else {
            hit = { at: { x: cx, y: cy }, none: true };
        }
    } catch {
        // ignore
    }

    return {
        ok: true,
        point: p,
        hit,
        href: String(location.href || ''),
        title: String(document.title || ''),
    };
}

function tk_getNativeClickPoint_for_home_refresh() {
    // 注意：此函数会被 executeScript 单独序列化注入页面，必须自包含。
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
        if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) <= 0) return false;
        return true;
    };

    const normalizeText = (s) =>
        String(s || '')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

    const pickLeftNavRoot = () => {
        try {
            const navs = Array.from(document.querySelectorAll('nav'));
            let best = null;
            let bestScore = -1;
            for (const n of navs) {
                if (!isVisible(n)) continue;
                const r = n.getBoundingClientRect();
                // 倾向左侧、宽度不太大的导航
                if (r.left > window.innerWidth * 0.35) continue;
                if (r.width > window.innerWidth * 0.6) continue;
                if (r.height < 200) continue;
                const score = (window.innerWidth - r.left) + Math.min(500, r.height);
                if (score > bestScore) {
                    bestScore = score;
                    best = n;
                }
            }
            return best;
        } catch {
            return null;
        }
    };

    const getElementScreenPoint = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const vvLeft = vv?.offsetLeft || 0;
        const vvTop = vv?.offsetTop || 0;

        const borderX = (window.outerWidth - window.innerWidth) / 2;
        const chromeY = (window.outerHeight - window.innerHeight);

        const cssX = rect.left + vvLeft + rect.width / 2;
        const cssY = rect.top + vvTop + rect.height / 2;

        const screenCssX = window.screenX + borderX + cssX;
        const screenCssY = window.screenY + chromeY + cssY;
        const dpr = window.devicePixelRatio || 1;

        return {
            ok: true,
            css: { x: cssX, y: cssY },
            screenCss: { x: screenCssX, y: screenCssY },
            screenDevice: { x: Math.round(screenCssX * dpr), y: Math.round(screenCssY * dpr) },
            dpr,
            debug: {
                rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                vvLeft,
                vvTop,
            },
        };
    };

    const root = pickLeftNavRoot() || document;
    const wantExact = ['for you', '为你推荐', '推荐', 'home', '主页'];

    const clickableSelectors = 'a, button, [role="link"], [role="button"]';
    let nodes = [];
    try {
        nodes = Array.from(root.querySelectorAll(clickableSelectors));
    } catch {
        nodes = [];
    }

    const scoreCandidate = (el) => {
        const r = el.getBoundingClientRect();
        if (r.left > window.innerWidth * 0.45) return -1; // 必须在左侧区域
        const t = normalizeText(el.innerText || el.textContent || '');
        if (!t) return -1;
        let textScore = 0;
        for (const w of wantExact) {
            if (t === w) textScore = Math.max(textScore, 100);
            else if (t.includes(w)) textScore = Math.max(textScore, 60);
        }
        if (textScore <= 0) return -1;

        // 偏好更“像菜单项”的尺寸（避免选到整块容器）
        const area = Math.max(1, r.width * r.height);
        const areaPenalty = Math.min(40, Math.log(area) * 6);
        const leftBonus = Math.max(0, (window.innerWidth * 0.25 - r.left) / 10);
        return textScore + leftBonus - areaPenalty;
    };

    let best = null;
    let bestScore = -1;
    for (const el of nodes) {
        if (!isVisible(el)) continue;
        const sc = scoreCandidate(el);
        if (sc > bestScore) {
            bestScore = sc;
            best = el;
        }
    }

    // 兜底：有些结构文本在子 span 上，补一轮从所有 span 向上找可点击父级
    if (!best) {
        let spans = [];
        try {
            spans = Array.from(root.querySelectorAll('span, div'));
        } catch {
            spans = [];
        }
        for (const sp of spans) {
            if (!isVisible(sp)) continue;
            const t = normalizeText(sp.innerText || sp.textContent || '');
            if (!t) continue;
            const hit = wantExact.find((w) => t === w || t.includes(w));
            if (!hit) continue;
            const parent = sp.closest(clickableSelectors);
            if (parent && isVisible(parent)) {
                best = parent;
                break;
            }
        }
    }

    if (!best) return { ok: false, reason: 'no_home_entry' };

    const clickEl = best.closest(clickableSelectors) || best;
    if (!clickEl || !isVisible(clickEl)) return { ok: false, reason: 'home_entry_not_visible' };

    const p = getElementScreenPoint(clickEl);
    if (!p?.ok) return { ok: false, reason: 'no_point' };

    const matchedText = normalizeText(clickEl.innerText || clickEl.textContent || '').slice(0, 40);
    return {
        ok: true,
        point: p,
        matchedText,
        href: String(location.href || ''),
    };
}

function extractTargetText() {
    // IMPORTANT: 此函数会被 executeScript 单独序列化注入页面。
    // 因此必须完全自包含，不能引用 popup.js 里的其它 helper。

    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

    const pickActiveVideoAndRoot = () => {
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
            try { if (!v.paused) score *= 1.5; } catch {}
            if (score > maxScore) {
                maxScore = score;
                bestVideo = v;
            }
        }

        const root = bestVideo?.closest?.('[data-e2e="recommend-list-item-container"]') || document;
        return { root, bestVideo };
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

    const picked = pickActiveVideoAndRoot();
    const activeRoot = picked.root || document;
    const bestVideo = picked.bestVideo || null;
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

    const video = bestVideo || (isGlobalScope ? document.querySelector('video') : activeRoot.querySelector('video'));
    if (video && !Number.isNaN(video.duration)) {
        current = Math.round(video.currentTime || 0);
        duration = Math.round(video.duration || 0);
    }

    // 广告/赞助检测（尽量轻量：只扫少量 span/a 文本）
    const isSponsored = (() => {
        const want = ['sponsored', 'advertisement', '广告', '赞助', '推广'];
        const scan = (root) => {
            let nodes = [];
            try {
                nodes = Array.from((root || document).querySelectorAll('span, a, div'));
            } catch {
                nodes = [];
            }
            let seen = 0;
            for (const el of nodes) {
                if (seen++ > 80) break;
                if (!isVisible(el)) continue;
                // 避免误扫到导航/页脚等常驻区域
                try {
                    if (el.closest && el.closest('nav, header, footer')) continue;
                } catch {}
                const t = String(el.innerText || el.textContent || '').trim().toLowerCase();
                if (!t) continue;
                for (const w of want) {
                    if (t === w || t.includes(w)) return true;
                }
            }
            return false;
        };
        return scan(activeRoot);
    })();

    return { title, current, duration, href, videoId, is_sponsored: isSponsored };
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
        const pickActiveVideoAndRoot = () => {
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
                try { if (!v.paused) score *= 1.5; } catch {}
                if (score > maxScore) {
                    maxScore = score;
                    bestVideo = v;
                }
            }

            const root = bestVideo?.closest?.('[data-e2e="recommend-list-item-container"]') || document;
            return { root, bestVideo };
        };

        const picked = pickActiveVideoAndRoot();
        const activeRoot = picked.root || document;
        const bestVideo = picked.bestVideo || null;
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

        const video = bestVideo || (isGlobalScope ? document.querySelector('video') : activeRoot.querySelector('video'));
        if (video && !Number.isNaN(video.duration)) {
            current = Math.round(video.currentTime || 0);
            duration = Math.round(video.duration || 0);
        }

        const isSponsored = (() => {
            const want = ['sponsored', 'advertisement', '广告', '赞助', '推广'];
            const scan = (root) => {
                let nodes = [];
                try {
                    nodes = Array.from((root || document).querySelectorAll('span, a, div'));
                } catch {
                    nodes = [];
                }
                let seen = 0;
                for (const el of nodes) {
                    if (seen++ > 80) break;
                    if (!isVisible(el)) continue;
                    try {
                        if (el.closest && el.closest('nav, header, footer')) continue;
                    } catch {}
                    const t = String(el.innerText || el.textContent || '').trim().toLowerCase();
                    if (!t) continue;
                    for (const w of want) {
                        if (t === w || t.includes(w)) return true;
                    }
                }
                return false;
            };
            return scan(activeRoot);
        })();

        // 透传到 extra_data（供 popup 端过滤/排障）
        try {
            window.__TK_LAST_IS_SPONSORED__ = Boolean(isSponsored);
        } catch {}

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
        // 辅助函数：解析点赞数（支持 K, M, B, 万）
        const parseCount = (s) => {
            if (!s) return 0;
            let m = 1;
            const upper = String(s).toUpperCase();
            if (upper.includes('K')) m = 1000;
            else if (upper.includes('M')) m = 1000000;
            else if (upper.includes('B')) m = 1000000000;
            else if (upper.includes('万')) m = 10000;
            
            const numStr = String(s).replace(/,/g, '').replace(/[KkMmBb万]/g, '');
            return parseFloat(numStr) * m || 0;
        };

        const commentItems = Array.from(document.querySelectorAll('[class*="DivCommentItemWrapper"]')).filter(isVisible);
        // 扫描前30条，提取所有有效评论
        const tempComments = [];
        for (const item of commentItems.slice(0, 30)) {
            const authorEl = item.querySelector('[data-e2e="comment-username-1"]') || item.querySelector('a[href^="/@"]');
            const contentEl = item.querySelector('[data-e2e="comment-level-1"]') || item.querySelector('p[class*="TUXText"]');
            const likeContainer = item.querySelector('[class*="DivLikeContainer"]');
            const likesStr = likeContainer ? (likeContainer.querySelector('span')?.innerText || '0') : '0';
            const author = authorEl ? (authorEl.innerText || authorEl.textContent || '').trim() : 'User';
            const content = contentEl ? (contentEl.innerText || contentEl.textContent || '').trim() : '';
            if (!content) continue;
            tempComments.push({ 
                author, 
                content, 
                likes: likesStr,
                likesNum: parseCount(likesStr) 
            });
        }

        // 按点赞数倒序排序（和 YouTube 一样）
        tempComments.sort((a, b) => b.likesNum - a.likesNum);

        // 取前3条高赞评论
        for (const c of tempComments.slice(0, 3)) {
            comments.push({
                author: c.author,
                content: c.content,
                likes: c.likes
            });
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
            is_sponsored: (() => {
                try {
                    return Boolean(window.__TK_LAST_IS_SPONSORED__);
                } catch {
                    return false;
                }
            })(),
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
        'button[aria-pressed][aria-label*="like" i]',  // 最精确：带 pressed 状态的按钮
        '[data-e2e="like-icon"]',
        '[data-e2e="feed-like-icon"]',
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
    // 【简化版】真实鼠标模拟点击 - 去掉复杂的评分/归一化，直接找按钮+模拟点击
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // executeScript 注入要求自包含：内联一个稳定 videoKey（最少够用）
    const getStableVideoKeyLocal = () => {
        try {
            const href = String(location.href || '');
            const m = href.match(/\/video\/(\d+)/);
            if (m && m[1]) return `video:${m[1]}`;
        } catch {
            // ignore
        }
        try {
            const href = String(location.href || '');
            const clean = href.split('#')[0].split('?')[0];
            if (clean) return `url:${clean}`;
        } catch {
            // ignore
        }
        return `fallback:${Date.now()}`;
    };
    
    // videoKey 用于去重
    const _tkLikeGuardKey = getStableVideoKeyLocal();
    console.log(`[TikTok点赞] videoKey: ${_tkLikeGuardKey}`);
    
    // Guard 保护：避免重复点赞
    let _tkLikeGuard = null;
    try {
        window.__TK_LIKE_GUARD__ = window.__TK_LIKE_GUARD__ || { byVideo: {}, lastCleanupAt: 0 };
        _tkLikeGuard = window.__TK_LIKE_GUARD__;
        
        if (_tkLikeGuardKey && _tkLikeGuard?.byVideo?.[_tkLikeGuardKey]?.likedOnce) {
            console.log('[TikTok点赞] ⏭️ 该视频已点赞过，跳过');
            return { ok: true, skipped: true, alreadyLiked: true, reason: 'guard', videoKey: _tkLikeGuardKey };
        }
    } catch { }
    
    const _tkMarkLikedOnce = () => {
        if (!_tkLikeGuardKey || !_tkLikeGuard?.byVideo) return;
        _tkLikeGuard.byVideo[_tkLikeGuardKey] = { likedOnce: true, at: Date.now() };
        // 清理旧记录
        try {
            const keys = Object.keys(_tkLikeGuard.byVideo);
            if (keys.length > 220) {
                const sorted = keys.map((k) => ({ k, at: Number(_tkLikeGuard.byVideo[k]?.at || 0) })).sort((a, b) => b.at - a.at);
                const keep = new Set(sorted.slice(0, 200).map((x) => x.k));
                keys.forEach((k) => { if (!keep.has(k)) delete _tkLikeGuard.byVideo[k]; });
            }
        } catch { }
    };

    // 可见性检查
    const isVisible = (el) => {
        if (!el) return false;
        try {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
                rect.width > 0 &&
                rect.height > 0 &&
                rect.top < window.innerHeight &&
                rect.bottom > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                parseFloat(style.opacity) > 0
            );
        } catch {
            return false;
        }
    };

    // 【简化】选择器策略：按优先级直接找第一个可见按钮
    const selectors = [
        'button[aria-pressed][aria-label*="like" i]',     // 最精确
        'button[aria-pressed][aria-label*="Like"]',
        '[data-e2e="like-icon"]',                         // TikTok 专用
        '[data-e2e="feed-like-icon"]',
        '[data-e2e="browse-like-icon"]',
        'button[aria-label*="like" i]',                   // 通用
        'button[aria-label*="喜欢"]',
        '[role="button"][aria-label*="like" i]',
    ];

    let likeButton = null;
    let usedSelector = '';
    
    for (const sel of selectors) {
        try {
            const els = Array.from(document.querySelectorAll(sel));
            const hit = els.find(isVisible);
            if (hit) {
                // 如果找到的是 icon，向上找 button 父元素
                if (hit.tagName !== 'BUTTON' && !hit.getAttribute('role')) {
                    const parentBtn = hit.closest('button, [role="button"]');
                    if (parentBtn && isVisible(parentBtn)) {
                        likeButton = parentBtn;
                        usedSelector = `${sel} -> parent button`;
                        console.log(`[TikTok点赞] ✅ 找到按钮（通过icon）: ${sel}`);
                        break;
                    }
                }
                likeButton = hit;
                usedSelector = sel;
                console.log(`[TikTok点赞] ✅ 找到按钮: ${sel}`);
                break;
            }
        } catch (e) {
            console.warn(`[TikTok点赞] 选择器失败: ${sel}`, e);
        }
    }

    if (!likeButton) {
        console.error('[TikTok点赞] ❌ 未找到点赞按钮');
        return { ok: false, reason: 'no_like_button', videoKey: _tkLikeGuardKey };
    }

    console.log('[TikTok点赞] 📍 按钮信息:', {
        tag: likeButton.tagName,
        ariaPressed: likeButton.getAttribute('aria-pressed'),
        ariaLabel: likeButton.getAttribute('aria-label'),
        selector: usedSelector
    });

    // 检查是否已点赞
    const ariaPressed = likeButton.getAttribute('aria-pressed');
    const ariaLabel = String(likeButton.getAttribute('aria-label') || '').toLowerCase();
    const alreadyLiked = ariaPressed === 'true' || /unlike|已赞|取消赞/.test(ariaLabel);
    
    if (alreadyLiked) {
        console.log('[TikTok点赞] ⏭️ 按钮已点赞，跳过');
        _tkMarkLikedOnce();
        return { ok: true, skipped: true, alreadyLiked: true, reason: 'already_liked', videoKey: _tkLikeGuardKey };
    }

    // 记录点击前状态
    const beforePressed = likeButton.getAttribute('aria-pressed');
    const beforeLabel = likeButton.getAttribute('aria-label');
    
    console.log('[TikTok点赞] 🎯 开始点击...');
    
    // 【核心】真实鼠标模拟点击 - 简化同步版本
    try {
        // 1. 滚动到可见区域
        likeButton.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(50); // 等待滚动
        
        // 2. 计算中心点坐标
        const rect = likeButton.getBoundingClientRect();
        const x = Math.floor(rect.left + rect.width / 2);
        const y = Math.floor(rect.top + rect.height / 2);
        
        console.log(`[TikTok点赞] 🖱️ 模拟点击坐标: (${x}, ${y})`);
        
        // 3. 完整的鼠标事件链（同步触发）
        const eventOptions = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            button: 0,
            buttons: 1,
        };
        
        // 鼠标移入 hover
        likeButton.dispatchEvent(new MouseEvent('mouseover', eventOptions));
        likeButton.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
        await sleep(20);
        
        // 按下
        likeButton.dispatchEvent(new PointerEvent('pointerdown', { ...eventOptions, pointerId: 1, pointerType: 'mouse' }));
        likeButton.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        await sleep(50); // 模拟按下时长
        
        // 抬起
        likeButton.dispatchEvent(new PointerEvent('pointerup', { ...eventOptions, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
        likeButton.dispatchEvent(new MouseEvent('mouseup', { ...eventOptions, buttons: 0 }));
        
        // 点击
        likeButton.dispatchEvent(new MouseEvent('click', { ...eventOptions, buttons: 0, detail: 1 }));
        
        // 最后保险：原生 click
        try { likeButton.click(); } catch { }
        
        console.log('[TikTok点赞] ✔️ 事件已触发');
    } catch (e) {
        console.error('[TikTok点赞] 点击失败:', e);
    }
    
    // 等待 DOM 更新
    await sleep(600);
    
    // 验证点击结果
    const afterPressed = likeButton.getAttribute('aria-pressed');
    const afterLabel = likeButton.getAttribute('aria-label');
    const clicked = (beforePressed !== afterPressed) || (beforeLabel !== afterLabel);
    
    if (clicked) {
        console.log('[TikTok点赞] ✅ 点击成功！状态变化:', { beforePressed, afterPressed });
        _tkMarkLikedOnce();
        return {
            ok: true,
            clicked: true,
            toggled: true,
            likedState: afterPressed === 'true',
            videoKey: _tkLikeGuardKey,
            selector: usedSelector
        };
    } else {
        console.warn('[TikTok点赞] ⚠️ 点击后状态未变化');
        return {
            ok: false,
            clicked: false,
            reason: 'no_state_change',
            videoKey: _tkLikeGuardKey,
            selector: usedSelector
        };
    }
}

async function subscribe() {
    // 幂等关注：已关注就不再点击，避免重复指令导致“取消关注”
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };

    const hasDialog = () => {
        try {
            return Boolean(
                document.querySelector('[role="dialog"], div[aria-modal="true"], [data-e2e*="login" i], [class*="Login" i]')
            );
        } catch {
            return false;
        }
    };

    const findFirstVisible = (selectors) => {
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

    const selectors = [
        'button[data-e2e="follow-button"]',
        'button[data-e2e*="follow" i]',
        // 右侧关注通常是图标按钮，可能没有文本，但 aria-label 会包含 follow/关注
        'button[aria-label*="follow" i]',
        'button[aria-label*="following" i]',
        'button[aria-label*="关注" i]',
        'button[aria-label*="已关注" i]',
        // 兜底：页面上有些是 role=button
        '[role="button"][aria-label*="follow" i]',
        '[role="button"][aria-label*="关注" i]',
    ];

    const looksLikeBad = (el) => {
        const t = String(el?.innerText || el?.textContent || '').trim().toLowerCase();
        const al = String(el?.getAttribute?.('aria-label') || '').trim().toLowerCase();
        return (
            /\bsee more\b|\bmore\b|更多|展开|收起/.test(t) ||
            /\bsee more\b|\bmore\b|更多|展开|收起/.test(al)
        );
    };

    const isRightSideSmallButton = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        // 关注按钮大多在右侧栏
        if (rect.left < window.innerWidth * 0.62) return false;
        // 排除大面积容器
        if (rect.width > 180 || rect.height > 120) return false;
        return true;
    };

    const findFollowButton = () => {
        let best = null;
        for (const sel of selectors) {
            let els = [];
            try {
                els = Array.from(document.querySelectorAll(sel));
            } catch {
                continue;
            }
            const cands = els
                .filter(isVisible)
                .map((x) => x.closest('button, [role="button"]') || x)
                .filter(isVisible)
                .filter((x) => !looksLikeBad(x))
                .filter(isRightSideSmallButton);
            if (cands.length > 0) {
                best = cands[0];
                break;
            }
        }

        // 兜底：如果右侧策略完全找不到，再用最早的 visible（但仍排除 see more）
        if (!best) {
            const raw = findFirstVisible(selectors);
            if (raw && !looksLikeBad(raw)) best = raw;
        }
        return best;
    };

    const btn = findFollowButton();

    if (!btn) return { ok: false, reason: 'no_follow_button' };

    const readState = (el) => {
        const label0 = String(el?.getAttribute?.('aria-label') || '').toLowerCase();
        const text0 = String(el?.innerText || el?.textContent || '').trim().toLowerCase();
        const pressed0 = String(el?.getAttribute?.('aria-pressed') || '').toLowerCase();
        const cls0 = String(el?.className || '').toLowerCase();
        const followed0 =
            pressed0 === 'true' ||
            /\bfollowing\b|\bunfollow\b/.test(label0) ||
            /已关注|取消关注|正在关注/.test(label0) ||
            /\bfollowing\b|\bunfollow\b/.test(text0) ||
            /已关注|取消关注|正在关注/.test(text0) ||
            // 某些样式会在 class 里体现
            /following|unfollow/.test(cls0);
        return {
            label: label0,
            text: text0,
            pressed: pressed0,
            followed: Boolean(followed0),
        };
    };

    const before = readState(btn);

    if (before.followed) {
        return { ok: true, skipped: true, alreadyFollowed: true };
    }

    try {
        btn.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
        // ignore
    }

    const clickR = clickAtCenter(btn);

    await sleep(450);
    const btnAfter = findFollowButton() || btn;
    const after = readState(btnAfter);
    const dialog = hasDialog();

    if (after.followed) {
        return {
            ok: true,
            clicked: Boolean(clickR.ok),
            followed: true,
            beforeLabel: before.label.slice(0, 80),
            afterLabel: after.label.slice(0, 80),
            beforeText: before.text.slice(0, 40),
            afterText: after.text.slice(0, 40),
            hasDialog: dialog,
        };
    }

    if (dialog) {
        return {
            ok: false,
            clicked: Boolean(clickR.ok),
            followed: false,
            hasDialog: true,
            reason: 'blocked_by_dialog_or_login',
            beforeLabel: before.label.slice(0, 80),
            afterLabel: after.label.slice(0, 80),
            beforeText: before.text.slice(0, 40),
            afterText: after.text.slice(0, 40),
        };
    }

    return {
        ok: false,
        clicked: Boolean(clickR.ok),
        followed: false,
        hasDialog: false,
        reason: 'no_state_change',
        beforeLabel: before.label.slice(0, 80),
        afterLabel: after.label.slice(0, 80),
        beforeText: before.text.slice(0, 40),
        afterText: after.text.slice(0, 40),
    };
}

function tk_readFollowState_simple() {
    // 自包含：尽量可靠地读取“是否已关注”
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

    const looksLikeBad = (el) => {
        const t = String(el?.innerText || el?.textContent || '').trim().toLowerCase();
        const al = String(el?.getAttribute?.('aria-label') || '').trim().toLowerCase();
        return (
            /\bsee more\b|\bmore\b|更多|展开|收起/.test(t) ||
            /\bsee more\b|\bmore\b|更多|展开|收起/.test(al)
        );
    };

    const isRightSideSmallButton = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.left < window.innerWidth * 0.62) return false;
        if (rect.width > 180 || rect.height > 120) return false;
        return true;
    };

    const selectors = [
        'button[data-e2e="follow-button"]',
        'button[data-e2e*="follow" i]',
        'button[aria-label*="follow" i]',
        'button[aria-label*="following" i]',
        'button[aria-label*="关注" i]',
        'button[aria-label*="已关注" i]',
        '[role="button"][aria-label*="follow" i]',
        '[role="button"][aria-label*="关注" i]',
    ];

    let btn = null;
    for (const sel of selectors) {
        let els = [];
        try {
            els = Array.from(document.querySelectorAll(sel));
        } catch {
            continue;
        }
        const hit = els
            .filter(isVisible)
            .map((x) => x.closest('button, [role="button"]') || x)
            .filter(isVisible)
            .filter((x) => !looksLikeBad(x))
            .filter(isRightSideSmallButton)[0];
        if (hit) {
            btn = hit;
            break;
        }
    }
    if (!btn) return { ok: false, reason: 'no_follow_button' };

    const label = String(btn.getAttribute('aria-label') || '').toLowerCase();
    const text = String(btn.innerText || btn.textContent || '').trim().toLowerCase();
    const pressed = String(btn.getAttribute('aria-pressed') || '').toLowerCase();
    const cls = String(btn.className || '').toLowerCase();

    const followed =
        pressed === 'true' ||
        /\bfollowing\b|\bunfollow\b/.test(label) ||
        /已关注|取消关注|正在关注/.test(label) ||
        /\bfollowing\b|\bunfollow\b/.test(text) ||
        /已关注|取消关注|正在关注/.test(text) ||
        /following|unfollow/.test(cls);

    return {
        ok: true,
        followed: Boolean(followed),
        ariaLabel: label.slice(0, 80),
        text: text.slice(0, 40),
        ariaPressed: pressed,
    };
}

function tk_getNativeClickPoint_for_follow() {
    // 自包含：获取关注按钮坐标，用于桌面层点击
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

    const looksLikeBad = (el) => {
        const t = String(el?.innerText || el?.textContent || '').trim().toLowerCase();
        const al = String(el?.getAttribute?.('aria-label') || '').trim().toLowerCase();
        return (
            /\bsee more\b|\bmore\b|更多|展开|收起/.test(t) ||
            /\bsee more\b|\bmore\b|更多|展开|收起/.test(al)
        );
    };

    const isRightSideSmallButton = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.left < window.innerWidth * 0.62) return false;
        if (rect.width > 180 || rect.height > 120) return false;
        return true;
    };

    const getElementScreenPoint = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const vvLeft = vv?.offsetLeft || 0;
        const vvTop = vv?.offsetTop || 0;

        const borderX = (window.outerWidth - window.innerWidth) / 2;
        const chromeY = (window.outerHeight - window.innerHeight);

        const cssX = rect.left + vvLeft + rect.width / 2;
        const cssY = rect.top + vvTop + rect.height / 2;

        const screenCssX = window.screenX + borderX + cssX;
        const screenCssY = window.screenY + chromeY + cssY;
        const dpr = window.devicePixelRatio || 1;

        return {
            ok: true,
            css: { x: cssX, y: cssY },
            screenCss: { x: screenCssX, y: screenCssY },
            screenDevice: { x: Math.round(screenCssX * dpr), y: Math.round(screenCssY * dpr) },
            dpr,
            debug: {
                screenX: window.screenX,
                screenY: window.screenY,
                outerWidth: window.outerWidth,
                outerHeight: window.outerHeight,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                borderX,
                chromeY,
                rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                vvLeft,
                vvTop,
            },
        };
    };

    const selectors = [
        'button[data-e2e="follow-button"]',
        'button[data-e2e*="follow" i]',
        'button[aria-label*="follow" i]',
        'button[aria-label*="following" i]',
        'button[aria-label*="关注" i]',
        'button[aria-label*="已关注" i]',
        '[role="button"][aria-label*="follow" i]',
        '[role="button"][aria-label*="关注" i]',
    ];

    let btn = null;
    let used = '';
    for (const sel of selectors) {
        let els = [];
        try {
            els = Array.from(document.querySelectorAll(sel));
        } catch {
            continue;
        }
        const hit = els
            .filter(isVisible)
            .map((x) => x.closest('button, [role="button"]') || x)
            .filter(isVisible)
            .filter((x) => !looksLikeBad(x))
            .filter(isRightSideSmallButton)[0];
        if (hit) {
            btn = hit;
            used = sel;
            break;
        }
    }

    if (!btn) return { ok: false, reason: 'no_follow_button' };

    const point = getElementScreenPoint(btn);
    const hit = (() => {
        try {
            const rect = btn.getBoundingClientRect();
            const x = Math.floor(rect.left + rect.width / 2);
            const y = Math.floor(rect.top + rect.height / 2);
            const el = document.elementFromPoint(x, y);
            if (!el) return { none: true };
            return {
                none: false,
                tag: String(el.tagName || '').toLowerCase(),
                id: el.id || '',
                ariaLabel: el.getAttribute?.('aria-label') || '',
                dataE2e: el.getAttribute?.('data-e2e') || '',
            };
        } catch {
            return { none: true };
        }
    })();

    return {
        ok: Boolean(point?.ok),
        selector: used,
        point,
        hit,
        beforeText: String(btn.innerText || btn.textContent || '').trim().slice(0, 40),
        beforeLabel: String(btn.getAttribute('aria-label') || '').trim().slice(0, 80),
    };
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
            let t = (likeBtn && likeBtn.querySelector) ? (likeBtn.querySelector('span')?.innerText || '') : '';
            t = String(t || '').trim();

            if (!t) {
                t = String(likeBtn?.innerText || likeBtn?.textContent || '').trim();
            }

            if (!t) {
                const al = String(likeBtn?.getAttribute?.('aria-label') || '').trim();
                const m = al.match(/([0-9]+(?:\.[0-9]+)?\s*[KMB万]?)/i);
                if (m && m[1]) t = m[1].trim();
            }

            if (!t && item && item.querySelectorAll) {
                const spans = Array.from(item.querySelectorAll('span'));
                let best = '';
                let bestNum = 0;
                for (const sp of spans) {
                    const txt = String(sp.innerText || sp.textContent || '').trim();
                    if (!txt) continue;
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
                hasCommentsTab: Boolean(document.querySelector('#comments')),
                href: window.location.href,
            };
        }

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

            candidates.sort((a, b) => (b.countNum || 0) - (a.countNum || 0));

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

            let best = '';
            for (const c of candidates) {
                if (c.length > best.length) best = c;
            }
            return best;
        };

        const target = normalize(targetRaw);

        // 先尝试匹配
        let matchedIndex = -1;
        if (target) {
            for (let i = 0; i < commentItems.length; i++) {
                const item = commentItems[i];
                const txt = normalize(extractItemText(item));
                if (txt && txt.includes(target)) {
                    matchedIndex = i;
                    break;
                }
            }
        }

        const pos = matchedIndex >= 0 ? matchedIndex : Math.max(0, Math.min(commentItems.length - 1, idx - 1));
        const item = commentItems[pos];
        if (!item) {
            return { ok: false, reason: 'no_item', clickedCommentBtn, commentItemsCount: commentItems.length, index: idx };
        }
        const likeBtn =
            item.querySelector('div[class*="DivLikeContainer"][role="button"][aria-pressed]') ||
            item.querySelector('[role="button"][aria-pressed][aria-label*="Like" i]');
        if (!likeBtn) {
            return {
                ok: false,
                reason: 'no_like_button',
                clickedCommentBtn,
                commentItemsCount: commentItems.length,
                index: idx,
                matched: matchedIndex >= 0,
            };
        }

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
            clickedCommentBtn,
            commentItemsCount: commentItems.length,
            index: idx,
            matched: matchedIndex >= 0,
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

function nextVideoTikTok() {
    try {
        const event = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            code: 'ArrowDown',
            keyCode: 40,
            bubbles: true,
        });
        document.dispatchEvent(event);
        window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
        return { success: true, msg: '已尝试切换下一个视频' };
    } catch (e) {
        return { success: false, msg: `切换视频失败: ${e.message}` };
    }
}

function nextVideo() {
    // IMPORTANT: executeScript 注入函数必须自包含
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
            const canScroll = (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 50;
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
    dispatchKey('ArrowDown');
    dispatchKey('PageDown');
    const scrolled = tryScroll();
    return { ok: Boolean(byItem || scrolled || focused), by_item: Boolean(byItem) };
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

        let submit = findBtn();
        const waitStart = Date.now();
        while (!isEnabled(submit) && Date.now() - waitStart < 1500) {
            await new Promise((r) => setTimeout(r, 60));
            submit = findBtn();
        }

        if (!isEnabled(submit)) {
            try {
                editor.dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
                );
            } catch {
                // ignore
            }
            return {
                success: false,
                msg: '已填入评论，但 Post 按钮仍为禁用/未找到(可能未触发输入链路/未登录/被风控/需验证码)',
            };
        }

        try {
            submit.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
            // ignore
        }

        try {
            submit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            submit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } catch {
            submit.click();
        }

        const sentStart = Date.now();
        const getText = () => {
            try {
                return editor.isContentEditable ? String(editor.innerText || '').trim() : String(editor.value || '').trim();
            } catch {
                return '';
            }
        };

        while (Date.now() - sentStart < 2000) {
            if (!getText()) return { success: true, msg: '已点击发送评论(输入框已清空)' };
            await new Promise((r) => setTimeout(r, 80));
        }

        return { success: true, msg: '已点击发送评论(但输入框未清空，可能被拦截/风控/网络慢)' };
    } catch (e) {
        return { success: false, msg: `评论失败: ${e.message}` };
    }
}

async function tk_getNativeClickPoint_for_comment_input() {
    // 注意：此函数会被 executeScript 单独序列化注入页面，必须自包含。
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

    const getElementScreenPoint = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const vvLeft = vv?.offsetLeft || 0;
        const vvTop = vv?.offsetTop || 0;

        const borderX = (window.outerWidth - window.innerWidth) / 2;
        const chromeY = (window.outerHeight - window.innerHeight);

        const cssX = rect.left + vvLeft + rect.width / 2;
        const cssY = rect.top + vvTop + rect.height / 2;

        const screenCssX = window.screenX + borderX + cssX;
        const screenCssY = window.screenY + chromeY + cssY;
        const dpr = window.devicePixelRatio || 1;

        return {
            ok: true,
            css: { x: cssX, y: cssY },
            screenCss: { x: screenCssX, y: screenCssY },
            screenDevice: { x: Math.round(screenCssX * dpr), y: Math.round(screenCssY * dpr) },
            dpr,
            debug: {
                screenX: window.screenX,
                screenY: window.screenY,
                outerWidth: window.outerWidth,
                outerHeight: window.outerHeight,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                borderX,
                chromeY,
                rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                vvLeft,
                vvTop,
            },
        };
    };

    const findEditor = () => {
        const container = document.querySelector('[data-e2e="comment-input"]');
        const editor =
            (container && container.querySelector('[contenteditable="true"][role="textbox"]')) ||
            document.querySelector('[data-e2e="comment-text"] [contenteditable="true"][role="textbox"]') ||
            document.querySelector('[contenteditable="true"][role="textbox"].public-DraftEditor-content') ||
            document.querySelector('textarea') ||
            document.querySelector('div[contenteditable="true"]');

        if (editor && isVisible(editor)) return editor;
        return null;
    };

    const openComments = () => {
        const selectors = [
            'button[aria-label*="comment" i]',
            'button[aria-label*="评论" i]',
            '[data-e2e="comment-button"]',
            '[data-e2e="browse-comment"]',
            '[data-e2e="comment-icon"]',
            '[data-e2e="feed-comment-icon"]',
        ];
        for (const sel of selectors) {
            let els = [];
            try {
                els = Array.from(document.querySelectorAll(sel));
            } catch {
                continue;
            }
            for (const el of els) {
                if (!isVisible(el)) continue;
                const btn = el.closest('button, [role="button"]') || el;
                try {
                    btn.click();
                    return { ok: true, selector: sel };
                } catch {
                    // ignore
                }
            }
        }
        return { ok: false, reason: 'no_comment_button' };
    };

    let opened = false;
    let editor = findEditor();
    if (!editor) {
        const r = openComments();
        opened = Boolean(r.ok);
        await sleep(450);
        editor = findEditor();
    }

    if (!editor) {
        return { ok: false, reason: 'no_comment_input', openedComments: opened };
    }

    try {
        editor.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
        // ignore
    }

    const point = getElementScreenPoint(editor);
    const hit = (() => {
        try {
            const rect = editor.getBoundingClientRect();
            const x = Math.floor(rect.left + rect.width / 2);
            const y = Math.floor(rect.top + rect.height / 2);
            const el = document.elementFromPoint(x, y);
            if (!el) return { none: true };
            return {
                none: false,
                tag: String(el.tagName || '').toLowerCase(),
                id: el.id || '',
                ariaLabel: el.getAttribute?.('aria-label') || '',
                dataE2e: el.getAttribute?.('data-e2e') || '',
            };
        } catch {
            return { none: true };
        }
    })();

    return {
        ok: Boolean(point?.ok),
        openedComments: opened,
        point,
        hit,
        editor: {
            tag: String(editor.tagName || '').toLowerCase(),
            role: editor.getAttribute?.('role') || '',
            isContentEditable: Boolean(editor.isContentEditable),
        },
    };
}

function tk_readCommentEditorText() {
    // 自包含：读取评论输入框当前文本（用于验证是否发送成功）
    try {
        const container = document.querySelector('[data-e2e="comment-input"]');
        const editor =
            (container && container.querySelector('[contenteditable="true"][role="textbox"]')) ||
            document.querySelector('[data-e2e="comment-text"] [contenteditable="true"][role="textbox"]') ||
            document.querySelector('[contenteditable="true"][role="textbox"].public-DraftEditor-content') ||
            document.querySelector('textarea') ||
            document.querySelector('div[contenteditable="true"]');

        if (!editor) return { ok: false, reason: 'no_editor' };
        const text = editor.isContentEditable
            ? String(editor.innerText || '').trim()
            : String(editor.value || '').trim();
        return { ok: true, empty: !text, length: text.length, text: text.slice(0, 80) };
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

function tk_clickCommentPostButton() {
    // 自包含：尝试点击评论发送按钮
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
    const isEnabled = (btn) => {
        if (!btn) return false;
        const aria = String(btn.getAttribute('aria-disabled') || '').toLowerCase();
        return !(btn.disabled || aria === 'true');
    };
    const findBtn = () =>
        document.querySelector('[data-e2e="comment-post"]') ||
        document.querySelector('button[aria-label="Post" i]') ||
        document.querySelector('button[type="submit"]');

    try {
        const btn = findBtn();
        if (!btn || !isVisible(btn)) return { ok: false, reason: 'no_post_button' };
        if (!isEnabled(btn)) return { ok: false, reason: 'post_disabled' };
        try {
            btn.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {}
        try {
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } catch {
            try { btn.click(); } catch {}
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

function tk_detectCommentPostedToast() {
    // 自包含：尝试检测页面是否出现“评论已发布/Comment posted”提示（避免 Enter 已成功但输入框未及时清空导致二次点击 Post）
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= -10 &&
            rect.top < 260 &&
            rect.bottom > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) > 0
        );
    };

    const phrases = [
        'comment posted',
        'comment posted.',
        'posted',
        '评论已发布',
        '评论发布成功',
        '发布成功',
        '评论已发送',
        '发送成功',
    ];
    const matchText = (t) => {
        const s = String(t || '').trim().toLowerCase();
        if (!s) return false;
        return phrases.some((p) => s.includes(String(p).toLowerCase()));
    };

    try {
        const candidates = Array.from(
            document.querySelectorAll('[role="alert"], [aria-live], [data-e2e], div, span, p')
        );
        for (const el of candidates) {
            if (!isVisible(el)) continue;
            const txt = String(el.innerText || el.textContent || '').trim();
            if (!txt || txt.length > 80) continue;
            if (matchText(txt)) {
                const rect = el.getBoundingClientRect();
                return {
                    ok: true,
                    found: true,
                    text: txt.slice(0, 80),
                    rect: {
                        left: Math.round(rect.left),
                        top: Math.round(rect.top),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    },
                };
            }
        }
        return { ok: true, found: false };
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

// 注入到页面的函数：获取完整 HTML 及关键信息
function getPageContent() {
    const getText = (selector, root = document) => {
        const el = root.querySelector(selector);
        return el ? el.innerText.trim() : null;
    };

    const currentUrl = window.location.href.toLowerCase();
    const isTikTok = true;
    console.log(`[Plugin] Platform Check: URL=${currentUrl}, isTikTok=${isTikTok}`);

    const parseCount = (s) => {
        if (!s) return 0;
        let m = 1;
        const upper = String(s).toUpperCase();
        if (upper.includes('K')) m = 1000;
        else if (upper.includes('M')) m = 1000000;
        else if (upper.includes('B')) m = 1000000000;
        else if (upper.includes('万')) m = 10000;

        return parseFloat(String(s).replace(/,/g, '').replace(/[KkMmBb万]/g, '')) * m;
    };

    if (isTikTok) {
        console.log('[Plugin] 进入 TikTok 处理流程');
        let topComments = [];
        let commentCountStr = '0';
        let likeCountStr = '0';
        let duration = 0;
        let currentTime = 0;
        let realTitle = '';
        let hasInput = false;

        const getActiveContainer = () => {
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
                const feedItem = bestVideo.closest('[data-e2e="recommend-list-item-container"]');
                if (feedItem) return feedItem;
                return document;
            }

            return document;
        };

        const activeRoot = getActiveContainer();
        const isGlobalScope = activeRoot === document;

        const isVisible = (el) => {
            if (!el) return false;
            if (el.offsetParent === null) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
        };

        let descEl = null;
        if (isGlobalScope) {
            const descs = Array.from(document.querySelectorAll('[data-e2e="video-desc"]'));
            descEl = descs.find(isVisible);
        } else {
            descEl = activeRoot.querySelector('[data-e2e="video-desc"]');
        }

        if (descEl) realTitle = descEl.innerText;
        else {
            if (isGlobalScope) {
                const metaDesc = document.querySelector('meta[name="description"]');
                if (metaDesc) realTitle = metaDesc.content;
            }
        }

        const likeEl = isGlobalScope
            ? Array.from(document.querySelectorAll('[data-e2e="like-count"]')).find(isVisible)
            : activeRoot.querySelector('[data-e2e="like-count"]');
        if (likeEl) likeCountStr = likeEl.innerText;

        const commentCountEl = isGlobalScope
            ? Array.from(document.querySelectorAll('[data-e2e="comment-count"]')).find(isVisible)
            : activeRoot.querySelector('[data-e2e="comment-count"]');
        if (commentCountEl) commentCountStr = commentCountEl.innerText;

        let allComments = [];

        let commentScope = activeRoot;
        if (!isGlobalScope && activeRoot.querySelectorAll('[class*="DivCommentItemWrapper"]').length === 0) {
            commentScope = document;
        }

        const items = commentScope.querySelectorAll('[class*="DivCommentItemWrapper"]');
        if (items.length > 0) {
            for (let i = 0; i < Math.min(items.length, 30); i++) {
                const root = items[i];
                if (!isVisible(root)) continue;

                const authorEl = root.querySelector('[data-e2e="comment-username-1"]') || root.querySelector('a[href^="/@"]');
                const contentEl =
                    root.querySelector('[data-e2e="comment-level-1"]') || root.querySelector('p[class*="TUXText"]');
                const likeContainer = root.querySelector('[class*="DivLikeContainer"]');

                const author = authorEl ? authorEl.innerText : '';
                const content = contentEl ? contentEl.innerText : '';
                if (!author && !content) continue;

                const likesStr = likeContainer
                    ? likeContainer.querySelector('span')
                        ? likeContainer.querySelector('span').innerText
                        : '0'
                    : '0';

                allComments.push({
                    author: author || 'User',
                    content: content,
                    likes: likesStr,
                    likeNum: parseCount(likesStr),
                });
            }
        }

        if (allComments.length === 0) {
            const commentElements = commentScope.querySelectorAll('[data-e2e="comment-level-1"]');
            for (let i = 0; i < Math.min(commentElements.length, 30); i++) {
                const c = commentElements[i];
                if (!isVisible(c)) continue;

                const root = c.closest('[class*="DivCommentItemWrapper"]') || c.parentElement.parentElement;
                if (root) {
                    const authorEl = root.querySelector('[data-e2e="comment-username-1"]');
                    const likeContainer = root.querySelector('[class*="DivLikeContainer"]');
                    const likesStr = likeContainer
                        ? likeContainer.querySelector('span')
                            ? likeContainer.querySelector('span').innerText
                            : '0'
                        : '0';

                    allComments.push({
                        author: authorEl ? authorEl.innerText : 'User',
                        content: c.innerText,
                        likes: likesStr,
                        likeNum: parseCount(likesStr),
                    });
                }
            }
        }

        allComments.sort((a, b) => b.likeNum - a.likeNum);
        topComments = allComments.slice(0, 3).map((c) => ({ author: c.author, content: c.content, likes: c.likes }));

        const inputEl = document.querySelector('[data-e2e="comment-input"]');
        hasInput = !!inputEl;

        const video = activeRoot === document ? document.querySelector('video') : activeRoot.querySelector('video');
        if (video && !isNaN(video.duration)) {
            duration = Math.round(video.duration);
            currentTime = Math.round(video.currentTime);
        }

        return {
            title: realTitle,
            url: window.location.href,
            html: document.documentElement.outerHTML,
            platform: isTikTok ? 'tiktok' : 'tiktok',
            extra_data: {
                comments: topComments,
                has_input: hasInput,
                like_count: likeCountStr,
                comment_count: commentCountStr,
                duration: duration,
                current_time: currentTime,
            },
        };
    }

    return {
        title: getText('title') || document.title || '',
        url: window.location.href,
        html: document.documentElement.outerHTML,
        platform: 'tiktok',
        extra_data: {
            comments: [],
            has_input: false,
            like_count: '0',
            comment_count: '0',
            duration: 0,
            current_time: 0,
        },
    };
}
