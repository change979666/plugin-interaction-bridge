// ===========================
// YouTube 智能助手 - 独立插件
// 端口: 8088 | 平台: YouTube
// ===========================

const PORT = 8088;
const PLATFORM = 'youtube';

// 用于排障：确认当前运行脚本版本
const BUILD_ID = '2025-12-25_fix_tdz_and_null_listener';
try {
    window.__YT_PLUGIN_BUILD__ = BUILD_ID;
    console.log(`[Plugin Build] ${BUILD_ID}`);
} catch (e) {
    // ignore
}

// --- 轮询连接状态（必须放在顶部，避免 TDZ：pollPythonCommands 可能在后续声明前就被调用）---
let isConnected = false;
let connectionErrorCount = 0;

// 指令处理状态
let isProcessingCommand = false;
// 注意：不做“排队执行”。仅保留一个“单条缓冲”，避免忙时丢指令。
let pendingCommand = null;

async function executeIncomingCommand(cmd, source = 'poll') {
    if (!cmd || !cmd.type) return;

    const cmdNameCN = getCommandNameCN(cmd.type);
    const isHighPriority = cmd.type === 'monitor_next';

    // 高优先级：允许抢占
    if (isProcessingCommand && !isHighPriority) {
        pendingCommand = cmd;
        console.log(`[插件] ⏸️ 忙碌中，暂存最新指令: ${cmdNameCN} (source=${source})`);
        logToUI(`⏸️ 暂存指令: ${cmdNameCN} (正忙)`, 'warn');
        return;
    }

    if (isHighPriority && isProcessingCommand) {
        console.log(`[插件] 🚨 高优先级指令抢占: ${cmdNameCN} (source=${source})`);
        logToUI(`🚨 抢占执行: ${cmdNameCN}`, 'warn');
    }

    isProcessingCommand = true;
    try {
        await handleCommand(cmd);
        console.log(`[插件] ✅ 指令执行完成: ${cmdNameCN} (source=${source})`);
        logToUI(`✅ 完成: ${cmdNameCN}`, 'success');
    } catch (error) {
        console.error(`[插件] ❌ 指令执行失败: ${cmdNameCN} (source=${source})`, error);
        logToUI(`❌ 失败: ${cmdNameCN} - ${error.message}`, 'error');
    } finally {
        isProcessingCommand = false;

        // 如果有暂存指令，立即执行（只执行最新一条，不累积）
        if (pendingCommand) {
            const next = pendingCommand;
            pendingCommand = null;
            // 不阻塞当前栈
            setTimeout(() => {
                void executeIncomingCommand(next, 'pending');
            }, 0);
        }
    }
}

// 指令中文映射
const COMMAND_NAMES_CN = {
    'auto_comment': '自动评论',
    'monitor_next': '监控并跳转',
    'fill_comment': '填充评论',
    'like_video': '点赞视频',
    'subscribe': '关注频道',
    'open_comments': '打开评论区',
    'next_video': '下一个视频'
};

// 获取指令中文名称
function getCommandNameCN(cmdType) {
    return COMMAND_NAMES_CN[cmdType] || cmdType;
}

// 注入到页面的函数：尝试关注频道
function trySubscribe() {
    try {
        // --- YouTube 逻辑 ---
        // 1. 查找 Shorts 容器
        const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
        if (!activeShort) return { success: false, msg: "未找到活动视频容器" };

        // 2. 查找关注按钮容器
        // 用户提供的结构: .ytReelChannelBarViewModelReelSubscribeButton -> yt-subscribe-button-view-model -> button
        const subscribeBtnContainer = activeShort.querySelector('.ytReelChannelBarViewModelReelSubscribeButton');
        
        if (!subscribeBtnContainer) {
            // 检查是否已经关注 (通常如果没有按钮，或者有 unsubscribe 按钮)
            // 有时候已关注会显示 "Subscribed" 按钮，或者根本不显示关注按钮
            return { success: false, msg: "未找到关注按钮 (可能已关注或广告)" };
        }

        // 3. 查找实际的按钮
        const btn = subscribeBtnContainer.querySelector('button');
        if (!btn) return { success: false, msg: "找到容器但未找到按钮" };

        // 4. 检查按钮文本 (防止点击取消关注)
        // 按钮内的文本通常在 .yt-spec-button-shape-next__button-text-content
        const textDiv = btn.querySelector('.yt-spec-button-shape-next__button-text-content');
        const textContent = (textDiv ? textDiv.innerText : (btn.innerText || btn.textContent || "")).trim().toLowerCase();
        
        if (textContent !== 'subscribe' && textContent !== '关注') {
             return { success: false, msg: `按钮文本不是 Subscribe (是 '${textContent}')` };
        }

        // 5. 点击
        btn.click();
        return { success: true, msg: "已点击关注" };

    } catch (e) {
        return { success: false, msg: "关注操作出错: " + e.message };
    }
}

// 注入到页面的函数：自动打开评论
function autoOpenComments() {
  try {
    const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
    if (!activeShort) return { success: false, msg: "未找到视频容器" };

    // 查找评论按钮
    // 策略：遍历所有按钮，寻找 aria-label 包含 "comment" 或 "评论" 的
    const buttons = activeShort.querySelectorAll('button');
    let commentBtn = null;
    let commentCount = 0;

    for (let btn of buttons) {
        const label = (btn.getAttribute('aria-label') || "").toLowerCase();
        
        // 检查是否是评论按钮
        if (label.includes('comment') || label.includes('评论')) {
            commentBtn = btn;
            
            // 解析数量
            if (label.includes('no ') || label.includes('没有') || label.includes('0 comments')) {
                commentCount = 0;
            } else {
                // 尝试提取数字 (支持 661, 1.2K, 1,234 等格式)
                const match = label.match(/([\d,.]+)/);
                if (match) {
                    let numStr = match[1].replace(/,/g, '');
                    commentCount = parseFloat(numStr);
                    // 处理单位 K, M, 万
                    if (label.toUpperCase().includes('K')) commentCount *= 1000;
                    if (label.toUpperCase().includes('M')) commentCount *= 1000000;
                    if (label.includes('万')) commentCount *= 10000;
                }
            }
            break; 
        }
    }

    // 备用策略：如果 aria-label 没找到，尝试找用户提供的特定结构
    // <button-view-model> -> <label> -> <button> -> ... -> <span>661</span>
    if (!commentBtn) {
        const labelSpans = activeShort.querySelectorAll('.yt-spec-button-shape-with-label__label span');
        for (let span of labelSpans) {
            // 简单的启发式：通常评论按钮是第二个带有数字的按钮（第一个是点赞，第二个是踩或评论？）
            // 这比较冒险，所以我们只看是否能找到对应的 button 且没有明确的 "like/dislike" 标记
            const btn = span.closest('button');
            if (btn) {
                const btnLabel = (btn.getAttribute('aria-label') || "").toLowerCase();
                if (!btnLabel.includes('like') && !btnLabel.includes('share') && !btnLabel.includes('subscribe')) {
                     // 假设这是评论按钮
                     const text = span.innerText.trim();
                     if (text && text !== '0' && text.toLowerCase() !== 'no') {
                         commentBtn = btn;
                         commentCount = 1; // 只要有文字且不是0，就假设有评论
                         break;
                     }
                }
            }
        }
    }

    if (commentBtn) {
        const label = String(commentBtn.getAttribute('aria-label') || '').toLowerCase();
        const looksZero =
            label.includes('0 comments') ||
            label.includes('no comments') ||
            label.includes('no comment') ||
            label.includes('没有评论') ||
            label.includes('0 条评论') ||
            label.includes('0条评论');

        if (looksZero || commentCount === 0) {
            // 明确 0 评论时不点，避免无意义打开
            return { success: false, msg: '评论数为0，不打开' };
        }

        // 新版 YouTube/Shorts 的 aria-label 可能不带数字，导致误判为 0。
        // 这里改为：只要找到评论按钮就点击，让后续抓取基于 DOM 实际内容判断是否有评论。
        setTimeout(() => commentBtn.click(), 350);
        return { success: true, msg: `已自动打开评论${commentCount > 0 ? ` (${commentCount}条)` : ''}` };
    }

    return { success: false, msg: "未找到评论按钮" };
  } catch (e) {
      return { success: false, msg: "自动点击出错: " + e.message };
  }
}

