import http.server
import socketserver
import json
import threading
import time
from .native_input import (
    native_left_click,
    native_left_click_n,
    get_cursor_pos,
    native_type_text,
    native_press_enter,
    native_key_press,
)
from .state import (
    command_queues,
    log_queue,
    data_queue,
    ensure_connection_state,
)

PORT_YOUTUBE = 8088
PORT_TIKTOK = 8099

# 指令中文映射
COMMAND_NAMES_CN = {
    'auto_comment': '自动评论',
    'monitor_next': '监控并跳转',
    'fill_comment': '填充评论',
    'like_video': '点赞视频',
    'like_top_comment': '高赞点赞',
    'like_comment': '点赞评论',
    'subscribe': '关注频道',
    'open_comments': '打开评论区',
    'next_video': '下一个视频',
    'link_test': '连接测试'
}


class RequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, platform='youtube', **kwargs):
        self.platform = platform
        super().__init__(*args, **kwargs)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/poll'):
            # 先解析 ready 参数（用于状态记录）
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            client_ready = params.get('ready', ['false'])[0].lower() == 'true'

            # 记录轮询心跳（用于 UI “连接测试”）
            conn = ensure_connection_state(self.platform)
            conn['last_poll_ts'] = time.time()
            conn['last_poll_ready'] = client_ready
            conn['poll_count'] = int(conn.get('poll_count', 0)) + 1

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {"status": "ok"}
            
            # 从对应平台队列获取指令
            target_queue = command_queues.get(
                self.platform, command_queues['default'])
            
            # 调试：显示队列信息
            queue_size = target_queue.qsize()
            
            # 额外调试：显示所有队列的状态
            all_queue_status = {
                'youtube': command_queues['youtube'].qsize(),
                'tiktok': command_queues['tiktok'].qsize(),
                'default': command_queues['default'].qsize()
            }
            
            # 关键修复：只要队列非空就发送一条指令（ready 仅用于日志）
            # 避免因 ready 状态判断异常导致“队列堆积→客户端收不到→超时”。
            if not target_queue.empty():
                cmd = target_queue.get()
                response["command"] = cmd
                cmd_name = COMMAND_NAMES_CN.get(cmd['type'], cmd['type'])

                # 记录“已下发”的指令（是否真正被插件执行，由插件侧日志确认）
                conn = ensure_connection_state(self.platform)
                conn['last_command_sent_ts'] = time.time()
                conn['last_command_sent_id'] = cmd.get('id')
                conn['last_command_sent_type'] = cmd.get('type')
                
                # 详细调试输出
                print("\n" + "="*50)
                print("[服务器 POLL] 📤 发送指令!")
                print(f"  - 平台: {self.platform.upper()}")
                print(f"  - 客户端就绪: {client_ready}")
                print(f"  - 指令: {cmd_name}")
                print(f"  - 详情: {cmd}")
                print(f"  - 当前队列剩余: {target_queue.qsize()}")
                print(f"  - 所有队列状态: {all_queue_status}")
                print("="*50 + "\n")
                
                log_queue.put(
                    f"📤 发送指令给 [{self.platform.upper()}]: {cmd_name}")
            elif not client_ready and queue_size > 0:
                # 客户端正忙，但有待处理指令
                if not hasattr(RequestHandler, '_busy_counts'):
                    RequestHandler._busy_counts = {}
                if self.platform not in RequestHandler._busy_counts:
                    RequestHandler._busy_counts[self.platform] = 0
                RequestHandler._busy_counts[self.platform] += 1
                
                count = RequestHandler._busy_counts[self.platform]
                if count % 10 == 0:
                    print(f"[Server] ⏳ 客户端正忙 (#{count}): "
                          f"platform={self.platform}, "
                          f"queue_size={queue_size}")
                    log_queue.put(
                        f"⏳ [{self.platform}] 客户端正忙，"
                        f"等待处理 ({queue_size}条待发)")
            else:
                # 使用类变量来持久化计数器
                if not hasattr(RequestHandler, '_poll_counts'):
                    RequestHandler._poll_counts = {}
                if self.platform not in RequestHandler._poll_counts:
                    RequestHandler._poll_counts[self.platform] = 0
                RequestHandler._poll_counts[self.platform] += 1
                
                count = RequestHandler._poll_counts[self.platform]
                if count % 30 == 0:  # 每30次轮询输出一次
                    log_queue.put(
                        f"[{self.platform}] 轮询 #{count}: 队列空")
                    print(f"[Server] Poll #{count}: "
                          f"platform={self.platform}, "
                          f"queue_size={queue_size}")
                
            self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/data' or self.path == '/':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))

                # 记录最近一次插件上报（用于 UI “连接测试”）
                conn = ensure_connection_state(self.platform)
                conn['last_post_ts'] = time.time()
                conn['post_count'] = int(conn.get('post_count', 0)) + 1
                conn['last_post_url'] = str(data.get('url', '') or '')
                
                # 详细调试日志
                print(f"\n{'='*60}")
                print(f"[服务器] 收到 POST 请求: 平台={self.platform}")
                print(f"[服务器] 数据标题: {data.get('title', 'N/A')[:50]}")
                print(f"[服务器] 数据URL: {data.get('url', 'N/A')[:60]}")
                extra = data.get('extra_data', {})
                comments = extra.get('comments', [])
                print(f"[服务器] 评论数量: {len(comments)}")
                print(f"{'='*60}\n")
                
                # 将接收到的数据放入队列
                data_queue.put(data)
                log_queue.put(f"✅ [{self.platform.upper()}] 数据已放入队列")
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                
                # 检查对应平台的指令队列
                response = {"status": "ok"}

                # 重要：不要在 /data 响应里出队指令。
                # 否则会与 /poll 并发抢队列，导致“指令重复/节奏紊乱”。
                # 指令统一由 /poll 下发。
                
                self.wfile.write(json.dumps(response).encode('utf-8'))
                
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(
                    b'{"status": "error", "message": "Invalid JSON"}')
        elif self.path == '/native_click':
            content_length_raw = self.headers.get('Content-Length', '0') or '0'
            content_length = int(content_length_raw)
            post_data = (
                self.rfile.read(content_length) if content_length > 0 else b''
            )
            try:
                payload = json.loads(post_data.decode('utf-8') or '{}')

                x = int(payload.get('x'))
                y = int(payload.get('y'))
                press_ms = int(payload.get('press_ms', 40) or 40)
                count = int(payload.get('count', 1) or 1)
                interval_ms = int(payload.get('interval_ms', 55) or 55)

                before = None
                after = None
                try:
                    before = get_cursor_pos()
                except Exception:
                    before = None

                if count > 1:
                    native_left_click_n(
                        x,
                        y,
                        count=count,
                        press_ms=press_ms,
                        interval_ms=interval_ms,
                    )
                else:
                    native_left_click(x, y, press_ms=press_ms)

                try:
                    after = get_cursor_pos()
                except Exception:
                    after = None

                try:
                    log_queue.put(
                        f"🖱️ [NATIVE_CLICK] ({x},{y}) "
                        f"press_ms={press_ms} platform={self.platform}"
                    )
                except Exception:
                    pass

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "status": "ok",
                            "clicked": True,
                            "x": x,
                            "y": y,
                            "press_ms": press_ms,
                            "count": count,
                            "interval_ms": interval_ms,
                            "clicked_count": count,
                            "cursor_before": before,
                            "cursor_after": after,
                        }
                    ).encode(
                        'utf-8'
                    )
                )
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(
                    json.dumps({"status": "error", "message": str(e)}).encode(
                        'utf-8'
                    )
                )
        elif self.path == '/native_type':
            content_length_raw = self.headers.get('Content-Length', '0') or '0'
            content_length = int(content_length_raw)
            post_data = (
                self.rfile.read(content_length) if content_length > 0 else b''
            )
            try:
                payload = json.loads(post_data.decode('utf-8') or '{}')
                text = str(payload.get('text', '') or '')
                interval_ms = int(payload.get('interval_ms', 0) or 0)

                native_type_text(text, interval_ms=interval_ms)
                try:
                    log_queue.put(
                        f"⌨️ [NATIVE_TYPE] len={len(text)} "
                        f"plat={self.platform}"
                    )
                except Exception:
                    pass

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "status": "ok",
                            "typed": True,
                            "length": len(text),
                            "interval_ms": interval_ms,
                        }
                    ).encode('utf-8')
                )
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(
                    json.dumps({"status": "error", "message": str(e)}).encode(
                        'utf-8'
                    )
                )
        elif self.path == '/native_key':
            content_length_raw = self.headers.get('Content-Length', '0') or '0'
            content_length = int(content_length_raw)
            post_data = (
                self.rfile.read(content_length) if content_length > 0 else b''
            )
            try:
                payload = json.loads(post_data.decode('utf-8') or '{}')
                key = str(payload.get('key', '') or '').strip().lower()
                vk = payload.get('vk')
                count = int(payload.get('count', 1) or 1)
                press_ms = int(payload.get('press_ms', 18) or 18)
                interval_ms = int(payload.get('interval_ms', 35) or 35)

                if vk is not None:
                    native_key_press(
                        int(vk),
                        count=count,
                        press_ms=press_ms,
                        interval_ms=interval_ms,
                    )
                    key_name = f"vk:{int(vk)}"
                elif key in ('enter', 'return'):
                    native_press_enter(
                        count=count,
                        press_ms=press_ms,
                        interval_ms=interval_ms,
                    )
                    key_name = 'enter'
                else:
                    raise ValueError('unsupported_key')

                try:
                    log_queue.put(
                        f"⌨️ [NATIVE_KEY] key={key_name} count={count} "
                        f"platform={self.platform}"
                    )
                except Exception:
                    pass

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "status": "ok",
                            "key": key_name,
                            "count": count,
                            "press_ms": press_ms,
                            "interval_ms": interval_ms,
                        }
                    ).encode('utf-8')
                )
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(
                    json.dumps({"status": "error", "message": str(e)}).encode(
                        'utf-8'
                    )
                )
        elif self.path == '/clear_queue':
            # 新增：清空队列端点
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            target_queue = command_queues.get(
                self.platform, command_queues['default'])
            
            cleared_count = 0
            while not target_queue.empty():
                try:
                    target_queue.get_nowait()
                    cleared_count += 1
                except Exception:
                    break
            
            print(f"\n{'='*60}")
            print("[服务器] 🗑️ 清空队列请求")
            print(f"  - 平台: {self.platform.upper()}")
            print(f"  - 清除数量: {cleared_count}")
            print('='*60 + '\n')
            
            if cleared_count > 0:
                log_queue.put(
                    f"🗑️ [{self.platform.upper()}] "
                    f"清空队列: {cleared_count} 条旧指令")
            
            response = {
                "status": "ok",
                "cleared": cleared_count
            }
            self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()


