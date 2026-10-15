import queue

# 日志队列 (UI 显示用)
log_queue = queue.Queue()

# 数据接收队列 (从 Server 接收数据传给 UI)
data_queue = queue.Queue()

# 指令发送队列 (从 UI 发送指令传给 Server)
# 使用字典区分不同平台的指令队列
command_queues = {
    "youtube": queue.Queue(),
    "tiktok": queue.Queue(),
    "default": queue.Queue()  # 兼容旧版
}

# 为了兼容旧代码的引用，保留 command_queue 指向 default
command_queue = command_queues["default"]

# 视频历史记录
video_records = []


def _new_conn_state():
    return {
        "last_poll_ts": 0.0,
        "last_poll_ready": None,
        "poll_count": 0,
        "last_post_ts": 0.0,
        "post_count": 0,
        "last_post_url": "",
        "last_command_sent_ts": 0.0,
        "last_command_sent_id": None,
        "last_command_sent_type": None,
    }


# 连接状态（用于“连接测试/排障”）
# 由 server.py 更新；由 ui.py 读取。
connection_state = {
    "youtube": _new_conn_state(),
    "tiktok": _new_conn_state(),
    "default": _new_conn_state(),
}


def ensure_connection_state(platform: str):
    key = (platform or "default").lower()
    if key not in connection_state:
        connection_state[key] = _new_conn_state()
    return connection_state[key]