// 注入到页面的函数：暂停/继续播放（用于“抓评论期间避免自动切到下一条”）
function yt_pauseActiveVideo() {
    try {
        const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
        const video = (activeShort && activeShort.querySelector('video')) || document.querySelector('video');
        if (!video) return { ok: false, reason: 'no_video' };
        const wasPaused = Boolean(video.paused);
        video.pause();
        return { ok: true, wasPaused };
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

function yt_playActiveVideo() {
    try {
        const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
        const video = (activeShort && activeShort.querySelector('video')) || document.querySelector('video');
        if (!video) return { ok: false, reason: 'no_video' };
        void video.play?.();
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

// 注入到页面的函数：获取目标文本和时间
function extractTargetText() {
  // 辅助函数：检查元素是否有效
  const isValid = (el) => el && el.innerText && el.innerText.trim().length > 0;
  
  let title = "正在获取标题...";
  let timeInfo = { current: 0, duration: 0 };

  // --- YouTube 逻辑 ---
  // --- 获取时间 ---
  // 修正：优先直接读取 video 标签的时间，这是最准确的
  const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
      if (activeShort) {
          const video = activeShort.querySelector('video');
          if (video && !isNaN(video.duration)) {
              timeInfo.current = Math.round(video.currentTime);
              timeInfo.duration = Math.round(video.duration);
          }
      }

      // 如果没找到 (可能是普通视频)，再找全局的 slider 作为备用
      if (timeInfo.duration === 0) {
          let slider = null;
          if (activeShort) {
              slider = activeShort.querySelector('.ytPlayerProgressBarDragContainer[role="slider"]');
          }
          if (!slider) {
              slider = document.querySelector('.ytPlayerProgressBarDragContainer[role="slider"]');
          }

          if (slider) {
              const max = parseFloat(slider.getAttribute('aria-valuemax'));
              const now = parseFloat(slider.getAttribute('aria-valuenow'));
              if (!isNaN(max)) timeInfo.duration = Math.round(max);
              if (!isNaN(now)) timeInfo.current = Math.round(now);
          }
      }

      // --- 获取标题 ---
      // 1. [Shorts 专用] 查找当前激活的 Shorts 容器 (优先级最高)
      if (window.location.pathname.includes('/shorts/')) {
          const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
          if (activeShort) {
              // 1.1 [用户提供] 精确匹配 ytShortsVideoTitleViewModelShortsVideoTitle
              const specificH2 = activeShort.querySelector('h2.ytShortsVideoTitleViewModelShortsVideoTitle');
              if (isValid(specificH2)) title = specificH2.innerText;
              else {
                  // 1.2 尝试找 yt-shorts-video-title
                  const specificTitle = activeShort.querySelector('yt-shorts-video-title');
                  if (isValid(specificTitle)) title = specificTitle.innerText;
                  else {
                      // 1.3 尝试找任意 h2 (通常是标题)
                      const h2 = activeShort.querySelector('h2');
                      if (isValid(h2)) title = h2.innerText;
                      else {
                          // 1.4 过滤掉干扰项的通用查找
                          const candidates = activeShort.querySelectorAll('.yt-core-attributed-string');
                          for (let el of candidates) {
                              const text = el.innerText.trim();
                              if (text.length > 0 && 
                                  text !== 'View products' && 
                                  text !== 'Shop' && 
                                  !text.includes('View products')) {
                                  title = text;
                                  break;
                              }
                          }
                      }
                  }
              }
          }
      } else {
          // 2. 普通视频逻辑
          const dynamicH1 = document.querySelector('h1.dynamicTextViewModelH1');
          if (isValid(dynamicH1)) title = dynamicH1.innerText;
          else {
              // 3. 优先尝试用户指定的特定选择器
              const userElements = document.querySelectorAll('.yt-core-attributed-string.yt-core-attributed-string--white-space-pre-wrap.yt-core-attributed-string--link-inherit-color[role="text"]');
              let found = false;
              for (let el of userElements) {
                  if (isValid(el)) { title = el.innerText; found = true; break; }
              }
              if (!found) {
                  // 4. 尝试普通视频的主标题 (h1)
                  const videoTitle = document.querySelector('#title > h1 > yt-formatted-string');
                  if (isValid(videoTitle)) title = videoTitle.innerText;
                  else {
                      // 5. 泛用 h1
                      const h1 = document.querySelector('h1');
                      if (isValid(h1)) title = h1.innerText;
                      else {
                          // 6. 尝试从 meta 标签获取
                          const metaTitle = document.querySelector('meta[name="title"]');
                          if (metaTitle && metaTitle.content) title = metaTitle.content;
                          else title = document.title.replace(' - YouTube', '');
                      }
                  }
              }
          }
      }

  // --- 播放次数统计 (Loop Count) ---
  if (!window._loopTracker) {
      window._loopTracker = { url: '', count: 1, lastTime: 0 };
  }
  
  const currentUrl = window.location.href;
  // 切换视频时重置
  if (window._loopTracker.url !== currentUrl) {
      window._loopTracker.url = currentUrl;
      window._loopTracker.count = 1;
      window._loopTracker.lastTime = 0;
  }
  
  // 检测循环: 
  // 1. 上次时间接近结束 (> 80% 或 剩余<2秒)
  // 2. 当前时间接近开始 (< 2秒)
  // 3. 且发生了时间回跳 (last > current)
  if (timeInfo.duration > 0) {
      const t = timeInfo.current;
      const last = window._loopTracker.lastTime;
      const dur = timeInfo.duration;
      
      if (last > t && (last > dur * 0.8 || dur - last < 2) && t < 2) {
          window._loopTracker.count++;
          console.log(`[YouTube] 检测到循环，当前次数: ${window._loopTracker.count}`);
      }
      window._loopTracker.lastTime = t;
  }

  return { title, timeInfo, loopCount: window._loopTracker.count };
}

// 辅助函数：获取当前活动标签页（兼容独立窗口模式）
async function getCurrentTab() {
  const urlParams = new URLSearchParams(window.location.search);
  const targetWindowId = urlParams.get('targetWindowId');
  
  if (targetWindowId) {
    // 如果有目标窗口ID，直接查询该窗口的活动标签
    const tabs = await chrome.tabs.query({ active: true, windowId: parseInt(targetWindowId) });
    return tabs[0];
  } else {
    // 备用方案：如果没有参数（比如直接打开），尝试查找非插件窗口
    const tabs = await chrome.tabs.query({ active: true });
    const extensionId = chrome.runtime.id;
    // 过滤掉插件自身的页面
    return tabs.find(t => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('devtools://'));
  }
}

// 全局变量：当前视频的观看时长限制 (默认30秒)
let currentWatchLimit = 30;

// 全局变量：等待AI指令状态
let waitingForAICommand = false;
let currentVideoUrl = '';
let waitingTimeout = null;

// 辅助函数：生成随机延迟 (毫秒)
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// 辅助函数：带随机延迟的等待
const sleepRandom = (min, max) => new Promise(resolve => setTimeout(resolve, randomDelay(min, max)));

document.addEventListener('DOMContentLoaded', async () => {
  const targetContentDiv = document.getElementById('video-title');
  
  // 定义核心更新逻辑
  const updateTitle = async () => {
    try {
      const tab = await getCurrentTab();
      if (tab && !tab.url.startsWith('chrome://')) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractTargetText
        }, (results) => {
          if (results && results[0] && results[0].result) {
            const { title: newTitle, timeInfo, loopCount } = results[0].result;
            
            // 检查循环次数，超过3次强制跳过
            if (loopCount && loopCount > 3) {
                console.log(`[YouTube] ⚠️ 检测到视频循环 ${loopCount} 次，强制跳过...`);
                logToUI(`⚠️ 视频循环 ${loopCount} 次，强制跳过`, 'warn');
                updateStatus(`🔁 循环 ${loopCount} 次，即将跳过...`, 'orange');
                
                // 直接调用强制跳过
                startMonitorAndSkip(tab.id, 'loop_detected', 1);
                return;
            }
            
            // 0. 始终更新时间显示 (独立于标题变化)
            if (timeInfo) {
                const fmt = (s) => {
                    const m = Math.floor(s / 60).toString().padStart(2, '0');
                    const sec = (s % 60).toString().padStart(2, '0');
                    return `${m}:${sec}`;
                };
                const cur = fmt(timeInfo.current || 0);
                const dur = fmt(timeInfo.duration || 0);
                const timerEl = document.getElementById('time-progress');
                if (timerEl) {
                    // 显示时间 + 播放次数
                    const loopText = loopCount ? ` (Play: ${loopCount})` : '';
                    timerEl.textContent = `时间: ${cur} / ${dur}${loopText}`;
                }
            }

            // 只有当内容不同时才更新 DOM，避免闪烁
            if (targetContentDiv && targetContentDiv.textContent !== newTitle) {
                // 等待 AI 期间，如果视频已经自动切换（短视频常见），不要卡住：直接取消等待并继续处理新视频。
                // 过期的 AI 指令会在 handleCommand 里通过 target_url 校验被安全忽略。
                if (waitingForAICommand && currentVideoUrl && currentVideoUrl !== tab.url) {
                    console.log('[监控] 检测到视频切换，取消等待AI状态，继续检测新视频');
                    logToUI('⚠️ 视频已切换，取消等待AI，继续处理新视频', 'warn');
                    waitingForAICommand = false;
                    currentVideoUrl = '';
                    if (waitingTimeout) {
                        clearTimeout(waitingTimeout);
                        waitingTimeout = null;
                    }
                }
                
                // === 新增：通知服务器清空队列（防止旧指令干扰新视频）===
                (async () => {
                    try {
                        console.log(`\n${'='.repeat(60)}`);
                        console.log(`[插件] 🗑️ 视频切换检测`);
                        console.log(`  - 旧URL: ${currentVideoUrl || 'N/A'}`);
                        console.log(`  - 新URL: ${tab.url}`);
                        console.log(`  - 通知服务器清空旧指令`);
                        console.log('='.repeat(60) + '\n');
                        
                        const clearResponse = await fetch(`http://localhost:${PORT}/clear_queue`, {
                            method: 'POST'
                        });
                        if (clearResponse.ok) {
                            const clearData = await clearResponse.json();
                            if (clearData.cleared > 0) {
                                console.log(`[插件] ✅ 服务器已清空 ${clearData.cleared} 条旧指令`);
                                logToUI(`🗑️ 视频切换，清空 ${clearData.cleared} 条旧指令`, 'warn');
                            }
                        }
                    } catch (e) {
                        console.log('[插件] ⚠️ 清空服务器队列失败:', e.message);
                    }
                })();
                
                targetContentDiv.textContent = newTitle;
                targetContentDiv.style.fontWeight = 'bold';
                targetContentDiv.style.backgroundColor = '#e8f5e9';
                setTimeout(() => targetContentDiv.style.backgroundColor = 'white', 500);

                // --- 自动发送逻辑 (优化：等待评论加载后一次性发送) ---
                const expectedTabUrl = String(tab.url || '');
                let pausedForCommentLoad = false;
                const processContent = async (retryCount = 0) => {
                    const maxRetries = 15; // 增加重试次数到 15 次 (约 7.5 秒)
                    const isLastTry = retryCount >= maxRetries;

                    // 如果视频已切换，直接放弃本轮处理（避免把上一条的视频评论发给下一条）
                    try {
                        const tabNow = await chrome.tabs.get(tab.id);
                        const urlNow = String(tabNow?.url || '');
                        if (expectedTabUrl && urlNow && expectedTabUrl !== urlNow) {
                            logToUI('⚠️ 抓评论期间视频已切换，丢弃本次发送(避免错配)', 'warn');
                            updateStatus('⚠️ 视频已切换，已丢弃旧数据', 'orange');
                            // 尝试恢复播放（避免长时间暂停）
                            if (pausedForCommentLoad) {
                                try {
                                    await chrome.scripting.executeScript({
                                        target: { tabId: tab.id },
                                        func: yt_playActiveVideo,
                                    });
                                } catch {}
                            }
                            return;
                        }
                    } catch {
                        // ignore
                    }

                    // 评论加载慢：在首次处理时先暂停视频，避免 Shorts 自动切到下一条
                    if (retryCount === 0) {
                        try {
                            const r = await chrome.scripting.executeScript({
                                target: { tabId: tab.id },
                                func: yt_pauseActiveVideo,
                            });
                            if (r?.[0]?.result?.ok) pausedForCommentLoad = true;
                        } catch {
                            // ignore
                        }
                    }
                    
                    updateStatus(retryCount > 0 ? `等待评论加载 (${retryCount}/${maxRetries})...` : '检测到新视频，正在获取数据...', 'blue');
                    
                    try {
                        const contentResults = await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: getPageContent,
                        });

                        if (contentResults && contentResults[0] && contentResults[0].result) {
                            const data = contentResults[0].result;
                            const comments = data.extra_data?.comments || [];
                            
                            // 0.1 更新元素检测状态
                            if (data.extra_data && data.extra_data.element_status) {
                                updateElementStatus(data.extra_data.element_status);
                            }
                            
                            // 0.2 更新时间显示
                            if (data.extra_data) {
                                const fmt = (s) => {
                                    const m = Math.floor(s / 60).toString().padStart(2, '0');
                                    const sec = (s % 60).toString().padStart(2, '0');
                                    return `${m}:${sec}`;
                                };
                                const cur = fmt(data.extra_data.current_time || 0);
                                const dur = fmt(data.extra_data.duration || 0);
                                const timerEl = document.getElementById('time-progress');
                                if (timerEl) timerEl.textContent = `时间: ${cur} / ${dur}`;

                                // --- 广告/0时长检测 ---
                                if ((data.extra_data.duration || 0) <= 0) {
                                    if (!isLastTry) {
                                        setTimeout(() => processContent(retryCount + 1), 500);
                                        return;
                                    } else {
                                        logToUI("🚫 确认时长为0 (可能是广告)，跳过视频", "error");
                                        chrome.scripting.executeScript({
                                            target: { tabId: tab.id },
                                            func: () => {
                                                const event = new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true });
                                                document.dispatchEvent(event);
                                            }
                                        });
                                        return;
                                    }
                                }
                            }

                            // 1. 检查评论是否就绪
                            // 策略：如果评论列表为空，且不是最后一次尝试，则尝试打开评论区并等待
                            if (comments.length === 0 && !isLastTry) {
                                // 尝试自动打开评论区 (仅在第一次重试时执行)
                                if (retryCount === 0) {
                                    chrome.scripting.executeScript({
                                        target: { tabId: tab.id },
                                        func: autoOpenComments
                                    }).then(results => {
                                        if (results && results[0] && results[0].result) {
                                            console.log("自动打开评论结果:", results[0].result);
                                        }
                                    }).catch(e => console.error("自动打开评论失败:", e));
                                }
                                setTimeout(() => processContent(retryCount + 1), 500);
                                return;
                            }

                            // 1.5 过滤逻辑 (点赞<1000, 评论<100, 时长<10s)
                            // 只有在获取到评论后(或者最后一次尝试)才进行判断，避免因加载慢误判
                            if (comments.length > 0 || isLastTry) {
                                console.log(`[Process] 进入处理流程: Comments=${comments.length}, Retry=${retryCount}`);
                                
                                const parseCount = (str) => {
                                    if (!str) return 0;
                                    str = str.toString().toUpperCase().replace(/,/g, '').trim();
                                    let multiplier = 1;
                                    if (str.includes('K')) multiplier = 1000;
                                    if (str.includes('M')) multiplier = 1000000;
                                    if (str.includes('万')) multiplier = 10000;
                                    let num = parseFloat(str.replace(/[K|M|万]/g, ''));
                                    return isNaN(num) ? 0 : num * multiplier;
                                };

                                const rawLikeCount = data.extra_data.like_count || "";
                                const rawCommentCount = data.extra_data.comment_count || "";
                                
                                // 用户强制要求：只要带 K/M/万，直接视为合格，不进行数字解析过滤
                                const isLargeNumber = (str) => {
                                    if (!str) return false;
                                    const s = str.toString().toUpperCase();
                                    // 1. 显式单位
                                    if (s.includes('K') || s.includes('M') || s.includes('B') || s.includes('万')) return true;
                                    // 2. 隐式缩写 (包含小数点)
                                    // YouTube 赞数是整数，只有缩写时才会有小数点 (如 4.7, 1.2)，这意味着它后面肯定跟了单位但被截断了
                                    // 或者是 1.2K 这种格式。普通数字如 999 或 1,000 不会有小数点。
                                    if (s.includes('.')) return true;
                                    return false;
                                };

                                const likeCount = parseCount(rawLikeCount);
                                const commentCount = parseCount(rawCommentCount);
                                const duration = data.extra_data.duration || 0;
                                const title = newTitle || data.title || ""; // 优先使用 newTitle (来自 extractTargetText 的精确抓取)

                                // 语言检测：必须包含中文或英文字母
                                const hasChinese = /[\u4e00-\u9fa5]/.test(title);
                                const hasEnglish = /[a-zA-Z]/.test(title);

                                // 重置观看时长 (默认看完，设为3600秒)
                                currentWatchLimit = 3600;

                                let filterReason = "";
                                if (duration < 10) filterReason = `时长过短 (${duration}s < 10s)`;
                                else if (!hasChinese && !hasEnglish) filterReason = `非中英文标题`;
                                else {
                                    const isHighLikes = isLargeNumber(rawLikeCount) || likeCount >= 1000;
                                    const isHighComments = isLargeNumber(rawCommentCount) || commentCount >= 50;

                                    // 1. 极低质量 (点赞 < 10 或 评论 < 5) -> 立即跳过 (增加随机延迟 1-3秒)
                                    if (!isHighLikes && likeCount < 10) {
                                        filterReason = `点赞极少 (${likeCount} < 10)`;
                                        currentWatchLimit = randomDelay(1, 3);
                                    }
                                    else if (!isHighComments && commentCount < 5) {
                                        filterReason = `评论极少 (${commentCount} < 5)`;
                                        currentWatchLimit = randomDelay(1, 3);
                                    }
                                    // 2. 中等热度 (10 <= 点赞 < 500) -> 看10秒
                                    else if (!isHighLikes && likeCount < 500) {
                                        filterReason = `中等热度 (${likeCount}) - 只看10秒`;
                                        currentWatchLimit = 10;
                                    }
                                    // 3. 良好热度 (500 <= 点赞 < 1000) -> 看30秒
                                    else if (!isHighLikes && likeCount < 1000) {
                                        filterReason = `良好热度 (${likeCount}) - 只看30秒`;
                                        currentWatchLimit = 30;
                                    }
                                    // 4. 高赞但低评 (点赞 >= 1000 但 评论 < 50) -> 看完但不问AI
                                    else if (!isHighComments) {
                                        filterReason = `高赞低评 (赞${rawLikeCount}, 评${commentCount}) - 自动看完`;
                                        currentWatchLimit = 3600;
                                    }
                                    // 5. 高赞高评 (点赞 >= 1000 且 评论 >= 50) -> 询问 AI
                                    // 此时 filterReason 为空，会继续执行后续的 sendToPython
                                }

                                if (filterReason) {
                                    logToUI(`🚫 过滤视频: ${filterReason}`, "warn");
                                    updateStatus(`🚫 已过滤: ${filterReason}`, "orange");
                                    
                                    // 低质量视频直接跳过，不需要等待AI指令
                                    waitingForAICommand = false;
                                    console.log('[Process] 低质量视频，直接跳过，不等待AI');
                                    
                                    // 启动监控并跳过 (传入计算好的 currentWatchLimit)
                                    // 恢复播放，交给后续跳转逻辑处理
                                    if (pausedForCommentLoad) {
                                        try {
                                            await chrome.scripting.executeScript({
                                                target: { tabId: tab.id },
                                                func: yt_playActiveVideo,
                                            });
                                        } catch {}
                                    }
                                    startMonitorAndSkip(tab.id, 'filtered', currentWatchLimit);
                                    return; // 终止发送
                                }
                            }

                            // 2. 更新 UI 显示评论
                            updateCommentsDisplay(comments);

                            // 3. 构建消息并发送 (此时要么有评论，要么已超时)
                            let msg = `自动检测: ${newTitle}`;
                            if (data.extra_data) {
                                if (data.extra_data.has_input) msg += ` | 📝发现输入框`;
                                if (comments.length > 0) {
                                    msg += ` | 💬前${comments.length}热评:`;
                                    comments.forEach((c, i) => {
                                        const content = c.content ? c.content.substring(0, 15).replace(/\n/g, ' ') : '无内容';
                                        msg += ` [${i+1}]${content}...(${c.likes}赞)`;
                                    });
                                } else {
                                    msg += ` | (无评论或加载超时)`;
                                }
                            }

                            try {
                                // 发送前再次确认：仍然是同一个视频
                                try {
                                    const tabNow2 = await chrome.tabs.get(tab.id);
                                    const urlNow2 = String(tabNow2?.url || '');
                                    if (expectedTabUrl && urlNow2 && expectedTabUrl !== urlNow2) {
                                        logToUI('⚠️ 发送前检测到视频已切换，取消发送(避免错配)', 'warn');
                                        updateStatus('⚠️ 视频已切换，取消发送', 'orange');
                                        if (pausedForCommentLoad) {
                                            try {
                                                await chrome.scripting.executeScript({
                                                    target: { tabId: tab.id },
                                                    func: yt_playActiveVideo,
                                                });
                                            } catch {}
                                        }
                                        return;
                                    }
                                } catch {
                                    // ignore
                                }

                                // 评论加载已完成：恢复播放，避免停留太久
                                if (pausedForCommentLoad) {
                                    try {
                                        await chrome.scripting.executeScript({
                                            target: { tabId: tab.id },
                                            func: yt_playActiveVideo,
                                        });
                                    } catch {}
                                }

                                updateStatus('📤 正在发送数据...', 'blue');
                                console.log('[Process] 准备发送数据...');

                                // 更新热门评论显示
                                if (data.extra_data && data.extra_data.comments) {
                                    updateCommentsDisplay(data.extra_data.comments);
                                }

                                // 更新元素检测状态显示
                                if (data.extra_data && data.extra_data.element_status) {
                                    updateElementStatus(data.extra_data.element_status);
                                }

                                const payload = { 
                                    message: msg,
                                    title: newTitle || data.title, // 优先使用 newTitle
                                    url: data.url,
                                    html_content: data.html,
                                    extra_data: data.extra_data,
                                    platform: data.platform
                                };
                                console.log('\n' + '='.repeat(60));
                                console.log('[Process] 准备发送 Payload');
                                console.log('[Process] - 平台:', data.platform);
                                console.log('[Process] - 标题:', (newTitle || data.title).substring(0, 50));
                                console.log('[Process] - URL:', data.url);
                                console.log('[Process] - 评论数量:', data.extra_data?.comments?.length || 0);
                                if (data.extra_data?.comments) {
                                    console.log('[Process] - 评论详情:');
                                    data.extra_data.comments.forEach((c, i) => {
                                        console.log(`  [${i+1}] ${c.author}: ${c.content.substring(0, 30)}... (${c.likes}赞)`);
                                    });
                                }
                                console.log('='.repeat(60) + '\n');

                                await sendToPython(payload);
                                updateStatus('✅ 数据已同步 - ⏳ 等待AI决策', 'blue');
                                
                                // 设置等待AI指令状态
                                waitingForAICommand = true;
                                currentVideoUrl = data.url;
                                console.log('[Process] 设置等待AI指令状态，视频URL:', currentVideoUrl);
                                logToUI('⏳ 数据已发送，等待AI决策指令...', 'info');
                                
                                // 设置超时保护（避免 AI 无响应导致一直卡住）
                                if (waitingTimeout) clearTimeout(waitingTimeout);
                                waitingTimeout = setTimeout(() => {
                                    if (waitingForAICommand) {
                                        console.log('[Process] ⚠️ 等待AI指令超时（120秒），自动取消等待状态');
                                        logToUI('⚠️ AI决策等待超时，已恢复正常流程', 'warn');
                                        waitingForAICommand = false;
                                        currentVideoUrl = '';
                                        updateStatus('⚠️ AI超时，已恢复', 'orange');
                                    }
                                }, 120000);
                            } catch (err) {
                                console.error("自动发送失败", err);
                                updateStatus('自动发送失败: ' + err.message, 'orange');
                            }
                        } else {
                            // 脚本执行返回空，重试
                            if (!isLastTry) {
                                setTimeout(() => processContent(retryCount + 1), 500);
                            } else {
                                updateStatus('❌ 获取数据失败 (重试耗尽)', 'red');
                                logToUI('自动获取数据失败: 脚本返回空', 'error');
                            }
                        }
                    } catch (e) {
                        console.error("执行脚本失败", e);
                        // 脚本执行出错，重试
                        if (!isLastTry) {
                            setTimeout(() => processContent(retryCount + 1), 500);
                        } else {
                            updateStatus('❌ 脚本执行出错', 'red');
                            logToUI(`自动执行出错: ${e.message}`, 'error');
                        }
                    }
                };

                // 启动处理流程
                processContent(0);
                // -------------------
            }
          } else {
            // 如果真的找不到，才显示未找到
            if (targetContentDiv.textContent !== '未找到视频标题') {
                targetContentDiv.innerHTML = '<span style="color:#999">未找到视频标题</span>';
            }
          }
        });
      } else {
        targetContentDiv.textContent = '无法在系统页面运行';
      }
    } catch (e) {
      // 忽略一些临时错误
      console.log('更新跳过:', e.message);
    }
  };

  // 1. 立即执行一次
  await updateTitle();

  // 2. 开启轮询 (每 1 秒检查一次)，实现"实时"更新
  setInterval(async () => {
    await updateTitle();
  }, 1000);

  // 3. 启动指令轮询 (接收 Python 发来的操作)
  pollPythonCommands();

    // --- 按钮事件绑定 ---
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
                        data.url = tab.url;
                        sendToPython(data);
                        logToUI('已发送视频数据', 'success');
                        
                        // 更新 UI
                        const titleBox = document.getElementById('video-title');
                        const timeBox = document.getElementById('time-progress');
                        if (titleBox) titleBox.textContent = data.title || '未知标题';
                        if (timeBox && data.extra_data) {
                             const fmt = (s) => {
                                const m = Math.floor(s / 60).toString().padStart(2, '0');
                                const sec = (s % 60).toString().padStart(2, '0');
                                return `${m}:${sec}`;
                            };
                            timeBox.textContent = `时间: ${fmt(data.extra_data.current_time)} / ${fmt(data.extra_data.duration)}`;
                        }
                        
                        // 更新元素检测状态
                        if (data.extra_data && data.extra_data.element_status) {
                            updateElementStatus(data.extra_data.element_status);
                        }
                        
                        // 更新评论显示
                        if (data.extra_data && data.extra_data.comments) {
                            updateCommentsDisplay(data.extra_data.comments);
                        }
                    } else {
                        logToUI('未获取到页面数据', 'warn');
                    }
                });
            } else {
                logToUI('未找到活动标签页', 'error');
            }
        });
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
    }

    // 测试接收指令按钮
    const btnTestCommand = document.getElementById('btn-test-command');
    if (btnTestCommand) {
        btnTestCommand.addEventListener('click', async () => {
            logToUI('🧪 发送测试指令...', 'info');
            try {
                // 模拟从Python发送一个测试指令
                const testCmd = {
                    type: 'monitor_next',
                    platform: 'youtube',
                    reason: 'test'
                };
                
                // 直接调用handleCommand测试
                logToUI(`📥 模拟接收指令: ${testCmd.type}`, 'cmd');
                console.log('[Test] 调用 handleCommand:', testCmd);
                await handleCommand(testCmd);
                
            } catch (error) {
                logToUI('测试失败: ' + error.message, 'error');
            }
        });
    }
});