def create_handler(platform):
    """创建特定平台的处理器"""
    def handler(*args, **kwargs):
        RequestHandler(*args, platform=platform, **kwargs)
    return handler


def start_server(port, platform):
    """启动指定端口和平台的服务器"""
    socketserver.TCPServer.allow_reuse_address = True
    try:
        handler = create_handler(platform)
        # 使用多线程服务器，避免单线程阻塞导致轮询延迟/超时
        with socketserver.ThreadingTCPServer(("", port), handler) as httpd:
            log_queue.put(f"[{platform.upper()}] 服务器运行在端口 {port}")
            print(f"[{platform.upper()}] Serving at port {port}")
            httpd.serve_forever()
    except OSError as e:
        log_queue.put(
            f"启动 [{platform}] 服务器失败 (端口 {port} 可能被占用): {e}")
        print(f"Error starting {platform} server: {e}")


def start_server_thread():
    """启动两个服务器线程"""
    # YouTube 服务器
    yt_thread = threading.Thread(
        target=start_server, args=(PORT_YOUTUBE, 'youtube'), daemon=True)
    yt_thread.start()
    
    # TikTok 服务器
    tk_thread = threading.Thread(
        target=start_server, args=(PORT_TIKTOK, 'tiktok'), daemon=True)
    tk_thread.start()
