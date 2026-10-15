# TikTok 插件（MV3）说明

本文件说明 `plugin_interaction_demo/extension/tiktok/` 目录下的 TikTok 插件：
- 用了什么技术
- 完成了什么功能
- 关键功能靠什么“逻辑代码”达成（便于后续一眼定位）

> 端口：固定 `8099`（服务端与客户端整体说明见根目录 `PROJECT_PLAN.md`）

---

## 1. 目录与职责（以当前仓库为准）

- `manifest.json`
  - MV3 配置、权限、Host 权限等
- `background.js`
  - 后台生命周期与基础事件
- `popup.html`
  - 弹窗 UI：标题/时间/循环/元素状态/最新指令/Top3 评论/日志
  - 脚本加载顺序（必须）：
    - `popup-config.js` → `popup-ui.js` → `popup-inject.js` → `popup-commands.js` → `popup.js`
- `popup-config.js`
  - 常量与运行态（端口、阈值、状态变量等）
- `popup-ui.js`
  - 纯 UI 更新：日志、状态、时间、循环计数、发送状态等
- `popup-inject.js`（页面注入侧）
  - 所有被 `chrome.scripting.executeScript({ func })` 注入到 TikTok 页面的函数
  - 负责：DOM 采集、点击点计算、页面内动作实现（打开评论/找按钮/定位当前视频等）
- `popup-commands.js`
  - 命令轮询与执行：`/poll`、去重/节流、与 Python 通信（`/data`）
- `popup.js`（主控）
  - 自动采集上报、过滤/跳过策略、循环检测与升级恢复、与 UI 联动
- `popup.legacy.js`
  - 历史遗留（保留做对照，线上以拆分后的组合为主）

---

## 2. 技术路线（核心：稳定挂机）

### 2.1 MV3 + 注入执行（executeScript）
- TikTok 是强 SPA，DOM 结构变化频繁。
- 插件通过 `chrome.scripting.executeScript` 在页面上下文执行“自包含函数”。

重要约束：
- 被注入函数必须自包含，不能引用 popup 侧的 helper，否则页面侧会报错，表现为“采集/动作突然停了”。

### 2.2 可靠交互：DOM 计算 → 原生输入 → DOM 校验
TikTok 的点击/焦点经常被 React 拦截，纯 DOM click 偶发失效。
因此采用更稳的模式（在代码里体现为：先从 DOM 计算屏幕坐标，再调用本地原生输入服务，再用 DOM 二次确认结果）：
- **DOM 计算**：从当前可见视频/按钮/导航元素计算可点击点（屏幕坐标）
- **原生输入**：由本地 Python（Windows）执行鼠标/键盘（更像真实用户）
- **DOM 校验**：动作后重新读 DOM，确认确实切换/点赞/打开评论成功

---

## 3. 插件对外能力（做到了什么）

### 3.1 自动采集与上报（插件 → Python）
- 采集字段：标题、URL、时长/进度、Top 评论、点赞/评论相关信息（按页面能力）
- 发送：`POST http://127.0.0.1:8099/data`
- **关键稳定性**：只在服务端确认成功后，才把该视频标记为“已发送”，避免挂机一晚后“以为发过了但其实没发”
- UI 增加“发送状态”行：最近一次发送成功/失败与原因（用于排障）

对应代码定位：
- 采集函数：`popup-inject.js`（如 `getLightPageData()`、`extractTargetText()`）
- 发送与结果判定：`popup-commands.js`/`popup.js`
- UI 展示：`popup-ui.js`（send-status 更新）

### 3.2 指令轮询与执行（Python → 插件）
- 轮询：`GET http://127.0.0.1:8099/poll?ready=true`
- 串行执行：同一时间只执行一个命令
- 去重与节流：避免同一命令被高频重复触发（尤其是 `next_video/monitor_next`）

对应代码定位：
- `popup-commands.js`：轮询、忙碌锁、去重/节流、执行分发

### 3.3 监控跳转（monitor_next）= 挂机闭环
插件可以在本地直接监控播放进度，到点自动跳下一条（Python 不需要持续盯着）：
- watchLimit 到达 或 播放结束 → 触发“下一个视频”
- 失败会自动升级：先尝试更轻的切换，再到更强的恢复动作

对应代码定位：
- 主控策略：`popup.js`
- 页面侧时间采样：`popup-inject.js`

---

## 4. 关键逻辑（按“问题 → 逻辑策略 → 代码归属”写）

### 4.1 “下一个视频”连跳好几个（过冲）
**问题**：多种滚动/按键组合叠加 + 重试过快，会导致一次触发跳过多条。

