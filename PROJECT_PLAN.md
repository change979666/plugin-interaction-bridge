# 插件互通程序（客户端为中心）

本项目是一个“Python 客户端（UI + 本地 HTTP 服务）+ Chrome 插件（YouTube/TikTok）”的自动化互通系统：
- 插件负责：采集页面数据（标题/时长/点赞/评论/热评等）、执行自动化动作（点赞/评论/关注/跳转/监控）。
- Python 客户端负责：展示与记录、调用 AI 生成评论/策略、下发指令、提供连接测试与排障。

文档入口（按你后续维护最常用的视角组织）：
- 客户端总说明（本文）
- YouTube 插件说明：plugin_interaction_demo/extension/youtube/README.md
- TikTok 插件说明：plugin_interaction_demo/extension/tiktok/README.md

---

## 1. 系统组成与端口

### 1.1 Python 端（客户端 + 服务端）
- UI：Tkinter，左右分栏独立展示 YouTube / TikTok。
- 本地 HTTP 服务：接收插件上报、向插件下发指令、维护连接状态与队列。

### 1.2 Chrome 插件（Manifest V3）
- YouTube 插件：固定连接 `http://127.0.0.1:8088`
- TikTok 插件：固定连接 `http://127.0.0.1:8099`

说明：当前是“双端口/双实例服务”，用于平台隔离，避免互相干扰。

---

## 2. 客户端职责与核心逻辑（重点）

### 2.1 平台隔离（UI 与状态）
- UI 左侧 YouTube、右侧 TikTok：标题/链接/时间/时长/评论/AI 输出互不影响。
- 内存状态按平台隔离：避免“短视频快切换”导致跨平台指令/数据串台。

### 2.2 数据接收（插件 → Python）
- 插件 `POST /data` 上报视频数据。
- 服务端将数据放入 `data_queue`。
- UI 定时处理：`process_queues()` 从队列取数据，交给 `handle_incoming_data()` 更新对应平台 UI。

核心字段（插件两端统一结构）：
```json
{
  "platform": "youtube",
  "title": "...",
  "url": "...",
  "extra_data": {
    "duration": 15,
    "current_time": 3,
    "like_count": "1.2K",
    "comment_count": "58",
    "comments": [
      {"author": "A", "content": "...", "likes": "120"}
    ]
  }
}
```

### 2.3 AI 生成（Python → AI → UI）
- “生成评价”会基于当前标题/热评拼装 Prompt，调用 `AIEngine` 生成评论文案/策略。
- 结果写入平台对应的“智能回复”输入框。

TikTok 的 AI 输出规则（约束）：
- 严格 5 行格式：`Video_Like/Follow/Like_C1/Like_C2/Like_C3`。
- `Video_Like: NO` 只代表不点赞视频，不影响评论点赞/关注。
- 仅当所有动作均为 `NO` 时，才触发“不感兴趣/跳过”。

### 2.4 指令下发（Python → 插件）

#### 2.4.1 UI 侧入队
- UI 通过 `send_command(cmd_type, **kwargs)` 将指令放入 `command_queues[platform]`。
- 为避免“旧指令在新视频上执行”，UI 会尽量附带 `target_url`（当前平台 UI 已有 URL 时）。

指令格式（示意）：
```json
{
  "type": "monitor_next",
  "platform": "youtube",
  "target_url": "https://www.youtube.com/shorts/xxxx",
  "reason": "ai_skip",
  "watchLimit": 30,
  "id": "可选：用于追踪"
}
```

#### 2.4.2 服务端下发策略（关键）
- 插件通过 `GET /poll` 高频轮询取指令。
- 服务端策略：队列非空就下发 1 条；`ready` 仅记录连接状态，不作为下发门槛。

设计意图：降低“ready 误判导致不下发”的风险，稳定闭环。

### 2.5 自动闭环（可选但推荐）
当客户端收到插件上报的事件包（例如 `comment_success`）：
- UI 记录“评论成功”。
- 如果开启自动流程：自动下发 `monitor_next`，让插件进入“播放监控 → 到点跳下一个”的闭环。

### 2.6 连接测试（强排障能力）
每个平台工具栏“连接测试”做两件事：
1) 展示服务端维护的连接状态：最近一次 `/poll`（轮询）与 `/data`（上报）时间。
2) 下发一条 `link_test` 指令，并在约 1 秒后检查是否已被服务端“通过 /poll 下发”。

结论解释：
- “服务端已下发 link_test”只代表：插件轮询在线且可接收指令。
- “页面是否真的执行成功”需要结合插件 UI/Console 与页面行为判断。

### 2.7 清空与复位
- UI 的“清空”：只清 UI 展示和等待态，不动服务端队列。
- 如需清空服务端待发队列：调用 `POST /clear_queue`（按平台）。

---

## 3. 服务端接口协议（插件交流）

### 3.1 端口
- YouTube：`http://127.0.0.1:8088`
- TikTok：`http://127.0.0.1:8099`

### 3.2 `GET /poll?ready=true|false`
用途：插件轮询获取待执行指令。

响应（无指令）：
```json
{ "status": "ok" }
```

响应（有指令）：
```json
{ "status": "ok", "command": { "type": "next_video" } }
```

说明：
- 服务端记录轮询心跳：`last_poll_ts/poll_count/last_poll_ready`，用于 UI 连接测试。
- 队列非空即下发 1 条，避免堆积。

### 3.3 `POST /data`
用途：插件上报当前视频数据/事件。

响应：
- 固定 `{ "status": "ok" }`。
- 可能顺带下发一条 `command`（等价“一次顺带 poll”），用于降低交互延迟。

### 3.4 `POST /clear_queue`
用途：清空对应平台服务端“待下发指令队列”。

响应：
```json
{ "status": "ok", "cleared": 3 }
```

### 3.5 连接状态（UI 连接测试依赖）
服务端维护按平台区分的 `connection_state`，典型字段：
- 最近轮询：`last_poll_ts`, `poll_count`, `last_poll_ready`
- 最近上报：`last_post_ts`, `post_count`, `last_post_url`
- 最近下发：`last_command_sent_ts`, `last_command_sent_id`, `last_command_sent_type`

---

## 4. 常见故障与快速定位（客户端视角）

### 4.1 轮询断了（/poll 不更新）
表现：连接测试显示“最近轮询很久以前”。

优先排查：
- 插件 popup 是否打开且在运行（MV3 popup 关闭后通常不会持续执行定时器）。
- 当前 tab 是否是目标网站页面（YouTube/TikTok）。
- 浏览器是否阻止了脚本注入（系统页面/受限页面）。

### 4.2 上报断了（/data 不更新）
表现：轮询在线，但一直“从未上报/很久未上报”。

优先排查：
- 页面 DOM 变动导致采集字段为空（看插件 Console 是否打印“未找到容器/未找到评论”等）。
- 插件端是否因异常崩溃（Console 报错会导致后续定时器停止）。

### 4.3 旧指令误操作/堆积
表现：视频切换后仍执行上一条视频的指令。

处理：
- 客户端调用 `POST /clear_queue` 清队列。
- 确保指令带 `target_url`；插件侧会做“视频ID匹配”拒绝过期指令。

### 4.4 端口被占用
表现：服务端启动失败或连接失败。

处理：检查 8088/8099 是否被其他程序占用。

---

## 5. 目录结构速览

- plugin_interaction_demo/python_app/：Python 客户端 UI + 服务端 + AI 引擎
- plugin_interaction_demo/extension/youtube/：YouTube 插件（文档见 README.md）
- plugin_interaction_demo/extension/tiktok/：TikTok 插件（文档见 README.md）
