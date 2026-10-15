import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import datetime
import re
import html
import time
import uuid
import random
import threading
import socket
from .state import (
    command_queues,
    log_queue,
    data_queue,
    ensure_connection_state,
)
from .config import (
    load_config,
    save_config,
    DEFAULT_PROMPT,
    DEFAULT_BASE_URL,
    get_platform_ai_config,
)
from .ai_engine import AIEngine


DEFAULT_TIKTOK_PROMPT = """# Role: 
You are a passionate inheritor of Chinese Intangible Cultural Heritage (Huaiyang Folk Art). You are witty, warm, and artistic.

# Task:
Analyze the input data to determine interaction actions (Like, Follow) and generate a short, engaging Comment.

# Input Data:
- Video Title: {title}
- Top Comment 1: {comment_1}
- Top Comment 2: {comment_2}
- Top Comment 3: {comment_3}

# Judgment Rules:

1. **Video_Like**
    - YES: Art, Crafts, Culture, DIY, Satisfying, Positive vibes.
    - NO: Politics, Hate, Spam, Boring.

2. **Follow_Creator**
    - YES: High-Quality Peers ONLY (Potters, Sculptors, Artists, Craftsmen).
    - NO: General funny videos, life hacks, unrelated content.

3. **Comment_Content (CRITICAL RULES)**
    - **Length Limit**: MUST be under 100 characters (including emojis). NEVER exceed 120 characters.
    - **Condition**: If Video_Like is NO, Comment is NO.
    - **Style**: Short, punchy, casual.
    - **Language**: English only.

# Output Format (Strictly 3 lines):
Video_Like: [YES/NO]
Follow: [YES/NO]
Comment: [Your comment under 100 chars OR "NO"]

# Output Example 1:
Video_Like: YES
Follow: YES
Comment: Insane details! 🤯 My clay figures are jealous. 🏺✨

# Output Example 2:
Video_Like: YES
Follow: NO
Comment: So satisfying to watch! 😍 Love this.

# Output Example 3:
Video_Like: NO
Follow: NO
Comment: NO

# Start Analysis:"""

# 指令中文映射
COMMAND_NAMES_CN = {
    'auto_comment': '自动评论',
    'monitor_next': '监控并跳转',
    'fill_comment': '填充评论',
    'like_video': '点赞视频',
    'like_top_comment': '高赞点赞',
     'like_comment': '点赞评论',
    'subscribe': '关注频道',
    'subscribe_channel': '关注频道',
    'open_comments': '打开评论区',
    'next_video': '下一个视频',
    'link_test': '连接测试'
}