// 更新评论显示
function updateCommentsDisplay(comments) {
  const commentsBox = document.getElementById('comments-box');
  const commentsList = document.getElementById('comments-list');
  
  if (!comments || comments.length === 0) {
    commentsBox.style.display = 'none';
    return;
  }
  
  commentsBox.style.display = 'block';
  commentsList.innerHTML = '';
  
  comments.forEach(comment => {
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

// 更新元素检测状态显示
function updateElementStatus(elementStatus) {
  if (!elementStatus) return;
  
  const statusMap = {
    'status-subscribe': elementStatus.subscribe_button,
    'status-like': elementStatus.like_button,
    'status-comment-input': elementStatus.comment_input,
    'status-next': elementStatus.next_button
  };
  
  for (const [id, isFound] of Object.entries(statusMap)) {
    const el = document.getElementById(id);
    if (el) {
      if (isFound) {
        el.textContent = '✓';
        el.className = 'status status-ok';
      } else {
        el.textContent = '✗';
        el.className = 'status status-fail';
      }
    }
  }
  
  console.log('[UI] 元素状态已更新:', elementStatus);
}

const checkBtn = document.getElementById('check-page-btn');
const debugBtn = document.getElementById('debug-btn');
const debugConsole = document.getElementById('debug-console');
const debugContent = document.getElementById('debug-content');
const closeDebugBtn = document.getElementById('close-debug');
const copyDebugBtn = document.getElementById('copy-debug');
const status = document.getElementById('status');

// 调试按钮逻辑
if (debugBtn) {
    debugBtn.addEventListener('click', async () => {
      if (debugConsole) debugConsole.style.display = 'block';
      if (debugContent) debugContent.innerHTML = '<div style="color: #aaa;">正在分析页面结构...</div>';
      
      try {
        const tab = await getCurrentTab();
        if (!tab) {
            if (debugContent) debugContent.innerHTML = '<div style="color: #ff5252;">错误: 无法找到目标标签页</div>';
            return;
        }

        // 检查是否是受限制的 URL
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
            if (debugContent) debugContent.innerHTML = '<div style="color: #ff5252;">错误: 无法在浏览器系统页面运行</div>';
            return;
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: analyzePageStructure
        });

        if (results && results[0] && results[0].result) {
          renderDebugLogs(results[0].result);
        }
      } catch (e) {
        if (debugContent) debugContent.innerHTML = `<div style="color: #ff5252;">分析失败: ${e.message}</div>`;
      }
    });
}

if (closeDebugBtn) {
    closeDebugBtn.addEventListener('click', () => {
      if (debugConsole) debugConsole.style.display = 'none';
    });
}

if (copyDebugBtn) {
    copyDebugBtn.addEventListener('click', () => {
      if (!debugContent) return;
      const text = debugContent.innerText;
      navigator.clipboard.writeText(text).then(() => {
        const originalText = copyDebugBtn.innerText;
        copyDebugBtn.innerText = '[已复制!]';
        setTimeout(() => copyDebugBtn.innerText = originalText, 1500);
      });
    });
}

function renderDebugLogs(logs) {
    if (!debugContent) return;
    debugContent.innerHTML = '';
  logs.forEach(log => {
    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    div.style.borderLeft = `3px solid ${log.color}`;
    div.style.paddingLeft = '6px';
    
    const time = new Date().toLocaleTimeString();
    div.innerHTML = `<span style="color:rgba(255,255,255,0.78)">[${time}]</span> <span style="color: ${log.color}">${log.icon}</span> ${log.message}`;
    
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

  return logs;
}

// 检查页面按钮逻辑
const testSubscribeBtn = document.getElementById('test-subscribe-btn');
if (testSubscribeBtn) {
    testSubscribeBtn.addEventListener('click', async () => {
        updateStatus('正在测试关注按钮...', 'blue');
        const tab = await getCurrentTab();
        if (!tab) return;

        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: trySubscribe
        }, (results) => {
            if (results && results[0] && results[0].result) {
                const res = results[0].result;
                if (res.success) {
                    updateStatus('✅ ' + res.msg, 'green');
                    logToUI("测试成功: " + res.msg, "success");
                } else {
                    updateStatus('⚠️ ' + res.msg, 'orange');
                    logToUI("测试失败: " + res.msg, "warn");
                }
            } else {
                updateStatus('❌ 执行脚本失败', 'red');
            }
        });
    });
}

// 检查页面按钮逻辑（关键：必须判空，否则会导致脚本崩溃，轮询/收指令停止）
if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
        updateStatus('正在获取网址...', '#666');

        try {
            const tab = await getCurrentTab();

            if (!tab) {
                updateStatus('错误: 无法定位原始网页', 'red');
                return;
            }

            // 检查是否是受限制的 URL
            if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
                updateStatus('无法读取系统页面', 'orange');
                return;
            }

            updateStatus('正在读取页面结构...', 'blue');

            // 使用 executeScript 读取页面完整内容
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: getPageContent,
            });

            if (!results || !results[0] || !results[0].result) {
                throw new Error('读取页面失败');
            }

            const data = results[0].result;
            const sizeKB = Math.round(data.html.length / 1024);

            updateStatus(`正在发送 (${sizeKB}KB)...`, 'blue');

            // 发送给 Python
            await sendToPython({
                message: `手动获取页面: ${data.title}`,
                url: data.url,
                html_content: data.html,
                extra_data: data.extra_data, // 修复：确保手动发送时也包含评论等额外数据
                platform: data.platform,
            });

            updateStatus('✅ 结构已发送', 'green');
            logToUI(`手动发送成功: ${data.title}`, 'success');
        } catch (error) {
            console.error(error);
            updateStatus('失败: ' + error.message, 'red');
            logToUI(`手动获取失败: ${error.message}`, 'error');
        }

        // 启动/恢复指令轮询
        pollPythonCommands();
    });
} else {
    console.warn('[UI] 未找到 check-page-btn，已跳过绑定（不影响轮询）');
}

