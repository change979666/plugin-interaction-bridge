// TikTok 智能助手 - 后台服务
// 端口: 8099

console.log('[TikTok Plugin Background] Service Worker 已启动 (端口 8099)');

// 点击插件图标时创建独立窗口
chrome.action.onClicked.addListener((tab) => {
  const targetWindowId = tab.windowId;
  chrome.windows.create({
    url: `popup.html?targetWindowId=${targetWindowId}`,
    type: "popup",
    width: 420,
    height: 600
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[TikTok Plugin] 插件已安装/更新 - TikTok 专用版本');
});

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[TikTok Plugin Background] 收到消息:', request);
  
  if (request.type === 'health_check') {
    sendResponse({ status: 'ok', platform: 'tiktok', port: 8099 });
  }
  
  return true; // 保持消息通道开放
});

// 定期检查 Python 服务连接
setInterval(async () => {
  try {
    const response = await fetch('http://localhost:8099/poll');
    if (response.ok) {
      console.log('[TikTok Plugin] Python 服务正常 (8099)');
    }
  } catch (e) {
    // 静默失败，不打印太多日志
  }
}, 30000); // 每 30 秒检查一次
