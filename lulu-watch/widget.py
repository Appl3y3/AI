# -*- coding: utf-8 -*-
"""
噜噜监控 —— 桌面小贴纸
显示：电源模式 / Caddy 入口 / 噜妹日记 / 噜妹影库 运行状态 / CPU / 内存
可点按钮在「挂机」「恢复」之间切换

用法：
    pythonw widget.py            启动挂件
    python  widget.py --preview  生成预览图（不开窗口）
"""
import os
import sys
import json
import time
import ctypes
import socket
import queue
import threading
import subprocess
import tkinter as tk

import psutil
from PIL import Image, ImageDraw, ImageFont, ImageTk

try:
    import pystray
    from pystray import Menu, MenuItem
    HAS_TRAY = True
except Exception:       # 托盘库缺失时挂件照常能用，只是没有右下角图标
    HAS_TRAY = False


# ==================== DPI ====================
def _enable_dpi_awareness():
    """按物理像素渲染，避免系统拉伸导致文字模糊"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def _system_scale():
    try:
        hdc = ctypes.windll.user32.GetDC(0)
        dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)   # LOGPIXELSX
        ctypes.windll.user32.ReleaseDC(0, hdc)
        return max(1.0, dpi / 96.0)
    except Exception:
        return 1.0


_enable_dpi_awareness()
SCALE = _system_scale()


# ==================== 外观常量（逻辑坐标，渲染时乘 SCALE）====================
TITLE = "噜噜监控"
W, H = 272, 328
RADIUS = 18
SS = 3                       # 圆角超采样倍数
KEY = "#ff00ff"              # 透明键色
KEY_RGB = (255, 0, 255)
PAD_EDGE = 40                # 距屏幕边缘留白（逻辑）

CLR = {
    "bg_top":   (21, 25, 35),
    "bg_bot":   (12, 15, 22),
    "border":   (58, 69, 92),
    "fg":       (233, 237, 245),
    "fg_dim":   (124, 135, 157),
    "fg_faint": (86, 96, 116),
    "ok":       (61, 220, 151),
    "bad":      (255, 92, 108),
    "warn":     (255, 178, 76),
    "accent":   (91, 140, 255),
    "track":    (34, 41, 55),
    "divider":  (32, 39, 52),
}

SCHEMES = {
    "22f98355-2f49-49ce-8a7f-c138149382ce": ("挂机", (91, 140, 255)),
    "381b4222-f694-41f0-9685-ff5bb260df2e": ("恢复", (61, 220, 151)),
    "e1d5e609-ee6d-4de7-af06-490791308617": ("守夜", (150, 122, 232)),
    "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c": ("高性能", (255, 160, 80)),
}
MODE_IDLE = "22f98355-2f49-49ce-8a7f-c138149382ce"
MODE_NORMAL = "381b4222-f694-41f0-9685-ff5bb260df2e"

SERVICES = [("噜妹日记", 8765), ("噜妹影库", 8977)]

# Caddy 是这两个服务共用的入口：8444 -> 日记、8445 -> 影库。
# 它挂了两个服务会同时失联，而本机两个端口还都通，所以单独一行。
CADDY_PORTS = [8444, 8445]
CADDY_NAME = "Caddy 反代"

CONF = os.path.join(os.environ.get("APPDATA", "."), "lulu-watch.json")
CONF_LEGACY = os.path.join(os.environ.get("APPDATA", "."), "lulu-widget.json")
NO_WINDOW = 0x08000000


# ==================== 字体 ====================
_FONT_CACHE = {}


def _font(size, bold=False, mono=False):
    size = max(8, int(round(size)))
    if mono:
        cands = ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/Cour.ttf"]
    elif bold:
        cands = ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyh.ttc",
                 "C:/Windows/Fonts/simhei.ttf"]
    else:
        cands = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
                 "C:/Windows/Fonts/simsun.ttc"]
    for c in cands:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    return ImageFont.load_default()


def fonts(k):
    key = round(k, 3)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    f = {
        "title":  _font(15 * k, bold=True),
        "badge":  _font(11 * k, bold=True),
        "name":   _font(13 * k, bold=True),
        "status": _font(11 * k, bold=True),
        "sub":    _font(10 * k),
        "label":  _font(11 * k),
        "value":  _font(12 * k, mono=True),
        "btn":    _font(12 * k, bold=True),
    }
    _FONT_CACHE[key] = f
    return f


# ==================== 工具 ====================
def _lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def _text_w(d, s, font):
    b = d.textbbox((0, 0), s, font=font)
    return b[2] - b[0]


def _tint(color, base, k=0.22):
    return tuple(int(c * k + b * (1 - k)) for c, b in zip(color, base))


def _bar_color(pct):
    if pct >= 88:
        return CLR["bad"]
    if pct >= 70:
        return CLR["warn"]
    return CLR["ok"]


def probe_port(port, timeout=0.35):
    t0 = time.perf_counter()
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True, (time.perf_counter() - t0) * 1000
    except Exception:
        return False, None


def probe_caddy(ports=None, timeout=0.35):
    """Caddy 一个进程挂多个站点，所以数「几个端口在听」而不是看单点。
    返回 (活着的端口列表, 最快一次握手耗时)。"""
    ports = ports or CADDY_PORTS
    live, best = [], None
    for p in ports:
        up, ms = probe_port(p, timeout)
        if up:
            live.append(p)
            if ms is not None and (best is None or ms < best):
                best = ms
    return live, best


def active_scheme():
    try:
        import winreg
        k = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes")
        val = winreg.QueryValueEx(k, "ActivePowerScheme")[0]
        winreg.CloseKey(k)
        return str(val).strip().lower()
    except Exception:
        return ""


# ==================== 托盘图标 ====================
def tray_image(svc=None, caddy=None):
    """64x64：深色圆角底 + 三条状态色条（上=Caddy，中=日记，下=影库），
    缩小到 16px 也能看清死活。Caddy 那条画得短一点、两端带缺口，
    一眼能和下面两条服务条区分开。"""
    S = 64
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, S - 3, S - 3], radius=14,
                        fill=(22, 27, 38, 255), outline=(80, 94, 122, 255), width=2)
    bars = []
    if caddy is not None:
        bars.append(bool(caddy))
    bars += [bool(s.get("up")) for s in (svc or [])][:2]
    # 不跑 Caddy 时（caddy=None）只画两条服务条，不要多出一条假的红条
    need = 3 if caddy is not None else 2
    while len(bars) < need:
        bars.append(False)
    for i, up in enumerate(bars):
        c = (61, 220, 151, 255) if up else (255, 92, 108, 255)
        y = 13 + i * 13
        x1, x2 = (18, 46) if i == 0 else (14, 50)
        d.rounded_rectangle([x1, y, x2, y + 8], radius=4, fill=c)
    return img


# ==================== 背景层（按 k 缓存）====================
_BG_CACHE = {}


def bg_layer(k):
    key = round(k, 3)
    if key in _BG_CACHE:
        return _BG_CACHE[key].copy()

    pw, ph = int(round(W * k)), int(round(H * k))
    ss = max(2, int(round(SS * k)))
    bw, bh = pw * ss, ph * ss
    rad = int(round(RADIUS * k)) * ss

    card = Image.new("RGB", (bw, bh), CLR["bg_bot"])
    d = ImageDraw.Draw(card)
    for y in range(bh):
        d.line([(0, y), (bw, y)], fill=_lerp(CLR["bg_top"], CLR["bg_bot"], y / bh))
    # 顶部玻璃高光
    hl = int(round(48 * k)) * ss
    for y in range(hl):
        t = 1 - y / hl
        d.line([(0, y), (bw, y)], fill=_lerp(CLR["bg_top"], (34, 41, 56), t * 0.5))
    d.rounded_rectangle([0, 0, bw - 1, bh - 1], radius=rad,
                        outline=CLR["border"], width=max(1, int(round(2 * k))) * ss)
    card = card.resize((pw, ph), Image.LANCZOS)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, bw - 1, bh - 1],
                                           radius=rad, fill=255)
    mask = mask.resize((pw, ph), Image.LANCZOS).point(
        lambda v: 255 if v > 128 else 0)

    base = Image.new("RGB", (pw, ph), KEY_RGB)
    base.paste(card, (0, 0), mask)
    _BG_CACHE[key] = base
    return base.copy()


# ==================== 绘制核心 ====================
def build_image(data, hover=None, k=None):
    """按物理像素渲染，返回 (PIL.Image, buttons)；buttons 用逻辑坐标"""
    if k is None:
        k = SCALE
    F = fonts(k)
    base = bg_layer(k)
    d = ImageDraw.Draw(base)

    def P(v):
        return int(round(v * k))

    pw = base.width
    px = lambda v: P(v)          # noqa: E731

    # ---------- 标题 ----------
    d.text((px(18), px(26)), TITLE, font=F["title"], fill=CLR["fg"],
           anchor="lm")

    scheme = (data.get("scheme") or "").lower()
    label, color = SCHEMES.get(scheme, ("未知", CLR["fg_dim"]))
    tw = _text_w(d, label, F["badge"])
    bx2 = pw - px(16)
    bx1 = bx2 - (tw + px(24))
    d.rounded_rectangle([bx1, px(15), bx2, px(37)], radius=P(11),
                        fill=_tint(color, CLR["bg_top"], 0.20))
    d.ellipse([bx1 + px(9), px(24), bx1 + px(15), px(30)], fill=color)
    d.text((bx1 + px(20), px(26)), label, font=F["badge"], fill=color,
           anchor="lm")

    lw = max(1, P(1))
    d.line([(px(18), px(48)), (pw - px(18), px(48))], fill=CLR["divider"], width=lw)

    # ---------- Caddy 入口（菱形点，和下面两个圆形服务点区分） ----------
    cad = data.get("caddy") or {}
    live = cad.get("live") or []
    cst = cad.get("state") or "down"
    ccol = {"ok": CLR["ok"], "warn": CLR["warn"]}.get(cst, CLR["bad"])
    cword = {"ok": "运行中", "warn": "部分", }.get(cst, "未运行")

    ccy, csy = 68, 86
    # 菱形：以 (24, ccy) 为中心，外圈淡色底 + 内圈实色
    def diamond(cx, cy, r, fill):
        d.polygon([(px(cx), px(cy - r)), (px(cx + r), px(cy)),
                   (px(cx), px(cy + r)), (px(cx - r), px(cy))], fill=fill)
    diamond(24, ccy, 7.5, _tint(ccol, CLR["bg_top"], 0.22))
    diamond(24, ccy, 4.6, ccol)
    d.text((px(38), px(ccy)), CADDY_NAME, font=F["name"], fill=CLR["fg"],
           anchor="lm")
    d.text((pw - px(18), px(ccy)), cword, font=F["status"], fill=ccol,
           anchor="rm")
    if live:
        sub = " · ".join(str(p) for p in live)
        if cad.get("ms") is not None:
            sub += f"    {cad['ms']:.1f}ms"
    else:
        sub = " / ".join(str(p) for p in CADDY_PORTS) + " 都没在听" if CADDY_PORTS else "没配端口"
    d.text((px(38), px(csy)), sub, font=F["sub"], fill=CLR["fg_faint"],
           anchor="lm")

    # 入口与后端之间用更淡的分隔，暗示「这两条服务挂在它后面」
    d.line([(px(24), px(100)), (pw - px(18), px(100))],
           fill=CLR["divider"], width=lw)

    # ---------- 服务状态 ----------
    rows = [(116, 134), (156, 174)]
    for i, s in enumerate(data.get("svc", [])[:2]):
        cy, sy = rows[i]
        up = s.get("up")
        dotc = CLR["ok"] if up else CLR["bad"]
        d.ellipse([px(18), px(cy - 6), px(30), px(cy + 6)],
                  fill=_tint(dotc, CLR["bg_top"], 0.22))
        d.ellipse([px(22), px(cy - 4), px(30), px(cy + 4)], fill=dotc)
        d.text((px(38), px(cy)), s["name"], font=F["name"], fill=CLR["fg"],
               anchor="lm")
        d.text((pw - px(18), px(cy)), "运行中" if up else "未响应",
               font=F["status"], fill=dotc, anchor="rm")
        sub = f"127.0.0.1:{s['port']}"
        if up and s.get("ms") is not None:
            sub += f"    {s['ms']:.1f}ms"
        d.text((px(38), px(sy)), sub, font=F["sub"], fill=CLR["fg_faint"],
               anchor="lm")

    d.line([(px(18), px(192)), (pw - px(18), px(192))],
           fill=CLR["divider"], width=lw)

    # ---------- CPU / 内存 ----------
    def gauge(y_label, y_bar, name, pct, detail=""):
        d.text((px(18), px(y_label)), name, font=F["label"],
               fill=CLR["fg_dim"], anchor="lm")
        d.text((pw - px(18), px(y_label)), f"{pct:.0f}%", font=F["value"],
               fill=_bar_color(pct), anchor="rm")
        if detail:
            d.text((pw - px(54), px(y_label)), detail, font=F["sub"],
                   fill=CLR["fg_faint"], anchor="rm")
        x1, x2 = px(18), pw - px(18)
        bh = max(3, P(7))
        d.rounded_rectangle([x1, px(y_bar), x2, px(y_bar) + bh],
                            radius=bh / 2, fill=CLR["track"])
        fw = (x2 - x1) * min(pct, 100) / 100.0
        if fw > 1:
            d.rounded_rectangle([x1, px(y_bar), x1 + max(fw, bh),
                                 px(y_bar) + bh], radius=bh / 2,
                                fill=_bar_color(pct))

    try:
        _cf = psutil.cpu_freq()
        cpu_hint = f"{_cf.current / 1000:.1f}GHz" if _cf and _cf.current else ""
    except Exception:
        cpu_hint = ""
    gauge(206, 216, "CPU", float(data.get("cpu") or 0), cpu_hint)
    used = data.get("mem_used") or 0
    total = data.get("mem_total") or 0
    gauge(236, 246, "内存", float(data.get("mem") or 0),
          f"{used:.0f}/{total:.0f}G" if total else "")

    # ---------- 按钮 ----------
    buttons = {}
    bw = (W - 36 - 10) // 2
    by1, by2 = 272, 310
    specs = [(18, "挂机", MODE_IDLE, CLR["accent"]),
             (18 + bw + 10, "恢复", MODE_NORMAL, CLR["ok"])]
    for bx, text, guid, color in specs:
        active = (scheme == guid)
        if active:
            d.rounded_rectangle([px(bx), px(by1), px(bx + bw), px(by2)],
                                radius=P(11),
                                fill=tuple(int(c * 0.82) for c in color))
            tc = (9, 12, 18)
        elif hover == guid:
            d.rounded_rectangle([px(bx), px(by1), px(bx + bw), px(by2)],
                                radius=P(11), fill=(52, 62, 82),
                                outline=color, width=max(1, P(1)))
            tc = CLR["fg"]
        else:
            d.rounded_rectangle([px(bx), px(by1), px(bx + bw), px(by2)],
                                radius=P(11), fill=CLR["track"],
                                outline=CLR["border"], width=max(1, P(1)))
            tc = CLR["fg_dim"]
        d.text((px(bx + bw / 2), px((by1 + by2) / 2)), text, font=F["btn"],
               fill=tc, anchor="mm")
        buttons[guid] = (bx, by1, bx + bw, by2)

    return base, buttons


# ==================== 采集线程 ====================
class Sampler(threading.Thread):
    def __init__(self, out_queue):
        super().__init__(daemon=True)
        self.q = out_queue
        self.stop_flag = False

    def run(self):
        psutil.cpu_percent(interval=None)
        while not self.stop_flag:
            try:
                vm = psutil.virtual_memory()
                svc = []
                for name, port in SERVICES:
                    up, ms = probe_port(port)
                    svc.append({"name": name, "port": port, "up": up, "ms": ms})
                live, cms = probe_caddy()
                caddy = {
                    "live": live,
                    "ms": cms,
                    "state": ("ok" if len(live) == len(CADDY_PORTS)
                              else "warn" if live else "down"),
                }
                self.q.put({
                    "cpu": psutil.cpu_percent(interval=None),
                    "mem": vm.percent,
                    "mem_used": vm.used / (1024 ** 3),
                    "mem_total": vm.total / (1024 ** 3),
                    "svc": svc,
                    "caddy": caddy,
                    "scheme": active_scheme(),
                })
            except Exception:
                pass
            for _ in range(12):
                if self.stop_flag:
                    break
                time.sleep(0.1)


# ==================== 窗口 ====================
class Widget:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title(TITLE)
        self.root.overrideredirect(True)

        # 默认不置顶：置顶会一直挡在其他窗口前面，碍事。
        # 需要时可右键菜单勾选「始终置顶」，状态存进配置。
        self.conf = self._load_conf()
        self.topmost = bool(self.conf.get("topmost", False))
        self.root.attributes("-topmost", self.topmost)

        self.root.configure(bg=KEY)
        try:
            self.root.attributes("-transparentcolor", KEY)
        except Exception:
            pass

        self.pw = int(round(W * SCALE))
        self.ph = int(round(H * SCALE))

        self.canvas = tk.Canvas(self.root, width=self.pw, height=self.ph,
                                bg=KEY, highlightthickness=0, bd=0)
        self.canvas.pack()
        self._img_item = self.canvas.create_image(0, 0, anchor="nw")
        self._photo = None

        self.data = {
            "cpu": 0.0, "mem": 0.0, "mem_used": 0, "mem_total": 0,
            "svc": [{"name": n, "port": p, "up": False, "ms": None}
                    for n, p in SERVICES],
            "caddy": {"live": [], "ms": None, "state": "down"},
            "scheme": active_scheme(),
        }
        self.buttons = {}
        self._drag = None
        self._moved = False
        self._hover = None
        self.top_var = tk.BooleanVar(value=self.topmost)
        self.tray = None
        self._vis = True
        self._tray_sig = None

        self.queue = queue.Queue()
        self.cmdq = queue.Queue()       # 托盘线程 -> 主线程的动作队列
        self.sampler = Sampler(self.queue)
        self.sampler.start()

        self._load_pos()
        self._bind()
        self._draw()
        self.root.after(150, self._poll)
        self.root.after(300, self._enforce_top)
        self.root.after(500, self._start_tray)

    # ---------- 配置 / 位置 ----------
    def _load_conf(self):
        # 改名前的配置（lulu-widget.json）照样认，位置和置顶不用重新设一遍
        for path in (CONF, CONF_LEGACY):
            try:
                if os.path.exists(path):
                    with open(path, "r", encoding="utf-8") as f:
                        return json.load(f) or {}
            except Exception:
                pass
        return {}

    def _save_conf(self):
        try:
            self.conf["x"] = self.root.winfo_x()
            self.conf["y"] = self.root.winfo_y()
            self.conf["topmost"] = self.topmost
            with open(CONF, "w", encoding="utf-8") as f:
                json.dump(self.conf, f)
        except Exception:
            pass

    def _load_pos(self):
        x, y = self.conf.get("x"), self.conf.get("y")
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        pad = int(round(PAD_EDGE * SCALE))
        if x is None:
            x, y = sw - self.pw - pad, sh - self.ph - pad * 2
        x = max(0, min(x, sw - self.pw))
        y = max(0, min(y, sh - self.ph))
        self.root.geometry(f"{self.pw}x{self.ph}+{x}+{y}")

    # ---------- 事件 ----------
    def _bind(self):
        c = self.canvas
        c.bind("<Button-1>", self._on_press)
        c.bind("<B1-Motion>", self._on_drag)
        c.bind("<ButtonRelease-1>", self._on_release)
        c.bind("<Button-3>", self._on_menu)
        c.bind("<Motion>", self._on_motion)
        c.bind("<Leave>", self._on_leave)

    def _hit(self, e):
        lx, ly = e.x / SCALE, e.y / SCALE
        for guid, (x1, y1, x2, y2) in self.buttons.items():
            if x1 <= lx <= x2 and y1 <= ly <= y2:
                return guid
        return None

    def _on_motion(self, e):
        hv = self._hit(e)
        if hv != self._hover:
            self._hover = hv
            self._draw()

    def _on_leave(self, e):
        if self._hover is not None:
            self._hover = None
            self._draw()

    def _on_press(self, e):
        self._drag = (e.x_root - self.root.winfo_x(),
                      e.y_root - self.root.winfo_y())
        self._moved = False

    def _on_drag(self, e):
        if not self._drag:
            return
        nx, ny = e.x_root - self._drag[0], e.y_root - self._drag[1]
        if abs(nx - self.root.winfo_x()) > 2 or abs(ny - self.root.winfo_y()) > 2:
            self._moved = True
        self.root.geometry(f"+{nx}+{ny}")

    def _on_release(self, e):
        if self._moved:
            self._save_conf()
            return
        guid = self._hit(e)
        if guid:
            self._switch(guid)

    def _on_menu(self, e):
        m = tk.Menu(self.root, tearoff=0)
        m.add_checkbutton(label="始终置顶", variable=self.top_var,
                          command=self._toggle_top)
        m.add_command(label="立即刷新", command=self._refresh)
        m.add_command(label="居中显示", command=self._center)
        m.add_command(label="隐藏到托盘", command=self._toggle_vis)
        m.add_separator()
        m.add_command(label="退出挂件", command=self.quit)
        try:
            m.tk_popup(e.x_root, e.y_root)
        finally:
            m.grab_release()

    def _center(self):
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.geometry(f"+{(sw - self.pw) // 2}+{(sh - self.ph) // 2}")
        self._save_conf()

    def _refresh(self):
        self.data["scheme"] = active_scheme()
        self._draw()

    def _switch(self, guid):
        # 先乐观更新界面，再后台执行，避免点击后卡住
        self.data["scheme"] = guid
        self._draw()

        def work():
            try:
                subprocess.run(["powercfg", "/setactive", guid],
                               creationflags=NO_WINDOW, timeout=8,
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
            except Exception:
                pass
            time.sleep(0.2)
            try:
                self.root.after(0, self._refresh)
            except Exception:
                pass

        threading.Thread(target=work, daemon=True).start()

    # ---------- 主循环 ----------
    def _poll(self):
        got = False
        while True:
            try:
                self.data = self.queue.get_nowait()
                got = True
            except queue.Empty:
                break
        while True:                      # 托盘线程投递的动作，在主线程执行
            try:
                fn = self.cmdq.get_nowait()
            except queue.Empty:
                break
            try:
                fn()
            except Exception:
                pass
        if got:
            self._draw()
            self._sync_tray()
        try:
            self.root.after(150, self._poll)
        except Exception:
            pass

    # ---------- 层级 ----------
    def _hwnd(self):
        hwnd = self.root.winfo_id()
        parent = ctypes.windll.user32.GetParent(hwnd)
        return ctypes.c_void_p(parent or hwnd)

    def _enforce_top(self):
        """仅在「始终置顶」开启时才声明置顶：其他程序的置顶窗会压过 tk 的
        -topmost 属性，所以隔一段时间用系统级调用重申一次。关闭时什么都不做。"""
        if self.topmost:
            try:
                ctypes.windll.user32.SetWindowPos(
                    self._hwnd(), ctypes.c_void_p(-1), 0, 0, 0, 0,
                    0x0001 | 0x0002 | 0x0010)
            except Exception:
                pass
        self.root.after(2500, self._enforce_top)

    def _toggle_top(self):
        self.topmost = bool(self.top_var.get())
        try:
            self.root.attributes("-topmost", self.topmost)
        except Exception:
            pass
        if self.topmost:
            self._bring_front()
        self._save_conf()

    def _bring_front(self):
        """把窗口抬到最前一次。非置顶状态下先临时上顶再退出置顶层，
        这样它会盖住当前所有普通窗口，但之后仍会被新窗口正常覆盖。"""
        try:
            u = ctypes.windll.user32
            h = self._hwnd()
            u.SetWindowPos(h, ctypes.c_void_p(-1), 0, 0, 0, 0,
                           0x0001 | 0x0002 | 0x0010)
            if not self.topmost:
                u.SetWindowPos(h, ctypes.c_void_p(-2), 0, 0, 0, 0,
                               0x0001 | 0x0002 | 0x0010)
            u.SetForegroundWindow(h)
        except Exception:
            pass

    # ---------- 托盘 ----------
    def _post(self, fn):
        """托盘回调跑在 pystray 线程，tk 不是线程安全的，
        所以只把动作塞进队列，交给主线程的 _poll 执行"""
        try:
            self.cmdq.put(fn)
        except Exception:
            pass

    def _start_tray(self):
        """右下角托盘图标：无边框窗口不在任务栏显示，靠它唤出/隐藏/退出"""
        if not HAS_TRAY:
            return
        try:
            menu = Menu(
                MenuItem(lambda item: "隐藏挂件" if self._vis else "显示挂件",
                         self._on_tray_vis, default=True),
                MenuItem(lambda item: self._caddy_line(), None, enabled=False),
                MenuItem(lambda item: self._svc_line(0), None, enabled=False),
                MenuItem(lambda item: self._svc_line(1), None, enabled=False),
                Menu.SEPARATOR,
                MenuItem("始终置顶", self._on_tray_top,
                         checked=lambda item: self.topmost),
                MenuItem("切换到 挂机", lambda icon, item: self._post(
                    lambda: self._switch(MODE_IDLE))),
                MenuItem("切换到 恢复", lambda icon, item: self._post(
                    lambda: self._switch(MODE_NORMAL))),
                Menu.SEPARATOR,
                MenuItem("退出", lambda icon, item: self._post(self.quit)),
            )
            self.tray = pystray.Icon("lulu-watch",
                                     tray_image(self.data.get("svc"),
                                                self._caddy_up()),
                                     TITLE, menu)
            self.tray.run_detached()
        except Exception:
            self.tray = None
            try:
                import traceback
                with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       "tray-error.log"), "w", encoding="utf-8") as f:
                    f.write(traceback.format_exc())
            except Exception:
                pass

    def _caddy_up(self):
        """托盘图标只要一个真假值：Caddy 两个站点都在才算活着"""
        cad = self.data.get("caddy") or {}
        return (cad.get("state") == "ok") if cad else None

    def _caddy_line(self):
        cad = self.data.get("caddy") or {}
        if not cad:
            return "%s  —" % CADDY_NAME
        st = cad.get("state")
        word = {"ok": "运行中", "warn": "部分", }.get(st, "未运行")
        live = cad.get("live") or []
        return "%s  %s（%s）" % (CADDY_NAME, word,
                                "·".join(str(p) for p in live) or "无端口")

    def _svc_line(self, i):
        svc = self.data.get("svc") or []
        if i < len(svc):
            s = svc[i]
            return "%s  %s" % (s["name"], "运行中" if s.get("up") else "未响应")
        return "—"

    def _on_tray_vis(self, icon=None, item=None):
        self._post(self._toggle_vis)

    def _on_tray_top(self, icon=None, item=None):
        self._post(self._toggle_top_from_tray)

    def _toggle_top_from_tray(self):
        self.top_var.set(not self.topmost)
        self._toggle_top()

    def _toggle_vis(self):
        if self._vis:
            self.root.withdraw()
            self._vis = False
        else:
            self.root.deiconify()
            self._vis = True
            self._bring_front()

    def _sync_tray(self):
        """状态一变就把托盘图标的色条换颜色：上=Caddy，中=日记，下=影库"""
        if not self.tray:
            return
        sig = (self._caddy_up(),
               tuple(bool(s.get("up")) for s in (self.data.get("svc") or [])))
        if sig == self._tray_sig:
            return
        self._tray_sig = sig
        try:
            self.tray.icon = tray_image(self.data.get("svc"), self._caddy_up())
        except Exception:
            pass

    def _draw(self):
        img, buttons = build_image(self.data, self._hover)
        self.buttons = buttons
        if (img.width, img.height) != (self.pw, self.ph):
            img = img.resize((self.pw, self.ph), Image.LANCZOS)
        self._photo = ImageTk.PhotoImage(img)
        self.canvas.itemconfig(self._img_item, image=self._photo)

    def quit(self):
        self.sampler.stop_flag = True
        if self.tray:
            try:
                self.tray.stop()
            except Exception:
                pass
            self.tray = None
        try:
            self.root.destroy()
        except Exception:
            pass

    def run(self):
        self.root.mainloop()


# ==================== 预览 ====================
def preview(k=2.0):
    scheme = active_scheme()
    svc = []
    for name, port in SERVICES:
        up, ms = probe_port(port)
        svc.append({"name": name, "port": port, "up": up, "ms": ms})
    live, cms = probe_caddy()
    caddy = {
        "live": live,
        "ms": cms,
        "state": ("ok" if len(live) == len(CADDY_PORTS)
                  else "warn" if live else "down"),
    }
    vm = psutil.virtual_memory()
    data = {
        "cpu": psutil.cpu_percent(interval=0.3),
        "mem": vm.percent,
        "mem_used": vm.used / (1024 ** 3),
        "mem_total": vm.total / (1024 ** 3),
        "svc": svc,
        "caddy": caddy,
        "scheme": scheme,
    }

    def compose(dat, bg_top, bg_bot, out_name):
        img, _ = build_image(dat, k=k)
        pad = 30
        cw, ch = img.width + pad * 2, img.height + pad * 2
        canvas = Image.new("RGB", (cw, ch), bg_top)
        dc = ImageDraw.Draw(canvas)
        for y in range(ch):
            dc.line([(0, y), (cw, y)], fill=_lerp(bg_top, bg_bot, y / ch))
        ip, cp = img.load(), canvas.load()
        for y in range(img.height):
            for x in range(img.width):
                c = ip[x, y]
                if c != KEY_RGB:
                    cp[x + pad, y + pad] = c
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), out_name)
        canvas.save(out)
        return out

    o1 = compose(data, (238, 240, 245), (216, 221, 231), "preview.png")
    d2 = dict(data)
    d2["scheme"] = MODE_NORMAL if scheme == MODE_IDLE else MODE_IDLE
    o2 = compose(d2, (34, 36, 43), (18, 19, 23), "preview_dark.png")
    print("saved:", o1)
    print("saved:", o2)
    print("SCALE:", SCALE, " render k:", k)


if __name__ == "__main__":
    if "--preview" in sys.argv:
        preview()
    else:
        try:
            Widget().run()
        except Exception:
            import traceback
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "error.log"), "w", encoding="utf-8") as f:
                f.write(traceback.format_exc())
            raise