// 注入到页面的函数：获取完整 HTML 及关键信息
function getPageContent() {
  // 辅助函数：安全获取文本
  const getText = (selector, root = document) => {
    const el = root.querySelector(selector);
    return el ? el.innerText.trim() : null;
  };

  // YouTube 专用版本 - 简化的平台检测
  const currentUrl = window.location.href.toLowerCase();
  console.log(`[Plugin] YouTube Platform Check: URL=${currentUrl}`);

  // 初始化评论数和点赞数
  let commentCountStr = "0";
  let likeCountStr = "0";

  // 辅助：从一段文本中提取“数字 + 可选单位(K/M/B/万)”
  const extractCountToken = (s) => {
      if (!s) return null;
      const clean = String(s)
          .replace(/[\r\n]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const match = clean.match(/([\d,.]+)\s*([KkMmBb万])?/);
      return match ? match[1] + (match[2] || '') : null;
  };

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

  const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
  if (activeShort) {
      const buttons = activeShort.querySelectorAll('button');
      for (let btn of buttons) {
          const label = (btn.getAttribute('aria-label') || "").toLowerCase();
          const text = btn.innerText.trim();
          
          // 辅助提取函数
          const extract = (s) => {
              return extractCountToken(s);
          };

          // 提取评论数
          if (label.includes('comment') || label.includes('评论')) {
              // 优先尝试 innerText (所见即所得)
              if (text && /\d/.test(text)) {
                  const val = extract(text);
                  if (val) commentCountStr = val;
              } else {
                  // 回退到 aria-label
                  const val = extract(label);
                  if (val) commentCountStr = val;
              }
          }
          
          // 提取点赞数
          if ((label.includes('like') || label.includes('点赞')) && !label.includes('dislike') && !label.includes('踩')) {
               let valFromText = null;
               let valFromLabel = null;
               let valFromSibling = null;

               // 1. 从可见文本提取
               if (text && /\d/.test(text)) {
                   valFromText = extract(text);
               }
               
               // 2. 从 aria-label 提取
               if (label && /\d/.test(label)) {
                   valFromLabel = extract(label);
               }

               // 3. 从兄弟/父级节点提取 (针对 text 不在 button 内的情况)
               // 用户提供的结构: .yt-spec-button-shape-with-label__label
               const container = btn.closest('ytd-toggle-button-renderer') || btn.closest('ytd-button-renderer') || btn.parentElement;
               if (container) {
                   const labelDiv = container.querySelector('.yt-spec-button-shape-with-label__label');
                   if (labelDiv) {
                       const labelText = labelDiv.innerText.trim();
                       if (labelText && /\d/.test(labelText)) {
                           valFromSibling = extract(labelText);
                       }
                   }
               }

               // 4. 比较并取最大值
               const tempParse = (s) => {
                   if (!s) return -1;
                   let m = 1;
                   const upper = s.toUpperCase();
                   if (upper.includes('K')) m = 1000;
                   else if (upper.includes('M')) m = 1000000;
                   else if (upper.includes('B')) m = 1000000000;
                   else if (upper.includes('万')) m = 10000;
                   // 启发式：如果包含小数点且没有单位，通常意味着是缩写 (如 1.2 -> 1.2K)
                   // 因为点赞数不可能是小数
                   else if (s.includes('.')) m = 1000; 

                   return parseFloat(s.replace(/,/g, '').replace(/[KkMmBb万]/g, '')) * m;
               };

               const numText = tempParse(valFromText);
               const numLabel = tempParse(valFromLabel);
               const numSibling = tempParse(valFromSibling);

               const maxNum = Math.max(numText, numLabel, numSibling);
               
               if (maxNum === numSibling && numSibling > 0) likeCountStr = valFromSibling;
               else if (maxNum === numText && numText > 0) likeCountStr = valFromText;
               else if (maxNum === numLabel && numLabel > 0) likeCountStr = valFromLabel;
               else likeCountStr = valFromText || valFromSibling || valFromLabel || "0";
               
               // Debug
               if (maxNum > 0) {
                   console.log(`[Plugin] 点赞解析: Text=${valFromText}, Label=${valFromLabel}, Sibling=${valFromSibling} -> ${likeCountStr}`);
               }
          }
      }
  }
  // 普通视频页：补齐点赞/评论计数抓取（否则会一直是"0"导致高赞误判低赞）
  else {
      try {
          const watchRoot =
              document.querySelector('ytd-watch-flexy') ||
              document.querySelector('ytd-watch-metadata') ||
              document;

          // 评论数：评论标题区域通常自带计数（不依赖评论列表加载完成）
          const commentCountCandidates = [
              '#comments #count yt-formatted-string',
              'ytd-comments-header-renderer #count yt-formatted-string',
              'ytd-comments-header-renderer #count',
              '#comments #count',
          ];
          for (const sel of commentCountCandidates) {
              const t = getText(sel, document) || getText(sel, watchRoot);
              const token = extractCountToken(t);
              if (token) {
                  commentCountStr = token;
                  break;
              }
          }

          // 点赞数：尽量限定在顶栏按钮区域，避免误抓页面其它“like”字样
          const topButtons =
              watchRoot.querySelector('#top-level-buttons-computed') ||
              watchRoot.querySelector('#top-level-buttons') ||
              watchRoot;

          const likeButtonCandidates = [
              '#segmented-like-button button',
              'ytd-toggle-button-renderer button',
              'button[aria-label*="like"]',
              'button[aria-label*="赞"]',
          ];

          const seen = new Set();
          for (const sel of likeButtonCandidates) {
              const btns = Array.from(topButtons.querySelectorAll(sel));
              for (const btn of btns) {
                  if (!btn || seen.has(btn)) continue;
                  seen.add(btn);

                  const aria = String(btn.getAttribute('aria-label') || '');
                  const ariaLower = aria.toLowerCase();
                  if ((ariaLower.includes('dislike') || ariaLower.includes('踩')) && !ariaLower.includes('like this')) {
                      continue;
                  }
                  if (ariaLower.includes('dislike')) continue;
                  if (!(ariaLower.includes('like') || ariaLower.includes('赞') || ariaLower.includes('点赞'))) continue;

                  const textContent =
                      btn.querySelector('.yt-spec-button-shape-next__button-text-content')?.innerText?.trim() ||
                      btn.querySelector('.yt-spec-button-shape-with-label__label')?.innerText?.trim() ||
                      btn.innerText?.trim() ||
                      '';

                  const fromText = extractCountToken(textContent);
                  const fromAria = extractCountToken(aria);

                  // 取到一个有效 token 就结束（优先可见文本）
                  const token = fromText || fromAria;
                  if (token) {
                      likeCountStr = token;
                      break;
                  }
              }
              if (likeCountStr !== '0') break;
          }

          if (likeCountStr === '0' || commentCountStr === '0') {
              console.log(`[Plugin] 普通视频计数抓取(可能失败): like=${likeCountStr}, comment=${commentCountStr}, url=${window.location.href}`);
          }
      } catch (e) {
          console.warn('[Plugin] 普通视频页点赞/评论计数抓取异常:', e);
      }
  }

  // 4. 获取视频时长和当前进度
  let duration = 0;
  let currentTime = 0;
  let realTitle = document.title.replace(' - YouTube', '');
  let topComments = [];
  let hasInput = false;

  // --- 尝试获取评论 (如果评论区已打开/已渲染) ---
  // 新版 YouTube DOM 变动较快：这里做更宽松的容器/元素兼容，并对部分组件的 shadowRoot 做一次浅层探测。
  const _yt_isVisible = (el) => {
      try {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
      } catch {
          return false;
      }
  };

  const _yt_queryDeep = (root, selectors) => {
      if (!root) return null;
      const sels = Array.isArray(selectors) ? selectors : [selectors];

      for (const sel of sels) {
          try {
              const hit = root.querySelector(sel);
              if (hit) return hit;
          } catch {}
          try {
              const hit2 = root.shadowRoot ? root.shadowRoot.querySelector(sel) : null;
              if (hit2) return hit2;
          } catch {}
      }

      // 常见宿主组件浅层探测（限制数量，避免性能问题）
      let hosts = [];
      try {
          hosts = Array.from(root.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer, yt-attributed-string'));
      } catch {
          hosts = [];
      }
      for (const host of hosts.slice(0, 30)) {
          if (!host || !host.shadowRoot) continue;
          for (const sel of sels) {
              try {
                  const hit = host.shadowRoot.querySelector(sel);
                  if (hit) return hit;
              } catch {}
          }
      }
      return null;
  };

  const _yt_pickCommentsContainer = () => {
      // Shorts：右侧 engagement panel
      const shortsPanel =
          document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]') ||
          document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="comments"]') ||
          document.querySelector('ytd-engagement-panel-section-list-renderer[visibility*="ENGAGEMENT_PANEL_VISIBILITY"]');
      if (shortsPanel) return shortsPanel;

      // 普通视频：#comments / ytd-comments
      const normalComments = document.querySelector('#comments') || document.querySelector('ytd-comments');
      if (normalComments) return normalComments;

      // 旧结构/兜底
      return document.querySelector('#comments-results') || document.querySelector('ytd-comments-view-model');
  };

  const commentsContainer = _yt_pickCommentsContainer();
  if (commentsContainer) {
      // 优先选择“可见/已展开”的容器
      const containerToUse = _yt_isVisible(commentsContainer)
          ? commentsContainer
          : (_yt_queryDeep(commentsContainer, ['#contents', '#content', 'ytd-item-section-renderer#sections']) || commentsContainer);

      // 兼容不同的评论元素标签
      let commentElements = [];
      try {
          commentElements = Array.from(containerToUse.querySelectorAll('ytd-comment-thread-renderer'));
          if (commentElements.length === 0) commentElements = Array.from(containerToUse.querySelectorAll('ytd-comment-renderer'));
          if (commentElements.length === 0) commentElements = Array.from(containerToUse.querySelectorAll('ytd-comment-view-model'));
      } catch {
          commentElements = [];
      }

      console.log(`[Plugin] 找到 ${commentElements.length} 个评论元素`);

      if (commentElements.length > 0) {
          // 扫描前 15 个，过滤空内容
          for (let i = 0; i < Math.min(commentElements.length, 15); i++) {
              const el = commentElements[i];

              const contentEl = _yt_queryDeep(el, [
                  '#content-text',
                  'yt-attributed-string#content-text',
                  '#content #content-text',
              ]);
              const authorEl = _yt_queryDeep(el, [
                  '#author-text span',
                  'a#author-text',
                  '#author-text',
              ]);
              const likeEl = _yt_queryDeep(el, [
                  '#vote-count-middle',
                  '#vote-count-left',
                  '#vote-count',
                  'span[id^="vote-count"]',
              ]);

              const content = String(contentEl?.innerText || contentEl?.textContent || '').trim();
              if (!content) continue;

              topComments.push({
                  author: String(authorEl?.innerText || authorEl?.textContent || 'User').trim() || 'User',
                  content,
                  likes: String(likeEl?.innerText || likeEl?.textContent || '0').trim() || '0',
              });
          }

          // 按点赞数倒序排序，并取前 3
          topComments.sort((a, b) => parseCount(b.likes) - parseCount(a.likes));
          topComments = topComments.slice(0, 3);
          console.log(`[Plugin] 提取到 ${topComments.length} 条评论:`, topComments);
      }
  } else {
      console.log('[Plugin] 未找到评论容器');
  }
  
  // 检查是否有输入框
  const inputEl = document.querySelector('#contenteditable-root') || document.querySelector('#placeholder-area');
  hasInput = !!inputEl;
  
  // 优先尝试直接读取 video 标签
  if (activeShort) {
      const video = activeShort.querySelector('video');
      if (video && !isNaN(video.duration)) {
          duration = Math.round(video.duration);
          currentTime = Math.round(video.currentTime);
      }
      
      // --- 增强型标题获取 (同步 extractTargetText 逻辑) ---
      const isValid = (el) => el && el.innerText && el.innerText.trim().length > 0;
      
      // 1.1 [用户提供] 精确匹配 ytShortsVideoTitleViewModelShortsVideoTitle
      const specificH2 = activeShort.querySelector('h2.ytShortsVideoTitleViewModelShortsVideoTitle');
      if (isValid(specificH2)) realTitle = specificH2.innerText;
      else {
          // 1.2 尝试找 yt-shorts-video-title
          const specificTitle = activeShort.querySelector('yt-shorts-video-title');
          if (isValid(specificTitle)) realTitle = specificTitle.innerText;
          else {
              // 1.3 尝试找任意 h2 (通常是标题)
              const h2 = activeShort.querySelector('h2');
              if (isValid(h2)) realTitle = h2.innerText;
              else {
                  // 1.4 过滤掉干扰项的通用查找
                  const candidates = activeShort.querySelectorAll('.yt-core-attributed-string');
                  for (let el of candidates) {
                      const text = el.innerText.trim();
                      if (text.length > 0 && 
                          text !== 'View products' && 
                          text !== 'Shop' && 
                          !text.includes('View products')) {
                          realTitle = text;
                          break;
                      }
                  }
              }
          }
      }
  }

  // 备用：读取 slider
  if (duration === 0) {
      // 修正：优先查找当前活动视频容器内的进度条，避免获取到隐藏的或上一个视频的进度条
      let slider = null;
      if (activeShort) {
          slider = activeShort.querySelector('.ytPlayerProgressBarDragContainer[role="slider"]');
      }
      // 如果没找到，才尝试全局查找 (兼容普通视频模式)
      if (!slider) {
          slider = document.querySelector('.ytPlayerProgressBarDragContainer[role="slider"]');
      }
      
      if (slider) {
          const max = parseFloat(slider.getAttribute('aria-valuemax'));
          const now = parseFloat(slider.getAttribute('aria-valuenow'));
          if (!isNaN(max)) duration = Math.round(max);
          if (!isNaN(now)) currentTime = Math.round(now);
      }
  }

  // === 元素检测 (用于UI显示) ===
  const elementStatus = {
      subscribe_button: false,
      like_button: false,
      comment_input: false,
      next_button: false
  };

  if (activeShort) {
      // 1. 检测关注按钮
      const subscribeBtn = activeShort.querySelector('.ytReelChannelBarViewModelReelSubscribeButton button');
      elementStatus.subscribe_button = !!subscribeBtn;

      // 2. 检测点赞按钮
      const buttons = activeShort.querySelectorAll('button');
      for (let btn of buttons) {
          const label = (btn.getAttribute('aria-label') || "").toLowerCase();
          if ((label.includes('like') || label.includes('点赞')) && 
              !label.includes('dislike') && !label.includes('踩')) {
              elementStatus.like_button = true;
              break;
          }
      }

      // 3. 检测评论输入框 (两种状态：已打开或可打开)
      const commentInput = document.querySelector('#contenteditable-root[contenteditable="true"]');
      const commentPlaceholder = document.querySelector('#placeholder-area');
      elementStatus.comment_input = !!(commentInput || commentPlaceholder || hasInput);

      // 4. 检测下一个视频按钮
      const nextBtn = document.querySelector('button[aria-label*="Next"]') || 
                      document.querySelector('button[aria-label*="下一个"]');
      elementStatus.next_button = !!nextBtn;
  }

  console.log(`[Plugin] 元素检测结果:`, elementStatus);
  console.log(`[Plugin] 返回数据: 标题=${realTitle}, 评论数=${topComments.length}, 点赞=${likeCountStr}, 评论计数=${commentCountStr}`);

  return {
    title: realTitle,
    url: window.location.href,
    html: document.documentElement.outerHTML,
    // 使用统一的判断结果
    platform: 'youtube',
    extra_data: {
        comments: topComments,
        has_input: hasInput,
        comment_count: commentCountStr,
        like_count: likeCountStr,
        duration: duration,
        current_time: currentTime,
        element_status: elementStatus  // 新增：元素检测状态
    }
  };
}

