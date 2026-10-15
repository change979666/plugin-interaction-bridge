import ctypes
import time
from ctypes import wintypes


# Python 3.13 某些发行版里 wintypes 可能没有 ULONG_PTR。
# 这里自定义一个“指针宽度”的无符号整数类型用于 dwExtraInfo。
if hasattr(wintypes, 'ULONG_PTR'):
    ULONG_PTR = wintypes.ULONG_PTR
else:
    ULONG_PTR = (
        ctypes.c_ulonglong
        if ctypes.sizeof(ctypes.c_void_p) == 8
        else ctypes.c_ulong
    )

user32 = ctypes.WinDLL('user32', use_last_error=True)


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("mi", MOUSEINPUT),
        ("ki", KEYBDINPUT),
        ("hi", HARDWAREINPUT),
    ]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("union", INPUT_UNION)]


INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

VK_RETURN = 0x0D


def _send_input(*inputs: INPUT) -> int:
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    cb = ctypes.sizeof(INPUT)
    sent = user32.SendInput(n, arr, cb)
    if sent != n:
        raise ctypes.WinError(ctypes.get_last_error())
    return sent


def native_left_click(x: int, y: int, press_ms: int = 40) -> None:
    """Move cursor to (x,y) and perform a left click using SendInput."""
    if not isinstance(x, int) or not isinstance(y, int):
        raise ValueError("x/y must be int")

    if user32.SetCursorPos(x, y) == 0:
        raise ctypes.WinError(ctypes.get_last_error())

    down = INPUT(
        type=INPUT_MOUSE,
        union=INPUT_UNION(
            mi=MOUSEINPUT(0, 0, 0, MOUSEEVENTF_LEFTDOWN, 0, 0),
        ),
    )
    up = INPUT(
        type=INPUT_MOUSE,
        union=INPUT_UNION(
            mi=MOUSEINPUT(0, 0, 0, MOUSEEVENTF_LEFTUP, 0, 0),
        ),
    )

    _send_input(down)
    time.sleep(max(0.0, press_ms) / 1000.0)
    _send_input(up)


def native_left_click_n(
    x: int,
    y: int,
    *,
    count: int = 1,
    press_ms: int = 25,
    interval_ms: int = 55,
) -> None:
    """Move cursor to (x,y) then perform N left clicks."""
    if not isinstance(x, int) or not isinstance(y, int):
        raise ValueError("x/y must be int")
    count_i = int(count)
    if count_i <= 0:
        return

    if user32.SetCursorPos(x, y) == 0:
        raise ctypes.WinError(ctypes.get_last_error())

    down = INPUT(
        type=INPUT_MOUSE,
        union=INPUT_UNION(
            mi=MOUSEINPUT(0, 0, 0, MOUSEEVENTF_LEFTDOWN, 0, 0),
        ),
    )
    up = INPUT(
        type=INPUT_MOUSE,
        union=INPUT_UNION(
            mi=MOUSEINPUT(0, 0, 0, MOUSEEVENTF_LEFTUP, 0, 0),
        ),
    )

    press_s = max(0.0, float(press_ms)) / 1000.0
    interval_s = max(0.0, float(interval_ms)) / 1000.0

    for i in range(count_i):
        _send_input(down)
        time.sleep(press_s)
        _send_input(up)
        # click 与 click 之间留一点间隔，保证被系统识别为双击
        if i < count_i - 1:
            time.sleep(interval_s)


def get_cursor_pos() -> tuple[int, int]:
    pt = POINT()
    if user32.GetCursorPos(ctypes.byref(pt)) == 0:
        raise ctypes.WinError(ctypes.get_last_error())
    return int(pt.x), int(pt.y)


def native_key_press(
    vk: int,
    *,
    count: int = 1,
    press_ms: int = 18,
    interval_ms: int = 35,
) -> None:
    """Press a virtual key (vk) N times using SendInput."""
    vk_i = int(vk)
    if vk_i <= 0:
        raise ValueError("vk must be > 0")

    count_i = int(count)
    if count_i <= 0:
        return

    press_s = max(0.0, float(press_ms)) / 1000.0
    interval_s = max(0.0, float(interval_ms)) / 1000.0

    down = INPUT(
        type=INPUT_KEYBOARD,
        union=INPUT_UNION(
            ki=KEYBDINPUT(wVk=vk_i, wScan=0, dwFlags=0, time=0, dwExtraInfo=0),
        ),
    )
    up = INPUT(
        type=INPUT_KEYBOARD,
        union=INPUT_UNION(
            ki=KEYBDINPUT(
                wVk=vk_i,
                wScan=0,
                dwFlags=KEYEVENTF_KEYUP,
                time=0,
                dwExtraInfo=0,
            ),
        ),
    )

    for i in range(count_i):
        _send_input(down)
        time.sleep(press_s)
        _send_input(up)
        if i < count_i - 1:
            time.sleep(interval_s)


def native_type_text(text: str, *, interval_ms: int = 0) -> None:
    """Type text into the active window using KEYEVENTF_UNICODE."""
    if text is None:
        return
    s = str(text)
    if not s:
        return

    interval_s = max(0.0, float(interval_ms)) / 1000.0

    for ch in s:
        code = ord(ch)
        # KEYEVENTF_UNICODE uses wScan as the Unicode code point;
        # wVk must be 0.
        down = INPUT(
            type=INPUT_KEYBOARD,
            union=INPUT_UNION(
                ki=KEYBDINPUT(
                    wVk=0,
                    wScan=code,
                    dwFlags=KEYEVENTF_UNICODE,
                    time=0,
                    dwExtraInfo=0,
                ),
            ),
        )
        up = INPUT(
            type=INPUT_KEYBOARD,
            union=INPUT_UNION(
                ki=KEYBDINPUT(
                    wVk=0,
                    wScan=code,
                    dwFlags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time=0,
                    dwExtraInfo=0,
                ),
            ),
        )
        _send_input(down)
        _send_input(up)
        if interval_s > 0:
            time.sleep(interval_s)


def native_press_enter(
    *,
    count: int = 1,
    press_ms: int = 18,
    interval_ms: int = 35,
) -> None:
    native_key_press(
        VK_RETURN,
        count=count,
        press_ms=press_ms,
        interval_ms=interval_ms,
    )
