// TikTok 插件配置（为“多文件拆分”准备）
// IMPORTANT: 这里不要声明与 popup.js 相同名字的全局 const/let（例如 PORT/PLATFORM/BUILD_ID），
// 否则在 popup.html 同时加载多个脚本时会触发“Identifier has already been declared”。
(function () {
    const cfg = {
        PORT: 8099,
        PLATFORM: 'tiktok',
        BUILD_ID: '2025-12-28_tiktok_modular',
        LOOP_THRESHOLD: 5,
    };

    try {
        window.__TK_CONFIG__ = cfg;
        window.__TK_PLUGIN_BUILD__ = cfg.BUILD_ID;
        console.log(`[Plugin Build] ${cfg.BUILD_ID}`);
    } catch {
        // ignore
    }
})();