// 获取平台对应的端口 (YouTube 固定)
function getPlatformPort(platform) {
    return PORT; // 固定使用 8088
}

// 发送数据给 Python 的辅助函数
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
    
    // 根据平台选择端口
    const port = getPlatformPort(data.platform);
    
    // 调试：显示发送的平台信息
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Plugin → Python] 正在发送数据...`);
    console.log(`[Plugin → Python] - 目标端口: ${port}`);
    console.log(`[Plugin → Python] - 平台: ${data.platform}`);
    console.log(`[Plugin → Python] - URL: ${data.url}`);
    console.log(`[Plugin → Python] - 标题: ${(data.title || '').substring(0, 50)}`);
    console.log(`[Plugin → Python] - 评论数: ${data.extra_data?.comments?.length || 0}`);
    
    const response = await fetch(`http://localhost:${port}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    console.log(`[Plugin → Python] - HTTP状态: ${response.status} ${response.statusText}`);
    
    if (response.ok) {
        const resData = await response.json();
        console.log(`[Plugin → Python] ✅ 数据发送成功！`);
        console.log(`[Plugin → Python] - 服务器响应:`, resData);
        
        // 调试：显示收到的指令
        if (resData.command) {
            console.log(`[Python → Plugin] 📨 收到指令:`, resData.command);
        } else {
            console.log(`[Python → Plugin] ℹ️ 服务器未返回指令`);
        }
        console.log('='.repeat(60) + '\n');
        
        // 处理返回的指令 (支持单指令 command 或多指令 commands)
        if (resData.command) {
            void executeIncomingCommand(resData.command, 'post_response');
        }
        if (resData.commands && Array.isArray(resData.commands)) {
            for (const cmd of resData.commands) {
                void executeIncomingCommand(cmd, 'post_response_list');
            }
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

// 监听来自 Background 的消息 (Python 发来的)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PYTHON_MSG') {
    const msgBox = document.getElementById('msg-box');
    const msgContent = document.getElementById('msg-content');
    
    msgContent.textContent = request.message;
    msgBox.style.display = 'block';
    
    // 闪烁一下提醒
    msgBox.style.backgroundColor = '#e6f7ff';
    setTimeout(() => msgBox.style.backgroundColor = '#fff', 300);
  }
});

