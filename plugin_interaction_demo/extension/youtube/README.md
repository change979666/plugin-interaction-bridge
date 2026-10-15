# YouTube 插件（MV3）说明

本文件说明 `plugin_interaction_demo/extension/youtube/` 目录下的 YouTube 插件：
- 用了什么技术
- 采集了什么数据
- 通过什么逻辑完成“过滤 / 上报 / 等待 AI / 执行动作 / 监控跳转”
- 常见故障怎么排

> 端口：固定 `8088`（服务端见根目录 `PROJECT_PLAN.md`）

---

## 1. 目录与职责

- `manifest.json`
  - MV3 配置与权限（`scripting`, `tabs`, `activeTab`, `storage` 等）
- `background.js`
  - 后台生命周期与基础事件（保持扩展可用性）
- `popup.html`
  - 插件弹窗 UI（显示标题/时间/评论/状态日志等）
- `popup.js`（核心）
  - 轮询 Python：`GET /poll`
  - 页面采集：注入 `getPageContent()` / `extractTargetText()`
  - 动作执行：点赞/关注/打开评论/自动评论/监控跳转
  - 防错乱：忙碌锁、单条缓冲、`target_url` 视频ID校验

---

## 2. 技术要点（为什么这样做）

### 2.1 Manifest V3 + executeScript
YouTube DOM 变化频繁，因此采取“多级 fallback + 页面注入函数”的方式：
- Popup 里用 `chrome.scripting.executeScript({ func })` 把函数注入到页面上下文执行
- 注入函数必须自包含（不能依赖 popup.js 的外部变量/函数），否则页面侧会 `ReferenceError`

### 2.2 两段采集：高频轻量 vs 低频完整
- `extractTargetText()`：高频（通常 1s 一次）
  - 只取：标题、时间（current/duration）、循环计数
  - 用于：UI 刷新 + 发现“新视频”
- `getPageContent()`：低频（新视频出现时）
  - 取：标题、URL、时长/进度、点赞数、评论数、Top 热评、元素存在性
  - 用于：上报 Python / AI 决策

设计目的：
- 高频函数越轻越稳，避免 DOM 变化带来的崩溃
- 完整采集允许慢一点（配合重试等待评论加载）

---

## 3. 数据采集字段与选择器策略

### 3.1 标题（Shorts 优先）
Shorts 容器：`ytd-reel-video-renderer[is-active]`
- 优先：`h2.ytShortsVideoTitleViewModelShortsVideoTitle`
- 其次：`yt-shorts-video-title` / 任意 `h2`
- 兜底：`document.title`（去掉 ` - YouTube`）

### 3.2 时长与进度
- 优先：活动容器内 `video.duration / video.currentTime`
- 兜底：进度条 slider（`aria-valuemax / aria-valuenow`）

### 3.3 点赞数 / 评论数（关键：Shorts 与普通视频分开处理）
插件会输出字符串形式（如 `"1.2K"`, `"58"`, `"3万"`），数值解析在过滤逻辑里完成。

- Shorts：扫描 activeShort 内按钮
  - 从 `button.innerText`、`aria-label`、以及兄弟节点 `.yt-spec-button-shape-with-label__label` 提取数字 token
- 普通视频页：从 watch 页顶栏/评论头部提取
  - 评论数：`#comments #count ...` 等候选
  - 点赞数：`#top-level-buttons-computed` 区域内的 like 按钮，优先可见文本，其次 `aria-label`

这样做的原因：
- YouTube 普通视频页不一定存在 `ytd-reel-video-renderer`，如果只写 Shorts 分支会导致 `like_count` 永远是 `0`，从而把高赞误判为低赞。

### 3.4 热评提取（Top3）
- 优先选择可见评论容器
- 兼容多种 comment renderer，并做浅层 shadowRoot 探测
- 抽取：author/content/likes
- 使用统一 `parseCount()` 对评论点赞做排序，取 Top3

---

## 4. 过滤逻辑（插件端直接做，省 AI 资源）

过滤发生在“评论已就绪或重试耗尽后”，避免加载慢造成误判。

### 4.1 解析规则
- 过滤用的 `parseCount()` 支持：`K/M/B/万` 与逗号
- 同时提供 `isLargeNumber()`：只要字符串带单位或带小数点（如 `1.2`），直接视为“够大”，避免解析误差。

### 4.2 判定策略（简化描述）
- 时长 < 10s：跳过
- 标题不是中英文：跳过
- 点赞极少（<10）或评论极少（<5）：快速跳过（随机 1~3s）
- 中等热度（<500）：只看 10s
- 良好热度（<1000）：只看 30s
- 高赞低评：看完但不问 AI
- 高赞高评：上报 Python，等待 AI 下发动作

---

## 5. 指令轮询与执行（防错乱机制）

### 5.1 轮询
- 周期性：`GET http://127.0.0.1:8088/poll?ready=true`

### 5.2 忙碌控制
- `isProcessingCommand`：同一时间只执行一个指令
- `pendingCommand`：忙碌时只保留“最新一条”非高优先级指令，避免堆积

### 5.3 过期指令保护（关键）
如果指令带 `target_url`：
- 从 `target_url` 与当前 tab.url 提取视频ID（Shorts `/shorts/<id>`，普通视频 `?v=<id>`）
- 不一致则拒绝执行（避免旧指令在新视频上生效）

---

## 6. 监控跳转（monitor_next）

`monitor_next` 是“插件端监控播放进度，到点自动跳下一个”的闭环能力：
- Python 只负责下发一次指令
- 插件在页面内显示倒计时/提示（如有实现）
- 到达 watchLimit 或播放结束后触发下一条

---

## 7. 常见问题与排障

### 7.1 高赞被判低赞
- 先看 `extra_data.like_count` 是否一直是 `"0"`
- 若是普通视频页：检查顶栏按钮 DOM 是否变更（selector 失效）
- 可在 Console 查看插件打印的“普通视频计数抓取(可能失败)”日志

### 7.2 评论太慢导致“发到下一个视频”
插件会：
- 评论加载阶段可暂停播放（避免切换）
- 发送前校验 tab.url 是否仍等于采集时的 expectedUrl
- 不一致则丢弃 payload，避免错配

### 7.3 popup 关掉后不工作
MV3 popup 逻辑通常不常驻；如果你需要“后台常驻采集”，建议改成 content script/Service Worker 驱动（当前项目以 popup 运行态为主）。
