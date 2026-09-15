#!/usr/bin/python3
# Full-screen HDMI splash on the firmware framebuffer until the kiosk starts.
from __future__ import annotations

import os
import socket
import struct
import time
from pathlib import Path

LOGO_PATH = os.environ.get("DKGM_SPLASH_LOGO", "/usr/lib/dkgm/logo.png")
PROVISION_DONE = "/boot/firmware/dkgm-provision.done"
DRAWN_FLAG = os.environ.get("DKGM_SPLASH_FLAG", "/tmp/dkgm-hdmi.drawn")
FONT_CANDIDATES_BOLD = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)
FONT_CANDIDATES_REG = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)

BG = (15, 28, 23)
FG = (232, 240, 234)
MUTED = (155, 176, 163)
ACCENT = (212, 160, 23)

POLL_S = 2
READY_REFRESH_S = 15
FBDEV = "/dev/fb0"


def first_ipv4() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("1.1.1.1", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    return ""


def pick_font(candidates, size: int):
    from PIL import ImageFont

    for path in candidates:
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def fb_geometry():
    try:
        data = Path("/sys/class/graphics/fb0/virtual_size").read_text().strip()
        w_s, h_s = data.split(",")
        return int(w_s), int(h_s)
    except (OSError, ValueError):
        return None


def canvas_size():
    env = os.environ.get("DKGM_SPLASH_SIZE")
    if env and "x" in env:
        w_s, h_s = env.lower().split("x", 1)
        return int(w_s), int(h_s)
    geo = fb_geometry()
    if geo:
        return geo
    return 1920, 1080


def compose(w: int, h: int, done: bool, ip: str):
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(img)
    logo = None
    if Path(LOGO_PATH).is_file():
        try:
            logo = Image.open(LOGO_PATH).convert("RGBA")
        except OSError:
            logo = None
    max_w, max_h = int(w * 0.72), int(h * 0.28)
    if logo is not None:
        lw, lh = logo.size
        scale = min(max_w / lw, max_h / lh)
        logo = logo.resize((max(1, int(lw * scale)), max(1, int(lh * scale))))
        x = (w - logo.size[0]) // 2
        y = int(h * 0.22)
        img.paste(logo, (x, y), logo)
        text_y = y + logo.size[1] + int(h * 0.08)
    else:
        font = pick_font(FONT_CANDIDATES_BOLD, max(32, h // 10))
        bbox = draw.textbbox((0, 0), "DKGM", font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text(((w - tw) / 2, h * 0.28), "DKGM", fill=ACCENT, font=font)
        text_y = int(h * 0.28 + th + h * 0.08)

    body = pick_font(FONT_CANDIDATES_REG, max(18, h // 32))
    if not done:
        msg = "Bezig met instellen…"
    elif ip:
        msg = f"Portal  http://{ip}/"
    else:
        msg = "Ethernet aansluiten…"
    bbox = draw.textbbox((0, 0), msg, font=body)
    tw = bbox[2] - bbox[0]
    draw.text(((w - tw) / 2, text_y), msg, fill=FG, font=body)
    return img


def write_fb(img) -> bool:
    if not Path(FBDEV).exists():
        return False
    try:
        bits = int(Path("/sys/class/graphics/fb0/bits_per_pixel").read_text().strip())
    except (OSError, ValueError):
        bits = 32
    raw = img.convert("RGB")
    if bits == 16:
        px = raw.tobytes()
        out = bytearray()
        for i in range(0, len(px), 3):
            r, g, b = px[i], px[i + 1], px[i + 2]
            v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
            out.extend(struct.pack("<H", v))
        payload = bytes(out)
    else:
        payload = raw.convert("RGBA").tobytes()
    try:
        with open(FBDEV, "wb") as fb:
            fb.write(payload)
        return True
    except OSError:
        return False


def hide_cursor() -> None:
    for path in ("/dev/tty1", "/dev/console"):
        try:
            with open(path, "w", encoding="utf-8") as tty:
                tty.write("\033[?25l")
                tty.flush()
            return
        except OSError:
            continue


def show(img) -> None:
    out = os.environ.get("DKGM_SPLASH_OUT")
    if out:
        img.save(out)
        return
    if write_fb(img):
        try:
            flag_dir = os.path.dirname(DRAWN_FLAG)
            if flag_dir:
                os.makedirs(flag_dir, exist_ok=True)
            with open(DRAWN_FLAG, "w", encoding="ascii") as fh:
                fh.write("1\n")
        except OSError:
            pass
        return
    try:
        with open("/dev/console", "w", encoding="utf-8") as con:
            con.write("\033[2J\033[H")
            con.write("DKGM\n")
            con.flush()
    except OSError:
        pass


def main() -> int:
    hide_cursor()
    w, h = canvas_size()
    while True:
        ip = os.environ.get("DKGM_SPLASH_IP", first_ipv4())
        done_env = os.environ.get("DKGM_SPLASH_DONE")
        if done_env is not None:
            done = done_env in ("1", "true", "yes")
        else:
            done = os.path.isfile(PROVISION_DONE)
        show(compose(w, h, done, ip))
        if os.environ.get("DKGM_SPLASH_OUT"):
            return 0
        time.sleep(READY_REFRESH_S if (done and ip) else POLL_S)
        geo = fb_geometry()
        if geo:
            w, h = geo[0], geo[1]
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