// --- 提取的监控并跳过逻辑 ---
function startMonitorAndSkip(tabId, reason, watchLimit = 30) {
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (skipReason, limit) => {
            console.log(`[Plugin] 启动智能监控 (原因: ${skipReason}, 限时: ${limit}s)...`);
            
            // --- UI 提示函数 ---
            const showStatus = (text, color = '#4caf50') => {
                let el = document.getElementById('plugin-monitor-status');
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'plugin-monitor-status';
                    el.style.position = 'absolute';
                    el.style.top = '60px'; // 避开顶部栏
                    el.style.left = '50%';
                    el.style.transform = 'translateX(-50%)';
                    el.style.padding = '8px 16px';
                    el.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
                    el.style.color = 'white';
                    el.style.borderRadius = '20px';
                    el.style.zIndex = '9999';
                    el.style.fontSize = '14px';
                    el.style.fontWeight = 'bold';
                    el.style.pointerEvents = 'none';
                    el.style.transition = 'opacity 0.3s';
                    el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
                    document.body.appendChild(el);
                }
                el.textContent = text;
                el.style.color = color;
                el.style.opacity = '1';
            };
            
            let statusText = "✅ 已评论，等待视频播完...";
            let statusColor = "#69db7c";
            
            if (skipReason === 'ai_skip') {
                statusText = "⏭️ AI 跳过中...";
            } else if (skipReason === 'filtered') {
                if (limit > 0 && limit < 3600) {
                    statusText = `⏳ 自动观看 ${limit}秒...`;
                    statusColor = "#4dabf7"; // 蓝色
                } else {
                    statusText = "🚫 自动过滤，等待播完...";
                    statusColor = "#ff922b"; // 橙色
                }
            }
            
            showStatus(statusText, statusColor);

            function doSkip() {
                if (window._monitorInterval) {
                    clearInterval(window._monitorInterval);
                    window._monitorInterval = null;
                }
                
                // 延迟移除提示
                const el = document.getElementById('plugin-monitor-status');
                if(el) setTimeout(() => el.style.opacity = '0', 2000);

                // 增加随机延迟 (0.5 - 1.5秒) 再执行跳过动作
                setTimeout(() => {
                    // 再次检查 URL，确保上下文正确

                    // --- YouTube 逻辑 (保持不变) ---
                    // 优先使用键盘下键 (模拟用户刷视频，最自然)
                    const event = new KeyboardEvent('keydown', {
                        key: 'ArrowDown',
                        code: 'ArrowDown',
                        keyCode: 40,
                        bubbles: true
                    });
                    document.dispatchEvent(event);
                    
                    // 备用：点击按钮
                    setTimeout(() => {
                        const nextBtn = document.querySelector('#navigation-button-down button') ||
                                      document.querySelector('button[aria-label="Next video"]');
                        if (nextBtn) nextBtn.click();
                    }, 200);
                }, Math.floor(Math.random() * 1000) + 500);
            }

            // --- 立即跳过逻辑 (针对 AI 不感兴趣且已循环的情况) ---
            if (skipReason === 'ai_skip') {
                // AI跳过时，不等待，立即执行
                console.log("[Plugin] ℹ️ AI 跳过模式，等待 2 秒后跳转");
                // 简短延迟后跳转，让用户看到提示
                setTimeout(() => {
                    console.log("[Plugin] ⏰ AI跳过延迟到期，执行跳转");
                    doSkip();
                }, 2000); // 2秒后跳转
                return;
            }

            // 清除旧的定时器 (如果有)
            if (window._monitorInterval) clearInterval(window._monitorInterval);

            let stuckCount = 0;
            let lastTime = 0;
            let loopCount = 0;

            window._monitorInterval = setInterval(() => {
                let isAd = false;
                let current = 0, max = 0;
                let foundVideo = false;

                // --- YouTube 逻辑 ---
                {
                    const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
                    if (!activeShort) return; // YouTube 必须找到容器
                    foundVideo = true;

                    // 1. 广告检测
                    isAd = activeShort.querySelector('.ytd-ad-badge-renderer') || 
                           activeShort.querySelector('#ad-badge') ||
                           (activeShort.innerText && activeShort.innerText.includes('Sponsored'));
                    
                    if (!isAd) {
                        // 2. 获取时间
                        const video = activeShort.querySelector('video');
                        if (video && !isNaN(video.duration)) {
                            current = video.currentTime;
                            max = video.duration;
                        } else {
                            // 备用：进度条
                            const slider = activeShort.querySelector('.ytPlayerProgressBarDragContainer[role="slider"]') ||
                                           document.querySelector('.ytPlayerProgressBarDragContainer[role="slider"]');
                            if (slider) {
                                current = parseFloat(slider.getAttribute('aria-valuenow'));
                                max = parseFloat(slider.getAttribute('aria-valuemax'));
                            }
                        }
                    }
                }
                
                if (isAd) {
                    console.log("[Plugin] 🚫 检测到广告，立即跳过");
                    showStatus("🚫 检测到广告，跳过...", "#ff6b6b");
                    doSkip();
                    return;
                }

                if (!foundVideo) return;
                
                if (max > 0) {
                    stuckCount = 0;
                    
                    // 检测循环 (当前时间变小，且之前接近结束)
                    if (current < lastTime && (lastTime > max * 0.8 || max - lastTime < 2)) {
                        loopCount++;
                        console.log(`[Plugin] 检测到循环: ${loopCount}`);
                    }
                    lastTime = current;

                    // --- 新增逻辑: 长视频只看30秒 ---
                    const WATCH_LIMIT = limit;
                    const isLongVideo = max > WATCH_LIMIT;
                    let shouldSkip = false;

                    // 计算剩余时间
                    let timeLeft;
                    if (isLongVideo) {
                        timeLeft = Math.max(0, WATCH_LIMIT - current).toFixed(1);
                    } else {
                        timeLeft = Math.max(0, max - current).toFixed(1);
                    }

                    // 更新UI (仅在非过滤模式下更新，避免覆盖过滤提示)
                    // 修改：如果是 filtered 且有倒计时，也更新提示
                    if (skipReason !== 'filtered' || (limit > 0 && limit < 3600)) {
                         const msg = isLongVideo ? `✅ 自动观看${WATCH_LIMIT}秒 (剩余 ${timeLeft}s)...` : `✅ 等待播完 (剩余 ${timeLeft}s)...`;
                         showStatus(msg, "#69db7c");
                    }

                    // 判断是否跳过
                    if (isLongVideo) {
                        // 长视频：超过30秒就跳过
                        if (current >= WATCH_LIMIT) shouldSkip = true;
                    } else {
                        // 短视频：接近结束才跳过 OR 已完成播放(loopCount >= 1)
                        // 如果视频很短 (<5s)，允许循环2次，否则循环1次即跳过
                        const targetLoop = max < 5 ? 2 : 1;
                        if ((current / max > 0.95) || (max - current < 1.5) || loopCount >= targetLoop) shouldSkip = true;
                    }

                    if (shouldSkip) {
                        console.log("[Plugin] ✅ 播放达标，跳转下一个");
                        showStatus("⏭️ 播放结束，正在跳转...", "#4dabf7");
                        doSkip();
                    }
                } else {
                    // 找不到进度条 (可能是直播、特殊广告或加载卡顿)
                    stuckCount++;
                    // 如果连续 5秒 找不到进度条，尝试跳过
                    if (stuckCount > 10) { // 500ms * 10 = 5s
                        console.log("[Plugin] ⚠️ 进度条丢失超时，强制跳转");
                        showStatus("⚠️ 进度丢失，强制跳转...", "#ffd43b");

                        doSkip();
                    }
                }
            }, 500); // 提高检测频率到 500ms
        },
        args: [reason, watchLimit]
    });
}

