// YouTube 插件后台脚本
chrome.action.onClicked.addListener((tab) => {
  const targetWindowId = tab.windowId;
  chrome.windows.create({
    url: `popup.html?targetWindowId=${targetWindowId}`,
    type: "popup",
    width: 400,
    height: 600
  });
});

// 监听 YouTube 标签页更新
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // 只处理 YouTube 页面
    if (!tab.url.includes('youtube.com')) {
      return;
    }

    // 屏蔽后台自动发送，避免覆盖 Popup 的详细数据
    /*
    try {
      await fetch('http://localhost:8088', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `[YouTube 自动追踪] ${tab.title}`,
          title: tab.title,
          url: tab.url,
          platform: 'youtube'
        })
      });
    } catch (error) {
      console.log('[YouTube Plugin] 自动发送失败:', error);
    }
    */
  }
});