class SmartCommentApp:
    def __init__(self, root):
        self.root = root
        self.root.title("AI 智能评论助手 - 专业版")
        self.root.geometry("1600x900")
        
        self.ai_engine = AIEngine()
        self.current_platform = "youtube" # 默认为 youtube

        
        # 样式配置 (暗色主题)
        self.style = ttk.Style()
        self.style.theme_use('clam')
        
        # 定义颜色
        self.bg_color = "#1e1e1e"
        self.fg_color = "#ffffff"
        self.panel_bg = "#252526"
        self.accent_color = "#007acc"
        
        self.root.configure(bg=self.bg_color)
        
        # 配置 Treeview 样式
        self.style.configure("Treeview", 
                           background=self.panel_bg, 
                           foreground=self.fg_color, 
                           fieldbackground=self.panel_bg,
                           rowheight=25)
        self.style.configure("Treeview.Heading", 
                           background="#333333", 
                           foreground="white", 
                           relief="flat")
        self.style.map("Treeview", background=[('selected', self.accent_color)])
        
        # 配置 Notebook (选项卡) 样式
        self.style.configure("TNotebook", background=self.bg_color, borderwidth=0)
        self.style.configure("TNotebook.Tab", 
                           background="#333333", 
                           foreground="white", 
                           padding=[10, 5], 
                           borderwidth=0)
        self.style.map("TNotebook.Tab", 
                     background=[('selected', self.accent_color)], 
                     foreground=[('selected', 'white')])

        # 状态变量
        self.platform_var = tk.StringVar(value="YouTube")

        # 每个平台选择使用配置1还是配置2
        self.platform_ai_config_choice = {
            "youtube": tk.StringVar(value="1"),
            "tiktok": tk.StringVar(value="2"),
        }

        # AI 配置（通用配置1/2）
        self.ai_api_key_vars = {
            "1": tk.StringVar(value=""),
            "2": tk.StringVar(value=""),
        }
        self.ai_base_url_vars = {
            "1": tk.StringVar(value=DEFAULT_BASE_URL),
            "2": tk.StringVar(value="https://api.siliconflow.cn/v1"),
        }
        self.ai_model_vars = {
            "1": tk.StringVar(value="gpt-3.5-turbo"),
            "2": tk.StringVar(value="gpt-3.5-turbo"),
        }
        # 提示词按平台分开：YouTube用第一套，TikTok用第二套
        self.platform_prompts = {
            "youtube": DEFAULT_PROMPT,
            "tiktok": DEFAULT_TIKTOK_PROMPT,
        }

        # 设置页 prompt 文本控件引用（分平台）
        self.prompt_text_widgets = {}

        # 自动化开关（分平台，避免 YouTube/TikTok 互相影响）
        self.auto_mode_vars = {
            "youtube": tk.BooleanVar(value=True),
            "tiktok": tk.BooleanVar(value=True),
        }
        self.auto_send_vars = {
            "youtube": tk.BooleanVar(value=True),
            "tiktok": tk.BooleanVar(value=True),
        }
        for pk in ("youtube", "tiktok"):
            self.auto_send_vars[pk].trace_add(
                "write",
                lambda *args, p=pk: self.on_auto_send_change(p),
            )
        self.auto_like_var = tk.BooleanVar(value=True)
        self.auto_subscribe_var = tk.BooleanVar(value=True)


        # 构建 UI
        self.create_layout()
        
        # 加载配置
        self.load_config_to_ui()
        
        # 启动定时任务
        self.process_queues()

        # 端口健康检测（避免“插件 Failed to fetch”时需要看终端）
        self._port_health_status = {
            "youtube": {"ok": None, "msg": ""},
            "tiktok": {"ok": None, "msg": ""},
        }
        self._start_port_health_monitor()

    def create_layout(self):
        main_container = tk.Frame(self.root, bg=self.bg_color)
        main_container.pack(fill="both", expand=True, padx=10, pady=10)

        self.notebook = ttk.Notebook(main_container)
        self.notebook.pack(fill="both", expand=True)

        self.tab_main = tk.Frame(self.notebook, bg=self.bg_color)
        self.notebook.add(self.tab_main, text="  主工作台  ")
        self.setup_main_tab()

        self.tab_history = tk.Frame(self.notebook, bg=self.bg_color)
        self.notebook.add(self.tab_history, text="  历史记录  ")
        self.setup_history_tab()

        self.tab_logs = tk.Frame(self.notebook, bg=self.bg_color)
        self.notebook.add(self.tab_logs, text="  运行日志  ")
        self.setup_logs_tab()

        self.tab_settings = tk.Frame(self.notebook, bg=self.bg_color)
        self.notebook.add(self.tab_settings, text="  设置  ")
        self.setup_settings_tab()

    def setup_main_tab(self):
        # Initialize platform storage
        self.platforms = {}
        
        # 主容器 - 使用 PanedWindow 实现左右分栏
        main_paned = tk.PanedWindow(self.tab_main, orient=tk.HORIZONTAL, 
                                     bg=self.bg_color, sashwidth=5, 
                                     sashrelief=tk.RAISED)
        main_paned.pack(fill="both", expand=True, padx=5, pady=5)
        
        # === 左侧：YouTube 区域 ===
        yt_frame = tk.Frame(main_paned, bg=self.bg_color)
        main_paned.add(yt_frame, minsize=500)
        
        # YouTube 上半部分：视频信息
        self.setup_video_info_section(yt_frame, "youtube", "YouTube")
        
        # YouTube 下半部分：智能回复
        self.setup_reply_section(yt_frame, "youtube", "YouTube")
        
        # === 右侧：TikTok 区域 ===
        tk_frame = tk.Frame(main_paned, bg=self.bg_color)
        main_paned.add(tk_frame, minsize=500)
        
        # TikTok 上半部分：视频信息
        self.setup_video_info_section(tk_frame, "tiktok", "TikTok")
        
        # TikTok 下半部分：智能回复
        self.setup_reply_section(tk_frame, "tiktok", "TikTok")

    def setup_video_info_section(self, parent, platform_key, platform_name):
        """创建视频信息区域（左侧信息+右侧评论）"""
        container = tk.Frame(parent, bg=self.bg_color)
        container.pack(fill="both", expand=True, pady=5)
        
        # 初始化状态
        if platform_key not in self.platforms:
            self.platforms[platform_key] = {
                "title_var": tk.StringVar(value="等待检测..."),
                "url_var": tk.StringVar(value=""),
                "time_var": tk.StringVar(value=""),
                "duration_var": tk.StringVar(value=""),
                "comments_data": [],
                "waiting": False,
                "wait_start": 0,
                "processing_url": "",
                # TikTok 播放循环/等待状态（用于“等待播放完成”提示）
                "loop_count": 0,
                "loop_threshold": 5,
                "await_play_finish": False,
                "sent_next_after_play": False,
            }
        
        state = self.platforms[platform_key]
        
        # 上半部分：视频基本信息
        info_frame = tk.LabelFrame(container, 
                                    text=f"{platform_name} 视频信息",
                                    bg=self.panel_bg, fg=self.accent_color,
                                    font=("微软雅黑", 10, "bold"))
        info_frame.pack(fill="x", expand=False, ipady=5, padx=5)
        
        self.create_info_row(info_frame, "标题:", state["title_var"])
        self.create_info_row(info_frame, "链接:", state["url_var"])
        
        time_row = tk.Frame(info_frame, bg=self.panel_bg)
        time_row.pack(fill="x", padx=5, pady=2)
        tk.Label(time_row, text="时间:", width=6, anchor="e",
                 bg=self.panel_bg, fg="#aaa").pack(side="left")
        tk.Entry(time_row, textvariable=state["time_var"], bg="#333",
                 fg="white", relief="flat", readonlybackground="#333",
                 state="readonly", width=18).pack(side="left", padx=5)
        tk.Label(time_row, text="时长:", width=6, anchor="e",
                 bg=self.panel_bg, fg="#aaa").pack(side="left", padx=(10,0))
        tk.Entry(time_row, textvariable=state["duration_var"], bg="#333",
                 fg="white", relief="flat", readonlybackground="#333",
                 state="readonly", width=12).pack(side="left", padx=5)
        
        # 下半部分：评论区
        comments_frame = tk.LabelFrame(container,
                                        text=f"{platform_name} 评论区 (Top 3)",
                                        bg=self.panel_bg, fg=self.accent_color,
                                        font=("微软雅黑", 10, "bold"))
        comments_frame.pack(fill="both", expand=True, padx=5, pady=5)
        
        state["comments_text"] = scrolledtext.ScrolledText(
            comments_frame, bg="#333333", fg="#dddddd",
            font=("微软雅黑", 9), height=8, relief="flat",
            padx=5, pady=5, wrap=tk.WORD
        )
        state["comments_text"].pack(fill="both", expand=True, padx=5, pady=5)

    def setup_reply_section(self, parent, platform_key, platform_name):
        """创建智能回复区域"""
        state = self.platforms[platform_key]
        
        reply_frame = tk.LabelFrame(parent,
                                     text=f"{platform_name} 智能回复",
                                     bg=self.panel_bg, fg=self.accent_color,
                                     font=("微软雅黑", 10, "bold"))
        reply_frame.pack(fill="both", expand=True, padx=5, pady=5)
        
        # 工具栏
        toolbar = tk.Frame(reply_frame, bg=self.panel_bg)
        toolbar.pack(fill="x", padx=5, pady=5)
        
        # 第一行：生成按钮和选项
        row1 = tk.Frame(toolbar, bg=self.panel_bg)
        row1.pack(fill="x", pady=2)
        
        tk.Button(row1, text="✨ 生成评价",
                  command=lambda: self.generate_ai_reply(platform_key),
                  bg=self.accent_color, fg="white", relief="flat",
                  padx=15, font=("微软雅黑", 9)).pack(side="left", padx=5)
        
        # 配置选择
        tk.Label(row1, text="使用配置:", bg=self.panel_bg, fg="#aaaaaa",
                font=("微软雅黑", 9)).pack(side="left", padx=(10, 2))
        ttk.Combobox(
            row1,
            textvariable=self.platform_ai_config_choice[platform_key],
            values=["1", "2"],
            width=3,
            state="readonly"
        ).pack(side="left", padx=2)
        
        state["status_label"] = tk.Label(row1, text="就绪",
                                          bg=self.panel_bg, fg="#28a745",
                                          font=("微软雅黑", 10))
        state["status_label"].pack(side="left", padx=10)

        # 连接测试（放在左右按钮之间的空白区域）
        mid = tk.Frame(row1, bg=self.panel_bg)
        mid.pack(side="left", expand=True, fill="x")
        mid_inner = tk.Frame(mid, bg=self.panel_bg)
        mid_inner.pack(anchor="center")
        tk.Button(mid_inner, text="连接测试",
                  command=lambda p=platform_key: self.test_plugin_link(p),
                  bg="#555", fg="white", relief="flat",
                  padx=12, font=("微软雅黑", 9)).pack(side="left", padx=6)

        # 服务端端口健康（本机 8088/8099 是否可连接）
        state["port_health_label"] = tk.Label(
            mid_inner,
            text="服务端: -",
            bg=self.panel_bg,
            fg="#888",
            font=("微软雅黑", 9),
        )
        state["port_health_label"].pack(side="left", padx=6)

        tk.Button(mid_inner, text="清空",
                  command=lambda p=platform_key: self.clear_platform_ui(p),
                  bg="#555", fg="white", relief="flat",
                  padx=18, font=("微软雅黑", 9)).pack(side="left", padx=6)
        
        # 快捷指令（TikTok 的测试入口已迁移到插件端，这里只保留通用指令，避免双入口导致误触）
        cmds = [
            ("点赞视频", "like_video"),
            ("下一个视频", "monitor_next"),
        ]

        # TikTok：把“打开评论区”改为“测试评论”（下发 auto_comment 指令，让插件侧做
        # 桌面点击输入框 → 桌面键入 → Enter/Post 发送 的完整链路测试）
        if platform_key == "tiktok":
            tk.Button(
                row1,
                text="测试评论",
                command=lambda p=platform_key: self.send_test_comment(p),
                bg="#444",
                fg="white",
                relief="flat",
                padx=8,
                font=("微软雅黑", 9),
            ).pack(side="right", padx=2)
        else:
            cmds.insert(1, ("打开评论区", "open_comments"))

        for label, cmd in cmds:
            tk.Button(row1, text=label,
                      command=lambda c=cmd, p=platform_key:
                      self.send_command(c, platform=p),
                      bg="#444", fg="white", relief="flat",
                      padx=8, font=("微软雅黑", 9)).pack(
                          side="right", padx=2)
        
        # 第二行：模型选择
        row2 = tk.Frame(toolbar, bg=self.panel_bg)
        row2.pack(fill="x", pady=2)
        
        tk.Label(row2, text="模型:", bg=self.panel_bg, fg="#aaa",
                 width=6).pack(side="left")
        # TikTok 需要支持 SiliconFlow 这类带斜杠的模型名，因此允许手动输入
        model_values = ["sonar-pro", "sonar", "gpt-3.5-turbo", "gpt-4o"]
        if platform_key == "tiktok":
            model_values = [
                "Qwen/QwQ-32B",
                "Qwen/Qwen3-32B",
                "deepseek-ai/DeepSeek-V3.1-Terminus",
                "moonshotai/Kimi-K2-Instruct-0905",
            ] + model_values

        # 根据平台当前选择的配置号来获取对应的 model 变量
        config_num = self.platform_ai_config_choice[platform_key].get() or "1"
        model_cb = ttk.Combobox(
            row2,
            textvariable=self.ai_model_vars[config_num],
            values=model_values,
            width=28,
            state=("normal" if platform_key == "tiktok" else "readonly"),
        )
        model_cb.pack(side="left", padx=5)
        
        # 自动控制选项
        tk.Checkbutton(row2, text="自动生成",
                       variable=self.auto_mode_vars[platform_key],
                       bg=self.panel_bg, fg="white",
                       selectcolor="#333").pack(side="left", padx=5)
        tk.Checkbutton(row2, text="自动发送",
                       variable=self.auto_send_vars[platform_key],
                       bg=self.panel_bg, fg="white",
                       selectcolor="#333").pack(side="left", padx=5)
        
        # 回复文本区
        state["reply_text"] = scrolledtext.ScrolledText(
            reply_frame, bg="#333333", fg="white",
            insertbackground="white", font=("微软雅黑", 10),
            height=12, wrap=tk.WORD
        )
        state["reply_text"].pack(fill="both", expand=True, padx=5, pady=5)
        
        # 底部操作栏
        action_bar = tk.Frame(reply_frame, bg=self.panel_bg)
        action_bar.pack(fill="x", padx=5, pady=5)
        
        state["interest_label"] = tk.Label(action_bar, text="[兴趣: 未知]",
                                            bg=self.panel_bg, fg="#888",
                                            font=("微软雅黑", 9))
        state["interest_label"].pack(side="left", padx=5)
        
        state["follow_label"] = tk.Label(action_bar, text="[关注: 未知]",
                                          bg=self.panel_bg, fg="#888",
                                          font=("微软雅黑", 9))
        state["follow_label"].pack(side="left", padx=5)

        state["action_label"] = tk.Label(
            action_bar,
            text="[动作: 未解析]" if platform_key == "tiktok" else "",
            bg=self.panel_bg,
            fg="#888",
            font=("微软雅黑", 9),
        )
        state["action_label"].pack(side="left", padx=5)
        
        tk.Button(action_bar, text="发送到评论框",
                  command=lambda: self.send_reply_to_browser(platform_key),
                  bg="#28a745", fg="white", relief="flat",
                  padx=15, font=("微软雅黑", 9)).pack(side="right")

    def clear_platform_ui(self, platform_key):
        """清空对应平台区域内容：网址/标题/时间/评论/AI 内容等。"""
        state = self.platforms.get(platform_key)
        if not state:
            return

        # 基本信息
        state["title_var"].set("等待检测...")
        state["url_var"].set("")
        state["time_var"].set("")
        state["duration_var"].set("")

        # 评论与 AI 输出
        state["comments_data"] = []
        if state.get("comments_text") is not None:
            state["comments_text"].delete(1.0, tk.END)
        if state.get("reply_text") is not None:
            state["reply_text"].delete(1.0, tk.END)

        # 状态栏/标记
        state["waiting"] = False
        state["wait_start"] = 0
        state["processing_url"] = ""

        state["loop_count"] = 0
        state["loop_threshold"] = 5
        state["await_play_finish"] = False
        state["sent_next_after_play"] = False

        if state.get("status_label") is not None:
            state["status_label"].config(text="就绪", fg="#28a745")
        if state.get("interest_label") is not None:
            state["interest_label"].config(text="[兴趣: 未知]", fg="#888")
        if state.get("follow_label") is not None:
            state["follow_label"].config(text="[关注: 未知]", fg="#888")
        if state.get("action_label") is not None:
            state["action_label"].config(
                text="[动作: 未解析]" if platform_key == "tiktok" else "",
                fg="#888",
            )

        log_queue.put(f"🧹 [{platform_key}] 已清空：标题/链接/时间/评论/AI 输出")

    def _start_port_health_monitor(self):
        # 稳妥：窗口关闭后不再调度
        try:
            if not self.root.winfo_exists():
                return
        except Exception:
            return

        self._update_port_health_once()
        # 每 2 秒刷新一次即可，避免过频
        self.root.after(2000, self._start_port_health_monitor)

    def _check_local_port(self, host: str, port: int, timeout_sec: float = 0.25):
        """检查本机端口是否可连接。返回 (ok, msg)。"""
        try:
            with socket.create_connection((host, int(port)), timeout=float(timeout_sec)):
                return True, ""
        except Exception as e:
            msg = str(e) or e.__class__.__name__
            # 去掉过长的信息
            msg = msg.replace("[WinError 10061]", "WinError10061").strip()
            return False, msg

    def _update_port_health_once(self):
        port_map = {"youtube": 8088, "tiktok": 8099}
        for pk, port in port_map.items():
            ok, msg = self._check_local_port("127.0.0.1", port)

            prev = self._port_health_status.get(pk, {"ok": None, "msg": ""})
            changed = (prev.get("ok") is None) or (prev.get("ok") != ok)
            self._port_health_status[pk] = {"ok": ok, "msg": msg}

            state = self.platforms.get(pk) or {}
            label = state.get("port_health_label")
            if label is not None:
                if ok:
                    label.config(text=f"服务端:{port} ✅", fg="#69db7c")
                else:
                    label.config(text=f"服务端:{port} ❌", fg="#ff6b6b")

            if changed:
                if ok:
                    log_queue.put(f"🟢 [{pk}] 服务端端口 {port} 已恢复可连接")
                else:
                    # 失败原因只在变更时提示一次，避免刷屏
                    log_queue.put(f"🔴 [{pk}] 服务端端口 {port} 无法连接：{msg}")

    def setup_settings_tab(self):
        container = tk.Frame(self.tab_settings, bg=self.bg_color)
        container.pack(fill="both", expand=True, padx=20, pady=20)

        # 两个平台独立配置
        # 左右分栏：YouTube AI（左） + TikTok AI（右）
        split_frame = tk.Frame(container, bg=self.bg_color)
        # 只按内容高度占位，避免把提示词区域挤到最底下产生大空白
        split_frame.pack(fill="x")

        yt_col = tk.Frame(split_frame, bg=self.bg_color)
        yt_col.pack(side="left", fill="x", expand=True, padx=(0, 5))

        tk_col = tk.Frame(split_frame, bg=self.bg_color)
        tk_col.pack(side="right", fill="x", expand=True, padx=(5, 0))

        def build_ai_page(parent, config_key, config_name):
            page = tk.Frame(parent, bg=self.bg_color)
            page.pack(fill="x", padx=10, pady=(5, 0))

            ai_frame = tk.LabelFrame(
                page,
                text=f"{config_name}",
                bg=self.panel_bg,
                fg=self.accent_color,
                font=("微软雅黑", 10, "bold"),
            )
            ai_frame.pack(fill="x", pady=5, ipady=10)

            row1 = tk.Frame(ai_frame, bg=self.panel_bg)
            row1.pack(fill="x", padx=10, pady=5)
            tk.Label(
                row1,
                text="API Key:",
                bg=self.panel_bg,
                fg="white",
                width=10,
                anchor="e",
            ).pack(side="left")
            tk.Entry(
                row1,
                textvariable=self.ai_api_key_vars[config_key],
                bg="#333",
                fg="white",
                width=55,
                show="*",
            ).pack(side="left", padx=10)

            row2 = tk.Frame(ai_frame, bg=self.panel_bg)
            row2.pack(fill="x", padx=10, pady=5)
            tk.Label(
                row2,
                text="Base URL:",
                bg=self.panel_bg,
                fg="white",
                width=10,
                anchor="e",
            ).pack(side="left")
            tk.Entry(
                row2,
                textvariable=self.ai_base_url_vars[config_key],
                bg="#333",
                fg="white",
                width=55,
            ).pack(side="left", padx=10)

            row3 = tk.Frame(ai_frame, bg=self.panel_bg)
            row3.pack(fill="x", padx=10, pady=5)
            tk.Label(
                row3,
                text="Model:",
                bg=self.panel_bg,
                fg="white",
                width=10,
                anchor="e",
            ).pack(side="left")
            if config_key == "2":
                tk.Entry(
                    row3,
                    textvariable=self.ai_model_vars[config_key],
                    bg="#333",
                    fg="white",
                    width=55,
                ).pack(side="left", padx=10)
            else:
                ttk.Combobox(
                    row3,
                    textvariable=self.ai_model_vars[config_key],
                    values=["sonar-pro", "sonar", "gpt-3.5-turbo", "gpt-4o"],
                    width=18,
                    state="readonly",
                ).pack(side="left", padx=10)

            btn_frame = tk.Frame(page, bg=self.bg_color)
            btn_frame.pack(fill="x", pady=(5, 0))

            tk.Button(
                btn_frame,
                text="测试连接",
                command=lambda ck=config_key: self.test_ai_connection(ck),
                bg="#17a2b8",
                fg="white",
                font=("微软雅黑", 10),
                padx=20,
                pady=5,
            ).pack(side="left", padx=10)
            tk.Button(
                btn_frame,
                text="保存配置",
                command=self.save_config_ui,
                bg=self.accent_color,
                fg="white",
                font=("微软雅黑", 10),
                padx=20,
                pady=5,
            ).pack(side="left", padx=10)

        build_ai_page(yt_col, "1", "配置1 (AI接口)")
        build_ai_page(tk_col, "2", "配置2 (AI接口)")

        # 提示词区域（独立于配置1/2）
        prompt_split = tk.Frame(container, bg=self.bg_color)
        prompt_split.pack(fill="x", pady=(0, 0))

        def build_prompt_page(parent, platform_key: str, prompt_name: str):
            prompt_frame = tk.LabelFrame(
                parent,
                text=f"{prompt_name} 提示词",
                bg=self.panel_bg,
                fg=self.accent_color,
                font=("微软雅黑", 10, "bold"),
            )
            prompt_frame.pack(fill="x", pady=2, ipady=2)

            tk.Label(
                prompt_frame,
                text="可用变量: {title}=标题, {comment_1/2/3}=热评内容(无用户名)",
                bg=self.panel_bg,
                fg="#888",
                anchor="w",
            ).pack(fill="x", padx=10, pady=(3, 0))

            btn_row = tk.Frame(prompt_frame, bg=self.panel_bg)
            btn_row.pack(fill="x", padx=10, pady=2)

            prompt_widget = scrolledtext.ScrolledText(
                prompt_frame,
                bg="#333",
                fg="white",
                insertbackground="white",
                font=("微软雅黑", 10),
                height=10,
            )
            prompt_widget.pack(fill="both", expand=True, padx=10, pady=5)
            prompt_widget.insert("1.0", self.platform_prompts[platform_key])
            self.prompt_text_widgets[platform_key] = prompt_widget

            def insert_var(v):
                prompt_widget.insert(tk.INSERT, v)
                prompt_widget.focus()

            tk.Button(
                btn_row,
                text="+ 标题 {title}",
                command=lambda: insert_var("{title}"),
                bg="#444",
                fg="white",
                relief="flat",
                font=("Consolas", 9),
            ).pack(side="left", padx=2)
            tk.Button(
                btn_row,
                text="+ 评论1 {comment_1}",
                command=lambda: insert_var("{comment_1}"),
                bg="#444",
                fg="white",
                relief="flat",
                font=("Consolas", 9),
            ).pack(side="left", padx=2)
            tk.Button(
                btn_row,
                text="+ 评论2 {comment_2}",
                command=lambda: insert_var("{comment_2}"),
                bg="#444",
                fg="white",
                relief="flat",
                font=("Consolas", 9),
            ).pack(side="left", padx=2)
            tk.Button(
                btn_row,
                text="+ 评论3 {comment_3}",
                command=lambda: insert_var("{comment_3}"),
                bg="#444",
                fg="white",
                relief="flat",
                font=("Consolas", 9),
            ).pack(side="left", padx=2)

        # 左栏：YouTube提示词（第一套）
        yt_prompt_col = tk.Frame(prompt_split, bg=self.bg_color)
        yt_prompt_col.pack(side="left", fill="x", expand=True, padx=(0, 5))
        build_prompt_page(yt_prompt_col, "youtube", "YouTube")

        # 右栏：TikTok提示词（第二套）
        tk_prompt_col = tk.Frame(prompt_split, bg=self.bg_color)
        tk_prompt_col.pack(side="left", fill="x", expand=True, padx=(5, 0))
        build_prompt_page(tk_prompt_col, "tiktok", "TikTok")

    def setup_history_tab(self):
        columns = ("time", "title", "url")
        self.history_tree = ttk.Treeview(self.tab_history, columns=columns, show="headings", selectmode="browse")
        
        self.history_tree.heading("time", text="时间")
        self.history_tree.heading("title", text="视频标题")
        self.history_tree.heading("url", text="链接")
        
        self.history_tree.column("time", width=150, anchor="center")
        self.history_tree.column("title", width=400)
        self.history_tree.column("url", width=300)
        
        v_scroll = ttk.Scrollbar(self.tab_history, orient="vertical", command=self.history_tree.yview)
        self.history_tree.configure(yscrollcommand=v_scroll.set)
        
        self.history_tree.pack(side="left", fill="both", expand=True, padx=10, pady=10)
        v_scroll.pack(side="right", fill="y", pady=10)

    def setup_logs_tab(self):
        # 使用 Text 控件替代 Listbox，支持多颜色显示
        self.log_list = scrolledtext.ScrolledText(
            self.tab_logs, 
            bg="#333333", 
            fg="#cccccc", 
            font=("Consolas", 10),
            wrap=tk.WORD,
            state="disabled"  # 防止用户编辑
        )
        self.log_list.pack(fill="both", expand=True, padx=10, pady=10)
        
        # 配置时间戳标签：亮黄色
        self.log_list.tag_config("timestamp", foreground="#FFD700", font=("Consolas", 10, "bold"))
        # 配置消息标签：浅灰色
        self.log_list.tag_config("message", foreground="#E0E0E0")

    def create_info_row(self, parent, label_text, variable):
        row = tk.Frame(parent, bg=self.panel_bg)
        row.pack(fill="x", padx=5, pady=2)
        tk.Label(row, text=label_text, width=6, anchor="e", bg=self.panel_bg, fg="#aaaaaa").pack(side="left")
        tk.Entry(row, textvariable=variable, bg="#333", fg="white", relief="flat", readonlybackground="#333", state="readonly").pack(side="left", fill="x", expand=True, padx=5)

    def process_queues(self):
        # 每次只处理少量消息，避免UI卡顿
        # 处理最多3条日志消息
        log_count = 0
        max_logs_per_cycle = 3
        
        while not log_queue.empty() and log_count < max_logs_per_cycle:
            msg = log_queue.get()
            timestamp = datetime.datetime.now().strftime("%H:%M:%S")
            
            # 启用编辑以插入内容
            self.log_list.config(state="normal")
            
            # 在开头插入时间戳（亮黄色）
            self.log_list.insert("1.0", f"[{timestamp}] ", "timestamp")
            # 在时间戳后插入消息（浅灰色）
            self.log_list.insert("1.11", f"{msg}\n", "message")
            
            # 禁用编辑
            self.log_list.config(state="disabled")
            
            log_count += 1
        
        # 每100次循环检查一次行数限制（减少性能开销）
        if not hasattr(self, '_line_check_counter'):
            self._line_check_counter = 0
        self._line_check_counter += 1
        
        if self._line_check_counter >= 100:
            self._line_check_counter = 0
            self.log_list.config(state="normal")
            lines = int(self.log_list.index('end-1c').split('.')[0])
            if lines > 500:
                self.log_list.delete("501.0", "end")
            self.log_list.config(state="disabled")
        
        # 每次只处理1条数据消息
        if not data_queue.empty():
            data = data_queue.get()
            self.handle_incoming_data(data)
            
        for platform_key, state in self.platforms.items():
            if not self.auto_mode_vars[platform_key].get():
                continue
            if state.get("waiting", False):
                if (time.time() - state.get("wait_start", 0)) > 8.0:
                    log_queue.put(
                        f"⚠️ [{platform_key}] 全局超时检测 (8秒)，强制触发 AI..."
                    )
                    self.generate_ai_reply(platform_key)
                    state["waiting"] = False

        self.root.after(100, self.process_queues)

    def handle_incoming_data(self, data):
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        platform = data.get('platform', 'youtube')
        
        # 详细调试日志
        print(f"\n{'='*60}")
        print(f"[UI] 处理传入数据")
        print(f"[UI] - 平台: {platform}")
        print(f"[UI] - 标题: {data.get('title', 'N/A')[:50]}")
        print(f"[UI] - URL: {data.get('url', 'N/A')[:60]}")
        extra = data.get('extra_data', {})
        comments = extra.get('comments', [])
        print(f"[UI] - 评论数量: {len(comments)}")
        if comments:
            print(f"[UI] - 评论详情:")
            for i, c in enumerate(comments[:3]):
                print(f"  [{i+1}] {c.get('author', 'Unknown')}: "
                      f"{c.get('content', '')[:30]}... "
                      f"({c.get('likes', 0)}赞)")
        print(f"{'='*60}\n")
        
        # 调试日志：显示接收到的平台信息
        log_queue.put(
            f"📥 接收数据 [平台: {platform}] "
            f"URL: {data.get('url', 'N/A')[:50]}")
        
        if platform not in self.platforms:
            log_queue.put(f"⚠️ 未知平台 '{platform}'，使用 youtube 作为默认值")
            platform = 'youtube'
            
        self.current_platform = platform
        
        state = self.platforms[platform]
        
        if data.get('type') == 'comment_success':
            url = data.get('url', '')
            log_queue.put(f"✅ 评论成功 [{platform}]: {url[-11:] if len(url)>11 else url}")
            if self.auto_send_vars[platform].get():
                log_queue.put(f"⏳ [{platform}] 自动流程: 评论已完成，发送监控指令...")
                self.send_command("monitor_next", platform=platform)
            else:
                log_queue.put(f"ℹ️ [{platform}] 评论已完成 (自动跳转未开启)")
            return

        # 优先从 data 中直接获取标题
        title = data.get('title', '')
        url = data.get('url', '')
        
        # 如果没有直接的 title 字段，尝试从 message 解析
        if not title:
            msg = data.get('message', '')
            if msg.startswith("自动检测:"):
                parts = msg.split('|')
                if len(parts) > 0:
                    title = parts[0].replace("自动检测:", "").strip()
        
        # 最后尝试从 html_content 提取
        if not title and 'html_content' in data:
            try:
                match = re.search(r'<meta name="title" content="(.*?)">', data['html_content'], re.IGNORECASE)
                if match:
                    title = html.unescape(match.group(1))
            except:
                pass

        # 更新 UI 字段
        if title: state["title_var"].set(title)
        if url: state["url_var"].set(url)
        state["time_var"].set(timestamp)
        
        if 'extra_data' in data:
            extra = data['extra_data']
            if 'duration' in extra:
                state["duration_var"].set(extra['duration'])
            
            if 'comments' in extra and isinstance(extra['comments'], list):
                state["comments_data"] = extra['comments']
                state["comments_text"].delete(1.0, tk.END)
                for i, c in enumerate(extra['comments']):
                    author = c.get('author', 'Unknown')
                    content = c.get('content', '')
                    likes = c.get('likes', '0')
                    state["comments_text"].insert(tk.END, f"[{i+1}] {author} (👍{likes}): {content}\n\n")

        # 筛选逻辑已移到插件端，客户端只处理已筛选的高质量视频
        # 插件端会直接处理低质量视频，不会发送到这里

        if title and url:
            if state["processing_url"] != url:
                # Add to history
                self.history_tree.insert("", 0, values=(timestamp, title, url))
                log_queue.put(f"[{platform}] 捕获新视频: {title[:20]}...")
                
                state["waiting"] = True
                state["wait_start"] = time.time()
                state["processing_url"] = url
                state["comments_data"] = []
                
                # 清空之前的 AI 回复内容
                state["reply_text"].delete(1.0, tk.END)
        
        incoming_url = data.get('url', '')
        
        if self.auto_mode_vars[platform].get() and state["waiting"]:
            if incoming_url == state["processing_url"]:
                has_comments = len(state["comments_data"]) > 0
                client_timeout = "无评论或加载超时" in data.get('message', '')
                is_timeout = (time.time() - state["wait_start"]) > 8.0
                
                if has_comments:
                    log_queue.put(f"✅ [{platform}] 获取到 {len(state['comments_data'])} 条评论，触发 AI...")
                    self.generate_ai_reply(platform)
                    state["waiting"] = False
                elif client_timeout:
                    log_queue.put(f"ℹ️ [{platform}] 客户端报告无评论，立即触发 AI...")
                    self.generate_ai_reply(platform)
                    state["waiting"] = False
                elif is_timeout:
                    log_queue.put(f"⚠️ [{platform}] 等待评论超时 (8秒)，尝试无评论生成...")
                    self.generate_ai_reply(platform)
                    state["waiting"] = False

    def generate_ai_reply(self, platform_key=None):
        if platform_key is None:
            platform_key = self.current_platform
            
        state = self.platforms.get(platform_key)
        if not state: return

        title = state["title_var"].get()
        if not title or title == "等待检测...":
            log_queue.put(f"[{platform_key}] 错误: 没有检测到视频标题，无法生成")
            return
            
        # 获取该平台选择使用的配置号
        config_choice = self.platform_ai_config_choice.get(platform_key)
        if config_choice is None:
            config_choice = tk.StringVar(value="1")
            self.platform_ai_config_choice[platform_key] = config_choice
        config_num = config_choice.get() or "1"
        
        cfg = self._collect_ai_config(config_num, platform_key)
        api_key = cfg["api_key"]
        base_url = cfg["base_url"]
        model = cfg["model"]
        prompt_template = cfg["prompt_template"]
        
        if not api_key:
            log_queue.put(f"[{platform_key}] 提示: 未配置 API Key，使用模拟数据")
            self._simulate_ai_reply(title, platform_key)
            return

        log_queue.put(f"[{platform_key}] 正在请求 AI ({model})...")
        state["status_label"].config(text="思考中...", fg="#ffc107")

        self.ai_engine.update_config(api_key, base_url, model, prompt_template)
        self.ai_engine.generate_reply(title, state["comments_data"], lambda s, r: self.process_ai_decision(s, r, platform_key))

    def _parse_count_to_int(self, value) -> int:
        """把 '4.7K' / '1,234' / 232 / None 等统一转成 int。"""
        if value is None:
            return 0
        if isinstance(value, (int, float)):
            try:
                return int(value)
            except Exception:
                return 0

        s = str(value).strip()
        if not s:
            return 0

        s = s.replace(',', '').replace(' ', '').upper()
        m = re.match(r'^([0-9]+(?:\.[0-9]+)?)([KMB])?$', s)
        if not m:
            # 尝试提取纯数字
            m2 = re.search(r'(\d+)', s)
            return int(m2.group(1)) if m2 else 0

        num = float(m.group(1))
        unit = m.group(2)
        if unit == 'K':
            num *= 1000
        elif unit == 'M':
            num *= 1000000
        elif unit == 'B':
            num *= 1000000000
        return int(num)

    def _collect_ai_config(self, config_key: str, platform_key: str) -> dict:
        """从 UI（设置页）收集指定配置的 AI 配置。
        
        Args:
            config_key: 配置编号 "1" 或 "2"
            platform_key: 平台标识 "youtube" 或 "tiktok"
        """
        ck = str(config_key or "1")
        if ck not in ("1", "2"):
            ck = "1"

        # 获取API接口配置
        api_key = self.ai_api_key_vars[ck].get()
        base_url = self.ai_base_url_vars[ck].get() or DEFAULT_BASE_URL
        model = self.ai_model_vars[ck].get() or "gpt-3.5-turbo"

        # 获取平台对应的提示词
        prompt_widget = self.prompt_text_widgets.get(platform_key)
        if prompt_widget is not None:
            prompt_text = prompt_widget.get("1.0", tk.END).strip()
        else:
            prompt_text = str(self.platform_prompts.get(platform_key, DEFAULT_PROMPT) or "").strip()

        if not prompt_text:
            prompt_text = DEFAULT_TIKTOK_PROMPT if platform_key == "tiktok" else DEFAULT_PROMPT

        # 同步内存态
        self.platform_prompts[platform_key] = prompt_text

        return {
            "api_key": api_key,
            "base_url": base_url,
            "model": model,
            "prompt_template": prompt_text,
        }

    def _simulate_ai_reply(self, title, platform_key):
        state = self.platforms[platform_key]
        state["status_label"].config(text="模拟生成...", fg="#ffc107")
        if platform_key == "tiktok":
            templates = [
                "Video_Like: [YES]\nFollow: [NO]\nComment: [做得真精致！]",
                "Video_Like: [NO]\nFollow: [NO]\nComment: [NO]",
                "Video_Like: [YES]\nFollow: [YES]\nComment: [手艺太棒了]",
            ]
            reply = random.choice(templates)
        else:
            templates = [
                f"Great video about '{title}', learned a lot!",
                f"Interesting point on '{title}', keep it up!",
                f"Wow, never thought about '{title}' this way.",
                "Supporting from the front row!",
                "Great content, liked and subscribed!"
            ]
            reply = random.choice(templates)
        self.root.after(1000, lambda: self.process_ai_decision(True, reply, platform_key))

    def process_ai_decision(self, success, reply, platform_key):
        state = self.platforms[platform_key]
        
        if not success:
            self.handle_ai_error(reply, platform_key)
            return

        if platform_key == "tiktok":
            plan = self._parse_tiktok_action_plan(reply)
            if not plan:
                state["reply_text"].delete(1.0, tk.END)
                state["reply_text"].insert(tk.END, reply)
                state["status_label"].config(text="生成完毕(未解析)", fg="#ffc107")
                state["interest_label"].config(text="[兴趣: 未知]", fg="#888")
                state["follow_label"].config(text="[关注: 未知]", fg="#888")
                if state.get("action_label") is not None:
                    state["action_label"].config(text="[动作: 未解析(需严格3行)]", fg="#ffc107")
                log_queue.put(f"⚠️ [tiktok] AI 输出无法解析为 3 行动作格式，已停止自动执行")
                return

            normalized = self._format_tiktok_action_plan(plan)
            state["reply_text"].delete(1.0, tk.END)
            state["reply_text"].insert(tk.END, normalized)

            video_like = plan.get("video_like")
            follow = plan.get("follow")
            state["status_label"].config(text="动作决策已生成", fg="#28a745")
            state["interest_label"].config(
                text="[兴趣: 感兴趣]" if video_like else "[兴趣: 不感兴趣]",
                fg="#69db7c" if video_like else "#ff6b6b",
            )
            state["follow_label"].config(
                text="[关注: 建议关注]" if follow else "[关注: 无需关注]",
                fg="#69db7c" if follow else "#888",
            )

            if state.get("action_label") is not None:
                summary = self._tiktok_action_summary(plan)
                state["action_label"].config(text=f"[动作: {summary}]", fg="#69db7c")

            # TikTok：Video_Like=NO 仅代表“不点赞视频”，仍允许点赞评论/关注。
            # 只有当所有动作都为 NO（且自动发送开启）时，才自动跳过到下一个视频。
            has_other_actions = any(
                [
                    plan.get("follow") is True,
                    bool(plan.get("comment")),
                ]
            )
            if video_like is False and not has_other_actions:
                if not self.auto_send_vars[platform_key].get():
                    log_queue.put("ℹ️ [tiktok] 全部动作=NO 且自动发送未开启：等待手动点击跳过")
                    return

                def _skip_next():
                    log_queue.put("⏭️ [tiktok] AI 判定全部不操作，跳到下一个视频...")
                    self.send_command("monitor_next", platform="tiktok", reason="ai_no_interest")
                    if state.get("action_label") is not None:
                        state["action_label"].config(
                            text=f"[动作: {self._tiktok_action_summary(plan)} | 跳转下一个]",
                            fg="#ffc107",
                        )

                self.root.after(500, _skip_next)
                return

            log_queue.put(
                "🤖 [tiktok] 动作决策: "
                f"Video_Like={self._bool_to_yesno(video_like)} "
                f"Follow={self._bool_to_yesno(follow)} "
                f"Comment={'YES' if bool(plan.get('comment')) else 'NO'}"
            )

            if not self.auto_send_vars[platform_key].get():
                log_queue.put("ℹ️ [tiktok] 自动发送未开启，等待手动执行")
                return

            self._execute_tiktok_action_plan(plan)
            if state.get("action_label") is not None:
                state["action_label"].config(
                    text=f"[动作: {self._tiktok_action_summary(plan)} | 已下发]",
                    fg="#69db7c",
                )
            return

        lines = reply.strip().split('\n')
        first_line = lines[0].strip().upper().replace('*', '').replace('#', '')
        
        decision = "UNKNOWN"
        if first_line.startswith("YES"):
            decision = "YES"
        elif first_line.startswith("NO"):
            decision = "NO"
        
        if decision == "NO":
            state["status_label"].config(text="AI跳过", fg="#ffc107")
            state["interest_label"].config(
                text="[兴趣: 不感兴趣]", fg="#ff6b6b")
            state["follow_label"].config(
                text="[关注: 无需关注]", fg="#888")
            
            print("\n" + "="*50)
            print("[AI] 决策: NO - 不感兴趣")
            print(f"  - 平台: {platform_key}")
            print(f"  - 自动发送: {self.auto_send_vars[platform_key].get()}")
            print("="*50 + "\n")
            
            log_queue.put(
                f"🤖 [{platform_key}] AI 决定不评论 (NO)")
            state["reply_text"].delete(1.0, tk.END)
            state["reply_text"].insert(tk.END, "(AI 建议跳过此视频)")
            
            if self.auto_send_vars[platform_key].get():
                log_queue.put(
                    f"⏳ [{platform_key.upper()}] "
                    f"自动发送已开启，准备跳过视频...")
                
                def send_skip_cmd(pk=platform_key):
                    print(f"[UI] 🚀 立即发送跳过指令: platform={pk}")
                    log_queue.put(
                        f"🚀 [{pk.upper()}] "
                        f"发送【监控并跳转】指令 "
                        f"(原因: AI建议跳过)")
                    self.send_command(
                        "monitor_next", platform=pk, reason="ai_skip")
                
                self.root.after(1000, send_skip_cmd)
            else:
                log_queue.put(
                    f"ℹ️ [{platform_key}] "
                    f"自动发送未开启，请手动操作")
            return

        if decision == "YES":
            comment_lines = []
            should_follow = False
            
            for line in lines[1:]:
                clean_line = line.strip()
                if clean_line.upper().startswith("FOLLOW:"):
                    if "YES" in clean_line.upper():
                        should_follow = True
                else:
                    comment_lines.append(line)
            
            content = "\n".join(comment_lines).strip()
            if not content:
                pattern = r'^YES\s*[:\-\.]?\s*'
                content = re.sub(
                    pattern, '', lines[0], flags=re.IGNORECASE).strip()
            
            state["reply_text"].delete(1.0, tk.END)
            state["reply_text"].insert(tk.END, content)
            
            status_text = "准备发送"
            if should_follow:
                status_text += " (+关注)"
            state["status_label"].config(text=status_text, fg="#28a745")
            
            state["interest_label"].config(text="[兴趣: 感兴趣]", fg="#69db7c")
            if should_follow:
                state["follow_label"].config(text="[关注: 建议关注]", fg="#69db7c")
            else:
                state["follow_label"].config(text="[关注: 无需关注]", fg="#888")
            
            follow_text = 'YES' if should_follow else 'NO'
            log_queue.put(
                f"🤖 [{platform_key}] AI 决定评论 (YES) | "
                f"关注建议: {follow_text}")
            
            if self.auto_like_var.get():
                log_queue.put(f"👍 [{platform_key}] 触发自动点赞...")
                self.send_command("like_video", platform=platform_key)
                
            if should_follow and self.auto_subscribe_var.get():
                log_queue.put(f"➕ [{platform_key}] 触发自动关注...")
                self.send_command("subscribe_channel", platform=platform_key)

            if self.auto_send_vars[platform_key].get():
                log_queue.put(
                    f"⏳ [{platform_key}] 自动发送: 准备发送评论...")
                self.root.after(
                    1000, lambda: self.send_reply_to_browser(platform_key))
            else:
                log_queue.put(f"ℹ️ [{platform_key}] 自动发送未开启，等待手动操作")
            return

        state["reply_text"].delete(1.0, tk.END)
        state["reply_text"].insert(tk.END, reply)
        state["status_label"].config(text="生成完毕", fg="#28a745")
        
        state["interest_label"].config(text="[兴趣: 未知]", fg="#888")
        state["follow_label"].config(text="[关注: 未知]", fg="#888")
        
        log_queue.put(f"[{platform_key}] AI 回复已生成 (非标准格式)")

        if platform_key == "tiktok":
            log_queue.put(
                f"ℹ️ [{platform_key}] TikTok 输出非标准格式，已停止自动执行")
            return

        if self.auto_send_vars[platform_key].get():
            self.root.after(1000, lambda: self.send_reply_to_browser(platform_key))
        else:
            log_queue.put(f"ℹ️ [{platform_key}] 自动发送未开启，等待手动操作")

    def handle_ai_error(self, error_msg, platform_key):
        state = self.platforms[platform_key]
        state["status_label"].config(text="生成失败", fg="#d9534f")
        log_queue.put(f"[{platform_key}] AI 错误: {error_msg}")

    def send_reply_to_browser(self, platform_key):
        state = self.platforms[platform_key]

        # TikTok：不走“发表评论文本”，按 3 行决策执行 点赞/关注/评论
        if platform_key == "tiktok":
            content = state["reply_text"].get(1.0, tk.END).strip()
            plan = self._parse_tiktok_action_plan(content)
            if not plan:
                messagebox.showwarning("提示", "TikTok 需要 3 行动作格式（Video_Like/Follow/Comment）。请先生成或粘贴正确格式。")
                return

            # 手动发送同样遵守：Video_Like=NO 只是不点赞视频；如果其它动作全 NO，才跳过。
            has_other_actions = any(
                [
                    plan.get("follow") is True,
                    bool(plan.get("comment")),
                ]
            )
            if plan.get("video_like") is False and not has_other_actions:
                log_queue.put("⏭️ [tiktok] 手动发送：全部动作=NO，跳到下一个视频...")
                self.send_command("monitor_next", platform="tiktok", reason="ai_no_interest")
                if state.get("action_label") is not None:
                    state["action_label"].config(
                        text=f"[动作: {self._tiktok_action_summary(plan)} | 跳转下一个]",
                        fg="#ffc107",
                    )
                state["status_label"].config(text="已发送跳过指令", fg="#28a745")
                return
            self._execute_tiktok_action_plan(plan)
            state["status_label"].config(text="已发送动作指令", fg="#28a745")
            return

        content = state["reply_text"].get(1.0, tk.END).strip()
        if not content:
            messagebox.showwarning("提示", "评论内容为空，请先生成或输入评论")
            return
            
        if content == "(AI 建议跳过此视频)":
            log_queue.put(f"⚠️ [{platform_key}] 提示: 当前为跳过状态，正在执行跳过指令...")
            self.send_command("monitor_next", platform=platform_key, reason="ai_skip")
            return
        
        if self.contains_chinese(content):
            state["status_label"].config(text="正在翻译...", fg="#ffc107")
            log_queue.put(
                f"[{platform_key}] 检测到中文，正在翻译成英文...")
            threading.Thread(
                target=self._translate_and_send,
                args=(content, platform_key),
                daemon=True
            ).start()
        else:
            self._send_comment_cmd(content, platform_key)

    def contains_chinese(self, text):
        return bool(re.search(r'[\u4e00-\u9fa5]', text))

    def _translate_and_send(self, text, platform_key):
        config_choice = self.platform_ai_config_choice.get(platform_key)
        if config_choice is None:
            config_choice = tk.StringVar(value="1")
            self.platform_ai_config_choice[platform_key] = config_choice
        config_num = config_choice.get() or "1"
        
        cfg = self._collect_ai_config(config_num)
        api_key = cfg["api_key"]
        base_url = cfg["base_url"]
        model = cfg["model"]
        
        if not api_key:
            log_queue.put(
                f"❌ [{platform_key}] 未配置 API Key，无法翻译，发送原文")
            self.root.after(
                0, lambda: self._send_comment_cmd(text, platform_key))
            return

        try:
            import openai
            client = openai.OpenAI(api_key=api_key, base_url=base_url)
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "You are a translator. Translate the following text to English. Only output the translation."},
                    {"role": "user", "content": text}
                ]
            )
            translated = response.choices[0].message.content.strip()
            self.root.after(0, lambda: self._update_ui_and_send(translated, platform_key))
        except Exception as e:
            log_queue.put(f"❌ [{platform_key}] 翻译失败: {e}")
            
            def set_error_status():
                state = self.platforms[platform_key]
                state["status_label"].config(text="翻译失败", fg="red")
            
            self.root.after(0, set_error_status)

    def _update_ui_and_send(self, text, platform_key):
        state = self.platforms[platform_key]
        state["reply_text"].delete(1.0, tk.END)
        state["reply_text"].insert(tk.END, text)
        self._send_comment_cmd(text, platform_key)
        state["status_label"].config(text="已翻译并发送", fg="#28a745")

    def _send_comment_cmd(self, content, platform_key):
        if platform_key == "tiktok":
            # TikTok 不发表评论（历史兼容：避免误触）
            self.send_command("like_top_comment", platform=platform_key)
        else:
            self.send_command("auto_comment", text=content, platform=platform_key)

    def send_test_comment(self, platform_key):
        """手动测试：下发 auto_comment，让插件侧验证点击/键入/发送链路。"""
        pk = str(platform_key or self.current_platform or "tiktok").lower()
        state = self.platforms.get(pk) or {}

        text = ""
        try:
            rt = state.get("reply_text")
            if rt is not None:
                text = str(rt.get("1.0", tk.END)).strip()
        except Exception:
            text = ""

        if not text:
            text = f"test {time.strftime('%H:%M:%S')}"

        if pk == "tiktok":
            text = self._sanitize_tiktok_comment_text(text)

        self.send_command("auto_comment", text=text, platform=pk)
        log_queue.put(f"🧪 [{pk}] 已下发测试评论指令(auto_comment)")

    def _sanitize_tiktok_comment_text(self, text: str) -> str:
        """把可能包含 YES/NO/多行/动作计划的文本，提取成可发送评论，并限长。"""
        raw = str(text or "").strip()
        if not raw:
            return ""

        # 优先提取 Comment: 行
        for ln in raw.splitlines():
            m = re.match(r'^\s*Comment\s*:\s*(.+)\s*$', ln, re.IGNORECASE)
            if m:
                v = (m.group(1) or "").strip()
                if v.startswith("[") and v.endswith("]") and len(v) >= 2:
                    v = v[1:-1].strip()
                raw = v
                break

        # 如果第一行是 YES/NO，去掉该行
        lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        if lines and re.match(r'^\[?\s*(YES|NO)\s*\]?\s*$', lines[0], re.IGNORECASE):
            raw = " ".join(lines[1:]).strip() or ""

        # 单行化 + 去掉前缀 YES/NO（防止出现 YESFrom...）
        raw = re.sub(r"\s+", " ", raw).strip()
        raw = re.sub(r'^\[?\s*(YES|NO)\s*\]?\s*', "", raw, flags=re.IGNORECASE).strip()

        if not raw or raw.strip().upper() == "NO":
            return ""

        # 限制长度（按 Python 字符计数）。
        # TikTok 对 emoji/组合字符的计数不稳定，保守一点：优先压到 120 内，确保不超 150。
        if len(raw) > 150:
            raw = raw[:150].rstrip()
        if len(raw) > 120:
            raw = raw[:120].rstrip()
        return raw

    def _bool_to_yesno(self, value):
        if value is True:
            return "YES"
        if value is False:
            return "NO"
        return "UNKNOWN"

    def _parse_yes_no_token(self, token: str):
        if token is None:
            return None
        t = str(token).strip().upper()
        t = t.strip('[](){}')
        if t == "YES":
            return True
        if t == "NO":
            return False
        return None

    def _parse_tiktok_action_plan(self, text: str):
        if not text:
            return None

        # 容错：有些模型会只返回 "NO" 或 "YES"。
        # 这里把它视为 Video_Like 的单项决策，其它动作默认 NO。
        raw_text = str(text).strip()
        m_single = re.match(
            r'^\[?\s*(YES|NO)\s*\]?\s*[\.!。！？]*\s*$',
            raw_text,
            re.IGNORECASE,
        )
        if m_single:
            v = self._parse_yes_no_token(m_single.group(1))
            return {
                "video_like": bool(v),
                "follow": False,
                "comment": None,
            }

        # 容错：第一行 YES/NO，后面直接给评论正文（不按 3 行格式）
        # 例如：
        # YES\n<comment text...>
        # 默认 Follow=NO；Comment=正文（仅当 Video_Like=YES）
        lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()]
        if lines:
            first = lines[0]
            m_first = re.match(r'^\[?\s*(YES|NO)\s*\]?\s*$', first, re.IGNORECASE)
            if m_first:
                v = self._parse_yes_no_token(m_first.group(1))
                comment_text = " ".join(lines[1:]).strip()
                if v is False:
                    comment_text = ""
                return {
                    "video_like": bool(v),
                    "follow": False,
                    "comment": comment_text or None,
                }

        plan = {}
        seen_comment_line = False

        for raw in str(text).splitlines():
            line = raw.strip()
            if not line:
                continue

            m_yesno = re.match(
                r'^(Video_Like|Follow)\s*:\s*\[?\s*(YES|NO)\s*\]?\s*$',
                line,
                re.IGNORECASE,
            )
            if m_yesno:
                key = m_yesno.group(1).strip().lower()
                val = self._parse_yes_no_token(m_yesno.group(2))
                if key == "video_like":
                    plan["video_like"] = val
                elif key == "follow":
                    plan["follow"] = val
                continue

            m_comment = re.match(r'^Comment\s*:\s*(.+)\s*$', line, re.IGNORECASE)
            if m_comment:
                seen_comment_line = True
                raw_val = (m_comment.group(1) or "").strip()
                # allow optional brackets: [ ... ]
                if raw_val.startswith("[") and raw_val.endswith("]") and len(raw_val) >= 2:
                    raw_val = raw_val[1:-1].strip()
                # normalize
                if not raw_val:
                    plan["comment"] = None
                elif raw_val.strip().upper() == "NO":
                    plan["comment"] = None
                else:
                    # keep as a single line
                    plan["comment"] = re.sub(r"\s+", " ", raw_val).strip()
                continue

        # require strict 3-line format
        if plan.get("video_like") is None or plan.get("follow") is None or not seen_comment_line:
            return None

        # enforce rule: Video_Like=NO => Comment must be NO
        if plan.get("video_like") is False:
            plan["comment"] = None

        if plan.get("comment"):
            plan["comment"] = self._sanitize_tiktok_comment_text(plan.get("comment")) or None

        return plan

    def _format_tiktok_action_plan(self, plan: dict) -> str:
        comment = plan.get("comment")
        if comment:
            comment_out = self._sanitize_tiktok_comment_text(comment) or "NO"
        else:
            comment_out = "NO"
        return (
            f"Video_Like: [{self._bool_to_yesno(plan.get('video_like'))}]\n"
            f"Follow: [{self._bool_to_yesno(plan.get('follow'))}]\n"
            f"Comment: [{comment_out}]"
        )

    def _execute_tiktok_action_plan(self, plan: dict):
        # TikTok 规则：Video_Like=NO 仅表示“不点赞视频”，仍允许点赞评论/关注。
        # 只有当所有动作都为 NO 时才跳过到下一个视频。
        has_any_action = any(
            [
                plan.get("video_like") is True,
                plan.get("follow") is True,
                bool(plan.get("comment")),
            ]
        )
        if not has_any_action:
            log_queue.put("⏭️ [tiktok] 执行：全部动作=NO，跳到下一个视频")
            self.send_command("monitor_next", platform="tiktok", reason="ai_no_interest")
            return

        # 受全局开关约束：auto_like 控制点赞（视频/评论），auto_subscribe 控制关注
        if plan.get("video_like") is True and self.auto_like_var.get():
            log_queue.put("👍 [tiktok] 执行：点赞视频")
            self.send_command("like_video", platform="tiktok")

        if plan.get("follow") is True and self.auto_subscribe_var.get():
            log_queue.put("➕ [tiktok] 执行：关注创作者")
            self.send_command("subscribe_channel", platform="tiktok")

        comment = self._sanitize_tiktok_comment_text(plan.get("comment") or "")
        if comment:
            log_queue.put(f"💬 [tiktok] 执行：自动评论: {comment}")
            self.send_command("auto_comment", platform="tiktok", text=comment)

        # 动作执行完：交给插件端监控播放进度（类似 YouTube 插件侧提示），播完再跳下一个。
        log_queue.put("⏭️ [tiktok] 动作已下发，发送监控跳转指令(播完后跳)")
        self.send_command(
            "monitor_next",
            platform="tiktok",
            reason="post_action",
        )

    def send_like_comment(self, platform_key: str, index: int):
        """测试/手动：点赞指定序号的评论，并尽量按客户端采集的评论内容匹配。"""
        pk = str(platform_key or "tiktok").lower()
        idx = int(index or 1)
        if idx < 1:
            idx = 1

        match_text = self._get_platform_comment_content(pk, idx)
        if match_text:
            log_queue.put(f"💬 [{pk}] 测试点赞评论#{idx} (按文本匹配)")
            self.send_command(
                "like_comment",
                platform=pk,
                index=idx,
                match_text=match_text,
            )
        else:
            log_queue.put(f"💬 [{pk}] 测试点赞评论#{idx} (无文本，按序号)")
            self.send_command("like_comment", platform=pk, index=idx)

        # TikTok：手动点赞后也交给插件端监控，播完后跳下一个
        if pk == "tiktok":
            self.send_command(
                "monitor_next",
                platform="tiktok",
                reason="manual_post_action",
            )

    def _get_platform_comment_content(self, platform_key: str, index: int) -> str:
        state = self.platforms.get(platform_key)
        if not state:
            return ""
        comments = state.get("comments_data") or []
        pos = int(index or 1) - 1
        if pos < 0 or pos >= len(comments):
            return ""
        try:
            return str(comments[pos].get("content", "") or "").strip()
        except Exception:
            return ""

    def _tiktok_action_summary(self, plan: dict) -> str:
        parts = []

        # 点赞视频
        if plan.get("video_like") is True:
            parts.append("点赞视频" if self.auto_like_var.get() else "点赞视频(已关)")
        else:
            parts.append("不点赞视频")

        # 关注
        if plan.get("follow") is True:
            parts.append("关注" if self.auto_subscribe_var.get() else "关注(已关)")
        else:
            parts.append("不关注")

        # 评论
        comment = (plan.get("comment") or "").strip()
        parts.append("评论" if comment else "不评论")

        return " | ".join(parts)


    def send_command(self, cmd_type, **kwargs):
        platform = kwargs.get('platform', self.current_platform)
        if 'platform' not in kwargs:
            kwargs['platform'] = platform
        
        # 附带当前视频URL，用于验证指令是否过期
        state = self.platforms.get(platform)
        if state and 'url_var' in state:
            current_url = state['url_var'].get()
            if current_url and 'target_url' not in kwargs:
                kwargs['target_url'] = current_url
        
        cmd = {"type": cmd_type}
        cmd.update(kwargs)
        
        # 调试日志：显示发送的指令
        cmd_name = COMMAND_NAMES_CN.get(cmd_type, cmd_type)
        target_url = kwargs.get('target_url', 'N/A')
        target_url_short = target_url[-30:] if target_url != 'N/A' else 'N/A'
        log_queue.put(
            f"📤 准备发送指令 [{platform.upper()}]: {cmd_name} "
            f"(目标: ...{target_url_short})")
        print(
            f"[调试] 发送指令: 类型={cmd_name}, "
            f"平台={platform}, 参数={kwargs}")
        
        self._push_command(cmd, platform)

    def _push_command(self, cmd, platform):
        # 根据当前活跃平台，将指令放入对应队列
        target_queue = command_queues.get(
            platform, command_queues['default'])
        target_queue.put(cmd)
        queue_size = target_queue.qsize()
        cmd_name = COMMAND_NAMES_CN.get(cmd['type'], cmd['type'])
        
        # 详细调试输出
        print("\n" + "="*50)
        print("[UI] ✅ 指令已加入队列")
        print(f"  - 平台: {platform.upper()}")
        print(f"  - 指令: {cmd_name}")
        print(f"  - 详情: {cmd}")
        print(f"  - 队列大小: {queue_size}")
        print(f"  - 队列对象: {id(target_queue)}")
        print("="*50 + "\n")
        
        log_queue.put(
            f"✅ 指令已加入队列 [{platform.upper()}]: "
            f"{cmd_name} (队列大小: {queue_size})")

    def on_auto_send_change(self, platform_key="youtube"):
        pk = str(platform_key or "youtube").lower()
        if pk not in ("youtube", "tiktok"):
            pk = "youtube"

        if self.auto_send_vars[pk].get():
            state = self.platforms.get(pk)
            if state and "status_label" in state:
                current_status = state["status_label"].cget("text")
                if "准备发送" in current_status:
                    log_queue.put(
                        f"ℹ️ [{pk}] 提示: 自动发送已开启 "
                        f"(当前已生成的内容请手动点击发送)"
                    )

    def test_plugin_link(self, platform_key):
        """连接测试：判断插件是否在轮询/是否在上报数据/测试指令是否能被服务端下发。"""
        conn = ensure_connection_state(platform_key)

        def fmt_age(ts):
            if not ts or float(ts) <= 0:
                return "从未"
            delta = max(0.0, time.time() - float(ts))
            if delta < 60:
                return f"{delta:.1f}s"
            return f"{delta / 60:.1f}m"

        def is_poll_alive(ts):
            try:
                return (time.time() - float(ts or 0)) <= 1.5
            except Exception:
                return False

        poll_age = fmt_age(conn.get('last_poll_ts'))
        post_age = fmt_age(conn.get('last_post_ts'))
        last_post_url = (conn.get('last_post_url') or '')
        last_post_url_short = last_post_url[-60:] if last_post_url else ''

        log_queue.put(
            f"🔌 [{platform_key.upper()}] 连接测试: "
            f"最近轮询={poll_age}, 最近上报={post_age}")

        # 发送一条“连接测试”指令，观察是否能被 /poll 成功下发
        cmd_id = uuid.uuid4().hex
        self.send_command(
            "link_test",
            platform=platform_key,
            reason="test",
            id=cmd_id,
        )

        def check_delivery():
            conn2 = ensure_connection_state(platform_key)
            delivered = (
                conn2.get('last_command_sent_id') == cmd_id and
                conn2.get('last_command_sent_type') == 'link_test'
            )

            lines = [
                f"平台: {platform_key.upper()}",
                f"最近插件轮询(/poll): {fmt_age(conn2.get('last_poll_ts'))}  (在线={is_poll_alive(conn2.get('last_poll_ts'))})",
                f"最近插件上报(/data): {fmt_age(conn2.get('last_post_ts'))}",
                (f"最近上报URL: ...{last_post_url_short}" if last_post_url_short else "最近上报URL: (无)"),
                f"本次测试指令: link_test / id={cmd_id}",
                f"服务端最近下发: {conn2.get('last_command_sent_type') or '(无)'} / id={conn2.get('last_command_sent_id') or '(无)'} / {fmt_age(conn2.get('last_command_sent_ts'))}",
                "结论: " + (
                    "✅ 服务端已通过 /poll 下发测试指令（插件应能看到收到指令日志）"
                    if delivered else
                    "❌ 测试指令尚未被服务端下发（常见原因：插件未在轮询 /poll 或轮询已崩溃/停止）"
                ),
            ]
            messagebox.showinfo("连接测试", "\n".join(lines))

        # 给轮询一点时间：YouTube 200ms / TikTok 1000ms，这里取 1100ms
        self.root.after(1100, check_delivery)

    def test_ai_connection(self, config_key="1"):
        # 测试时默认使用 YouTube 的提示词
        cfg = self._collect_ai_config(config_key, "youtube")
        api_key = cfg["api_key"]
        base_url = cfg["base_url"]
        model = cfg["model"]
        prompt_template = cfg["prompt_template"]
        
        if not api_key:
            messagebox.showwarning("提示", "请先填写 API Key")
            return
            
        self.ai_engine.update_config(api_key, base_url, model, prompt_template)
        
        def show_result(success, msg):
            result = "连接" + ("成功" if success else "失败")
            messagebox.showinfo("测试结果", f"{result}: {msg}")
        
        self.ai_engine.test_connection(
            lambda success, msg: self.root.after(
                0, lambda: show_result(success, msg)))

    def save_config_ui(self):
        cfg1 = self._collect_ai_config("1", "youtube")
        cfg2 = self._collect_ai_config("2", "tiktok")

        config = {
            "ai_config_1": {
                "api_key": cfg1["api_key"],
                "base_url": cfg1["base_url"],
                "model": cfg1["model"],
            },
            "ai_config_2": {
                "api_key": cfg2["api_key"],
                "base_url": cfg2["base_url"],
                "model": cfg2["model"],
            },
            "platform_prompts": {
                "youtube": self.platform_prompts["youtube"],
                "tiktok": self.platform_prompts["tiktok"],
            },
            "youtube_ai_choice": self.platform_ai_config_choice["youtube"].get(),
            "tiktok_ai_choice": self.platform_ai_config_choice["tiktok"].get(),

            # 兼容旧版本：保留顶层字段
            "api_key": cfg1["api_key"],
            "base_url": cfg1["base_url"],
            "model": cfg1["model"],
            "prompt_template": self.platform_prompts["youtube"],
        }
        if save_config(config):
            log_queue.put("✅ 配置已保存")
            tk.messagebox.showinfo("提示", "配置已保存")
        else:
            log_queue.put("❌ 保存配置失败")

    def load_config_to_ui(self):
        config = load_config()
        if config:
            # 加载两套配置（只包含API接口数据）
            cfg1 = config.get("ai_config_1") or get_platform_ai_config(config, "youtube")
            cfg2 = config.get("ai_config_2") or get_platform_ai_config(config, "tiktok")

            self.ai_api_key_vars["1"].set(cfg1.get("api_key", ""))
            self.ai_base_url_vars["1"].set(cfg1.get("base_url", DEFAULT_BASE_URL))
            self.ai_model_vars["1"].set(cfg1.get("model", "gpt-3.5-turbo"))

            self.ai_api_key_vars["2"].set(cfg2.get("api_key", ""))
            self.ai_base_url_vars["2"].set(cfg2.get("base_url", DEFAULT_BASE_URL))
            self.ai_model_vars["2"].set(cfg2.get("model", "gpt-3.5-turbo"))

            # 加载平台提示词
            platform_prompts_cfg = config.get("platform_prompts", {})
            self.platform_prompts["youtube"] = platform_prompts_cfg.get("youtube", cfg1.get("prompt_template", DEFAULT_PROMPT))
            self.platform_prompts["tiktok"] = platform_prompts_cfg.get("tiktok", cfg2.get("prompt_template", DEFAULT_TIKTOK_PROMPT))

            # 加载平台配置选择
            self.platform_ai_config_choice["youtube"].set(config.get("youtube_ai_choice", "1"))
            self.platform_ai_config_choice["tiktok"].set(config.get("tiktok_ai_choice", "2"))

            # 写入设置页文本框（若 UI 已创建）
            for platform_key in ("youtube", "tiktok"):
                w = self.prompt_text_widgets.get(platform_key)
                if w is None:
                    continue
                w.delete("1.0", tk.END)
                w.insert("1.0", self.platform_prompts[platform_key])

            log_queue.put("配置已加载")