// --- 轮询 Python 指令 ---

async function pollPythonCommands() {
    try {
        // 仅首次提示轮询已启动（避免刷屏）
        if (!window._pollStartedAt) {
            window._pollStartedAt = Date.now();
            console.log('[Plugin Poll] 🔄 指令轮询已启动');
            logToUI('🔄 指令轮询已启动', 'info');
        }

        // YouTube 专用 - 只轮询 8088 端口
        // 🔥 关键改动：始终保持 isReady=true，让服务器发送所有指令
        // 插件端自行判断是否执行或忽略
        const isReady = true;
        const response = await fetch(`http://localhost:${PORT}/poll?ready=${isReady}`);

        // 非 2xx：也要记录，否则会“无声失败”
        if (!response.ok) {
            const msg = `❌ /poll 响应异常: ${response.status} ${response.statusText}`;
            console.log('[Plugin Poll] ' + msg);
            logToUI(msg, 'error');
            // 不中断循环，继续重试
            throw new Error(msg);
        }
        
        if (!isConnected) {
            isConnected = true;
            logToUI('✅ 已连接到 Python 服务', 'success');
            connectionErrorCount = 0;
        }

        const data = await response.json();
            
            // 调试：定期输出轮询状态（由于改为200ms轮询，每150次=30秒输出一次）
            if (!window._pollCount) window._pollCount = 0;
            window._pollCount++;
            
            // 每30秒输出一次轮询状态（150次 * 200ms = 30秒）
            if (window._pollCount % 150 === 0) {
                console.log(`[Plugin Poll] 已轮询 ${window._pollCount} 次（${(window._pollCount * 0.2 / 60).toFixed(1)}分钟），isReady=${isReady}, waitingForAI=${waitingForAICommand}, 收到指令: ${data.command ? 'YES' : 'NO'}`);
                if (data.command) {
                    console.log(`[Plugin Poll] 指令详情:`, data.command);
                }
                // 心跳日志
                logToUI(`💓 轮询心跳 [${window._pollCount}次] 连接正常`, 'info');
            }
            
            // 每次都检查是否有指令（无论轮询次数）
            if (data.command) {
                const cmdNameCN = getCommandNameCN(data.command.type);
                console.log(`\n${'='.repeat(60)}`);
                console.log(`[插件轮询 YouTube:${PORT}] ✅ 收到指令!`);
                console.log(`  - 指令: ${cmdNameCN}`);
                console.log(`  - 详情:`, data.command);
                console.log(`  - 插件状态: waitingForAI=${waitingForAICommand}, isProcessing=${isProcessingCommand}`);
                console.log('='.repeat(60) + '\n');
                
                logToUI(`📥 收到指令: ${cmdNameCN}`, 'cmd');
                void executeIncomingCommand(data.command, 'poll');
            }
            
            // 兼容处理: 支持 commands (复数)
            if (data.commands && data.commands.length > 0) {
                console.log(`[插件轮询 YouTube:${PORT}] 收到指令列表:`, data.commands);
                for (const cmd of data.commands) {
                    const cmdNameCN = getCommandNameCN(cmd.type);
                    logToUI(`📥 收到指令: ${cmdNameCN}`, 'cmd');
                    void executeIncomingCommand(cmd, 'poll_list');
                }
            }
    } catch (e) {
        // 连接失败处理
        isConnected = false;
        logToUI(`❌ 轮询失败: ${e.message}`, 'error');
        logToUI(`请检查 Python 程序是否运行 (端口 ${PORT})`, 'warn');
        connectionErrorCount++;
        
        // 只在第一次失败时记录详细信息
        if (connectionErrorCount === 1) {
            console.log(`[Plugin] 轮询 YouTube:${PORT} 失败:`, e.message);
        }
    }
    
    // 继续轮询（200ms 间隔，确保及时接收指令）
    setTimeout(pollPythonCommands, 200);
}