**策略**：
- 增加节流（短时间内禁止连续 next）
- `monitor_next` 的“是否切换成功”改成等待视频确实变化（轮询式 waitForChange），避免误判失败后立刻再跳
- 对“广告/赞助”类跳过使用单步切换（避免 PageDown/滚轮连发造成过冲）

**代码归属**：
- 节流/等待变化：`popup-commands.js`
- 触发策略：`popup.js`

### 4.1.1 手动跳过后提示条“卡住不刷新”
**问题**：当插件进入 `monitor_next`/过滤跳过逻辑后，会在页面顶端显示倒计时/“已过滤”提示条；如果用户手动滑到下一条，旧提示条仍可能继续显示，造成“看起来还在处理上一条”的错觉。

**策略**：
- 启动页面内监控时记录当前视频签名 `initialSig`（优先用 `video.currentSrc`，兜底用页面标题文本）。
- 每次 tick（500ms）检测当前签名 `curSig`，一旦发现 `curSig !== initialSig`，立即：
  - 停止监控（`clearInterval`）
  - 隐藏提示条（把 `#plugin-monitor-status` 透明度设为 0）
  - 清理 `window.__TK_SKIP_MONITOR__`（避免残留状态影响后续）

**代码归属**：
- 页面内监控实现：`popup.js`（`startMonitorAndSkip()` 注入函数）

### 4.2 页面卡住/异常状态恢复（不整页刷新，避免扩展重载）
**问题**：整页 reload 会导致扩展重新加载，挂机不稳定。

**策略**：优先用“刷新视频流”替代 tab reload：
- 通过双击左侧导航的 Home/For You（小房子）实现 feed 刷新
- 增加长周期节流（例如 5 分钟内最多触发一次），避免抖动

**代码归属**：
- 点击点计算：`popup-inject.js`（Home/ForYou 的定位与坐标）
- 指令/动作：`popup-commands.js` / `popup.js`

### 4.3 广告/赞助内容处理（Sponsored）
**问题**：广告可能循环、也可能被误判导致连续跳。

**策略**：
- 页面采集阶段识别 `is_sponsored`，并通过 `extra_data` 上报
- 主控对 `is_sponsored` 采取“快速跳过”
- 为避免“连续跳过风暴”，广告跳过使用更保守的单步策略 + 更少重试
- 广告检测范围收敛：只在当前 activeRoot 内扫描，并排除导航/页眉/页脚区域，降低误判

**代码归属**：
- Sponsored 检测：`popup-inject.js`
- 跳过策略：`popup.js`

### 4.4 循环检测（防无限重播）
**问题**：TikTok URL/Token 抖动会导致循环统计 key 不稳定，循环次数重置，广告循环也可能漏算。

**策略**：
- 使用更稳定的 `videoKey/videoId` 作为循环 key（避免 URL query/hash 抖动）
- 当 duration 不可用（0 或取不到）时使用兜底启发式：基于时间回跳与“接近开头”判断循环

**代码归属**：
- 循环计数与 UI：`popup-ui.js`
- 关键 key 的生成/传递：`popup.js`

### 4.5 点赞稳定性（避免 toggle）
**问题**：TikTok 点赞是 toggle，重复触发会把赞取消。

**策略（插件侧已有保护 + 使用规范）**：
- 插件侧去重：短时间同签名丢弃（例如 8 秒）
- 同视频动作限频（例如 15 分钟）
- 注入侧 Like Guard：识别“已点赞”则直接跳过，避免二次点击

**使用规范（建议）**：
- TikTok 页面语言尽量固定为 English（aria-label 文案更稳定）
- 运行时保持窗口前台可见（浏览器后台/最小化会影响渲染与可见性判断）

---

## 5. 常见问题与排障

### 5.1 插件突然不发数据
- 先看 popup 的“发送状态”是否提示失败原因
- 再看服务端连接测试：/poll 与 /data 是否都在刷新

### 5.2 Sponsored 误判/漏判
- 误判：会出现“正常视频被当广告跳过” → 需要进一步收敛 Sponsored 选择器/关键词
- 漏判：广告没跳过但循环 → 循环检测应能兜底触发升级跳过

---

## 6. 维护建议（写给后续改代码的人）

- 新增注入函数时：务必保持“自包含”，不要引用 popup 作用域 helper。
- 任何“跳过/翻页”动作都要：
  - 有节流（防连跳）
  - 有确认（等待视频真的变了再判定成功）
- 优先用“页面内刷新视频流”恢复，不要整页 reload。