async function handleCommand(cmd) {
    // 更新最新指令显示区域
    const cmdBox = document.getElementById('latest-cmd-box');
    const cmdContent = document.getElementById('latest-cmd-content');
    if (cmdBox && cmdContent) {
        cmdBox.style.display = 'block';
        const cmdNameCN = getCommandNameCN(cmd.type);
        let displayInfo = cmdNameCN;
        if (cmd.type === 'auto_comment') {
            displayInfo += `: "${cmd.text}"`;
        }
        if (cmd.reason) {
            const reasonMap = {
                'ai_skip': 'AI建议跳过',
                'test': '测试',
                'filtered': '已过滤',
                'normal': '正常'
            };
            displayInfo += ` (原因: ${reasonMap[cmd.reason] || cmd.reason})`;
        }
        if (cmd.platform) {
            displayInfo = `[${cmd.platform.toUpperCase()}] ${displayInfo}`;
        }
        cmdContent.textContent = displayInfo;
        
        // 闪烁提醒
        cmdBox.style.backgroundColor = '#fff3cd';
        setTimeout(() => cmdBox.style.backgroundColor = '#f0f7ff', 300);
    }

    const cmdNameCN = getCommandNameCN(cmd.type);
    console.log(`[插件] 处理指令: 类型=${cmdNameCN}, 平台=${cmd.platform || 'N/A'}`);
    logToUI(`执行指令: ${cmdNameCN}${cmd.platform ? ` [${cmd.platform.toUpperCase()}]` : ''}`, 'cmd');
    
    let tab = null;
    
    // === 优化：如果指定了平台，直接查找对应平台的标签页 ===
    if (cmd.platform) {
        const targetPlatform = cmd.platform.toLowerCase();
        console.log(`[插件] 查找 ${targetPlatform.toUpperCase()} 平台的标签页...`);
        
        const allTabs = await chrome.tabs.query({});
        for (const t of allTabs) {
            if (!t.url) continue;
            const tUrl = t.url.toLowerCase();
            
            // YouTube 专用版本 - 查找 YouTube 标签页
            if (targetPlatform === 'youtube' && tUrl.includes('youtube.com')) {
                tab = t;
                console.log(`[插件] ✅ 找到 ${targetPlatform.toUpperCase()} 标签页: ${t.url}`);
                break;
            }
        }
        
        if (!tab) {
            console.log(`[插件] ⚠️ 未找到 ${targetPlatform.toUpperCase()} 标签页，忽略指令`);
            logToUI(`⚠️ 未找到 ${targetPlatform.toUpperCase()} 标签页，已忽略指令`, 'warn');
            return;
        }
    } else {
        // 如果没有指定平台，使用getCurrentTab
        tab = await getCurrentTab();
        if (!tab) {
            console.error('[插件] 错误: 未找到活动标签页');
            logToUI('错误: 未找到活动标签页', 'error');
            return;
        }
        console.log(`[插件] ℹ️ 指令未指定平台，使用当前标签页: ${tab.url}`);
    }

    console.log(`[插件] ✅ 将在标签页执行指令: ${tab.url}`);
    
    // === 新增：URL匹配验证 ===
    if (cmd.target_url) {
        // 提取URL的视频ID进行比较（更可靠）
        const extractVideoId = (url) => {
            if (!url) return null;
            // YouTube Shorts: /shorts/VIDEO_ID
            const shortsMatch = url.match(/\/shorts\/([^?&#]+)/);
            if (shortsMatch) return shortsMatch[1];
            // 普通YouTube: ?v=VIDEO_ID
            const vMatch = url.match(/[?&]v=([^&#]+)/);
            if (vMatch) return vMatch[1];
            return null;
        };
        
        const targetVideoId = extractVideoId(cmd.target_url);
        const currentVideoId = extractVideoId(tab.url);
        
        if (targetVideoId && currentVideoId && targetVideoId !== currentVideoId) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`[插件] ⛔ 指令URL不匹配，忽略过期指令`);
            console.log(`  - 指令目标: ${targetVideoId}`);
            console.log(`  - 当前视频: ${currentVideoId}`);
            console.log(`  - 指令类型: ${cmdNameCN}`);
            console.log('='.repeat(60) + '\n');
            
            logToUI(`⛔ 忽略过期指令: ${cmdNameCN} (视频已切换)`, 'warn');
            return; // 不执行过期指令
        }
        
        console.log(`[插件] ✅ URL验证通过，执行指令`);
    }

    // 清除等待AI指令状态
    if (waitingForAICommand) {
        console.log('[插件] 收到AI指令，清除等待状态');
        waitingForAICommand = false;
        currentVideoUrl = '';
        if (waitingTimeout) {
            clearTimeout(waitingTimeout);
            waitingTimeout = null;
        }
    }

    if (cmd.type === 'auto_comment') {
        console.log(`[插件] 开始执行【自动评论】指令，目标标签页: ${tab.url}`);
        console.log(`[插件] 评论文本: ${cmd.text}`);
        logToUI(`📝 准备发送评论: ${cmd.text.substring(0, 30)}...`, 'cmd');
        // 1. 填入评论并发送
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (text) => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                
                // 辅助：查找可见的元素
                const findVisible = (selector) => {
                    const els = document.querySelectorAll(selector);
                    for (let el of els) {
                        // 检查 offsetParent (是否渲染) 和 visibility
                        if (el.offsetParent !== null && 
                            window.getComputedStyle(el).visibility !== 'hidden' &&
                            !el.closest('[hidden]')) {
                            return el;
                        }
                    }
                    return null;
                };

                console.log("[Plugin] 开始自动评论流程...");

                // 再次检查 URL

                // --- YouTube 逻辑 (保持不变) ---
                // 1. 尝试激活输入框 (点击占位符)
                // YouTube 评论框通常先显示一个 "Add a comment..." 的占位符
                const placeholder = findVisible('#placeholder-area') || findVisible('#simplebox-placeholder');
                if (placeholder) {
                    console.log("[Plugin] 点击评论占位符以激活...");
                    placeholder.click();
                    await sleep(600); // 等待展开
                }

                // 2. 查找真正的输入框
                let box = findVisible('#contenteditable-root[contenteditable="true"]');
                
                if (!box) {
                    console.log("[Plugin] 未找到可见输入框，尝试打开评论区...");
                    const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
                    if (activeShort) {
                        const btn = activeShort.querySelector('button[aria-label*="comment"], button[aria-label*="评论"]');
                        if (btn) {
                            btn.click();
                            await sleep(1500); // 等待面板打开
                            // 再次尝试点击占位符
                            const ph = findVisible('#placeholder-area');
                            if (ph) { ph.click(); await sleep(500); }
                        }
                    }
                }

                // 重试找输入框 (最多5次)
                for (let i = 0; i < 5; i++) {
                    box = findVisible('#contenteditable-root[contenteditable="true"]');
                    if (box) break;
                    await sleep(800);
                }

                if (!box) return {success: false, msg: "无法定位评论输入框"};

                // 3. 填入文本 (使用更模拟用户的方式)
                console.log("[Plugin] 聚焦输入框...");
                box.click();
                await sleep(100);
                box.focus();
                await sleep(200);
                
                // 方法A: execCommand (最模拟用户，能触发内部事件)
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, text);
                
                // 方法B: 如果A失败，强制覆盖 (兜底)
                if (box.innerText.trim() === '') {
                    console.log("[Plugin] execCommand 失败，使用备用输入方法...");
                    box.innerText = text;
                    // 触发一系列事件，确保 YouTube 监听到输入
                    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                    box.dispatchEvent(new Event('change', { bubbles: true }));
                    // 模拟空格键再删除，有时能触发验证
                    box.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
                    box.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
                }
                
                await sleep(800); // 等待按钮变亮

                // 4. 查找并点击发送
                // 查找包含 "Comment" 或 "Reply" 或 "评论" 的按钮，且不在取消按钮里
                const buttons = document.querySelectorAll('#submit-button button, button[aria-label="Reply"], button[aria-label="Comment"], button[aria-label="评论"]');
                let submitBtn = null;
                
                for (let btn of buttons) {
                    // 排除取消按钮
                    if (btn.closest('#cancel-button')) continue;
                    // 必须可见
                    if (btn.offsetParent === null) continue;
                    
                    submitBtn = btn;
                    break;
                }

                if (submitBtn) {
                    if (submitBtn.disabled) {
                         return {success: false, msg: "发送按钮被禁用 (输入未识别?)"};
                    }
                    console.log("[Plugin] 点击发送按钮...");
                    submitBtn.click();
                    await sleep(500); // 等待一下，确保点击生效
                    return {success: true};
                }
                
                return {success: false, msg: "未找到发送按钮"};
            },
            args: [cmd.text]
        }, (results) => {
            // 发送成功回调
            console.log("[Plugin] 评论脚本执行完成，结果:", results);
            if (results && results[0] && results[0].result) {
                const res = results[0].result;
                console.log("[Plugin] 评论结果:", res);
                if (res.success) {
                    logToUI("✅ 评论操作成功，通知服务器...", "success");
                    sendToPython({ type: 'comment_success', url: tab.url });
                } else {
                    logToUI(`❌ 评论失败: ${res.msg}`, "error");
                }
            } else {
                console.error("[Plugin] 评论脚本执行异常，无结果返回");
                logToUI("❌ 评论脚本执行异常 (无返回)", "error");
            }
        });

    } else if (cmd.type === 'subscribe_channel') {
        logToUI("➕ 收到关注指令...", "cmd");
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: trySubscribe
        }, (results) => {
            if (results && results[0] && results[0].result) {
                const res = results[0].result;
                if (res.success) {
                    logToUI("✅ " + res.msg, "success");
                } else {
                    logToUI("⚠️ " + res.msg, "warn");
                }
            }
        });

    } else if (cmd.type === 'monitor_next') {
        const reason = cmd.reason || 'normal';
        const reasonMap = {
            'ai_skip': 'AI建议跳过',
            'filtered': '视频已过滤',
            'test': '测试',
            'normal': '正常操作'
        };
        const reasonText = reasonMap[reason] || reason;
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[插件] 🚀 执行【监控并跳转】指令`);
        console.log(`  - 原因: ${reasonText}`);
        console.log(`  - reason字段: ${reason}`);
        console.log(`  - 观看时长: ${currentWatchLimit}s`);
        console.log(`  - 目标tab: ${tab.id}`);
        console.log('='.repeat(60) + '\n');
        
        logToUI(reason === 'ai_skip' ? `⏭️ ${reasonText}，准备跳转...` : `⏳ 评论已发送，等待本轮播放结束...`, "cmd");
        
        // 2. 监控进度并点击下一个 (传入当前计算的观看时长)
        startMonitorAndSkip(tab.id, reason, currentWatchLimit);

    } else if (cmd.type === 'fill_comment') {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (text) => {
                const box = document.querySelector('#contenteditable-root[contenteditable="true"]');
                if (box) {
                    box.innerText = text;
                    box.dispatchEvent(new Event('input', { bubbles: true }));
                    box.focus();
                } else {
                    console.log("未找到评论输入框");
                }
            },
            args: [cmd.text]
        });
    } else if (cmd.type === 'like_video') {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                console.log("[Plugin] 收到点赞指令...");

                // --- YouTube 逻辑 ---
                console.log("[Plugin] 开始查找 YouTube 点赞按钮...");
                const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
                if (!activeShort) {
                    console.error("[Plugin] ❌ 未找到激活的视频容器 (is-active)");
                    return;
                }

                // 策略1: 遍历所有按钮查找 aria-label
                const buttons = activeShort.querySelectorAll('button');
                let found = false;
                for (let btn of buttons) {
                    const label = (btn.getAttribute('aria-label') || "").toLowerCase();
                    // 必须包含 like/点赞，且不能包含 dislike/踩
                    if ((label.includes('like') || label.includes('点赞')) && 
                        !label.includes('dislike') && 
                        !label.includes('踩') &&
                        !label.includes('reply') && // 排除回复
                        !label.includes('comment')) { // 排除评论
                        
                        console.log(`[Plugin] ✅ 找到点赞按钮: "${label}"`);
                        btn.click();
                        found = true;
                        break;
                    }
                }

                // 策略2: 如果没找到，尝试找特定的 ID 结构 (ytd-like-button-renderer)
                if (!found) {
                    const likeRenderer = activeShort.querySelector('ytd-like-button-renderer');
                    if (likeRenderer) {
                        const btn = likeRenderer.querySelector('button');
                        if (btn) {
                            console.log("[Plugin] ✅ 通过结构找到点赞按钮");
                            btn.click();
                            found = true;
                        }
                    }
                }

                if (!found) console.warn("[Plugin] ⚠️ 未找到任何符合条件的点赞按钮");
            }
        });
    } else if (cmd.type === 'open_comments') {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                // 再次检查 URL

                // --- YouTube ---
                const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
                if (!activeShort) return;
                const buttons = activeShort.querySelectorAll('button');
                for (let btn of buttons) {
                    const label = (btn.getAttribute('aria-label') || "").toLowerCase();
                    if (label.includes('comment') || label.includes('评论')) {
                        btn.click();
                        break;
                    }
                }
            }
        });
    }
}

// --- 日志系统 ---

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

    div.innerHTML = `<span style="color:rgba(255,255,255,0.78)">[${time}]</span> <span style="margin-right:4px">${icon}</span><span style="color: ${color}">${msg}</span>`;
    
    // 改为插入到最前面 (最新的在上面)
    container.prepend(div);
    container.scrollTop = 0;
}

const clearLogsBtn = document.getElementById('clear-logs');
if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const container = document.getElementById('log-container');
        if (container) container.innerHTML = '<div style="color: #666;">等待指令...</div>';
    });
}

