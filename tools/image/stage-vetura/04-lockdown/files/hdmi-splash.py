#!/usr/bin/python3
# Full-screen HDMI splash on the firmware framebuffer until the kiosk starts.
from __future__ import annotations

import math
import os
import socket
import struct
import time
from pathlib import Path

LOGO_PATH = os.environ.get("VETURA_SPLASH_LOGO", "/usr/lib/vetura/logo.png")
PROVISION_DONE = "/boot/firmware/vetura-provision.done"
DRAWN_FLAG = os.environ.get("VETURA_SPLASH_FLAG", "/tmp/vetura-hdmi.drawn")
FONT_CANDIDATES_BOLD = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)
FONT_CANDIDATES_REG = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)

BG = (255, 255, 255)
FG = (15, 92, 74)
ACCENT = (15, 92, 74)

POLL_S = 2
FADE_PERIOD_S = 4.8
FADE_MIN = 0.82
FRAME_S = 0.05
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
    env = os.environ.get("VETURA_SPLASH_SIZE")
    if env and "x" in env:
        w_s, h_s = env.lower().split("x", 1)
        return int(w_s), int(h_s)
    geo = fb_geometry()
    if geo:
        return geo
    return 1920, 1080


def _black_to_transparent(logo):
    pixels = []
    for r, g, b, a in logo.getdata():
        if r < 28 and g < 28 and b < 28:
            pixels.append((r, g, b, 0))
        else:
            pixels.append((r, g, b, a))
    logo.putdata(pixels)
    return logo


def _load_logo(max_w: int, max_h: int):
    from PIL import Image

    if not Path(LOGO_PATH).is_file():
        return None
    try:
        logo = Image.open(LOGO_PATH).convert("RGBA")
    except OSError:
        return None
    logo = _black_to_transparent(logo)
    lw, lh = logo.size
    scale = min(max_w / lw, max_h / lh)
    return logo.resize((max(1, int(lw * scale)), max(1, int(lh * scale))))


def compose_layers(w: int, h: int, done: bool, ip: str):
    from PIL import Image, ImageDraw

    base = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(base)
    max_w, max_h = int(w * 0.72), int(h * 0.28)
    logo = _load_logo(max_w, max_h)
    if logo is not None:
        x = (w - logo.size[0]) // 2
        y = int(h * 0.22)
        text_y = y + logo.size[1] + int(h * 0.08)
        logo_xy = (x, y)
    else:
        font = pick_font(FONT_CANDIDATES_BOLD, max(32, h // 10))
        bbox = draw.textbbox((0, 0), "Vetura", font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x = int((w - tw) / 2)
        y = int(h * 0.28)
        word = Image.new("RGBA", (max(1, tw + 4), max(1, th + 4)), (0, 0, 0, 0))
        ImageDraw.Draw(word).text((0, 0), "Vetura", fill=(*ACCENT, 255), font=font)
        logo = word
        logo_xy = (x, y)
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
    return base, logo, logo_xy


def fade_opacity(elapsed: float) -> float:
    wave = 0.5 + 0.5 * math.cos(2 * math.pi * elapsed / FADE_PERIOD_S)
    return FADE_MIN + (1.0 - FADE_MIN) * wave


def apply_logo(base, logo, xy, opacity: float):
    img = base.copy()
    if logo is None:
        return img
    opacity = max(0.0, min(1.0, opacity))
    faded = logo.copy()
    alpha = faded.getchannel("A").point(lambda p, o=opacity: int(p * o))
    faded.putalpha(alpha)
    img.paste(faded, xy, faded)
    return img


def pack_fb(img, bits: int) -> bytes:
    raw = img.convert("RGB")
    if bits == 16:
        px = raw.tobytes()
        out = bytearray()
        pack = struct.pack
        for i in range(0, len(px), 3):
            r, g, b = px[i], px[i + 1], px[i + 2]
            v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
            out.extend(pack("<H", v))
        return bytes(out)
    return raw.convert("RGBA").tobytes()


def write_fb(img) -> bool:
    if not Path(FBDEV).exists():
        return False
    try:
        bits = int(Path("/sys/class/graphics/fb0/bits_per_pixel").read_text().strip())
    except (OSError, ValueError):
        bits = 32
    payload = pack_fb(img, bits)
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


def mark_drawn() -> None:
    try:
        flag_dir = os.path.dirname(DRAWN_FLAG)
        if flag_dir:
            os.makedirs(flag_dir, exist_ok=True)
        with open(DRAWN_FLAG, "w", encoding="ascii") as fh:
            fh.write("1\n")
    except OSError:
        pass


def show(img) -> bool:
    out = os.environ.get("VETURA_SPLASH_OUT")
    if out:
        img.save(out)
        return True
    if write_fb(img):
        mark_drawn()
        return True
    try:
        with open("/dev/console", "w", encoding="utf-8") as con:
            con.write("\033[2J\033[H")
            con.write("Vetura\n")
            con.flush()
    except OSError:
        pass
    return False


def current_state(w: int, h: int):
    ip = os.environ.get("VETURA_SPLASH_IP", first_ipv4())
    done_env = os.environ.get("VETURA_SPLASH_DONE")
    if done_env is not None:
        done = done_env in ("1", "true", "yes")
    else:
        done = os.path.isfile(PROVISION_DONE)
    return done, ip, w, h


def main() -> int:
    hide_cursor()
    w, h = canvas_size()
    if os.environ.get("VETURA_SPLASH_OUT"):
        done, ip, w, h = current_state(w, h)
        base, logo, xy = compose_layers(w, h, done, ip)
        show(apply_logo(base, logo, xy, 1.0))
        return 0

    last_state = None
    base = logo = xy = None
    started = time.monotonic()
    last_poll = 0.0
    done, ip = False, ""

    while True:
        now = time.monotonic()
        geo = fb_geometry()
        if geo:
            w, h = geo[0], geo[1]
        if last_state is None or now - last_poll >= POLL_S:
            done, ip, w, h = current_state(w, h)
            last_poll = now
        state = (done, ip, w, h)
        if state != last_state:
            base, logo, xy = compose_layers(w, h, done, ip)
            last_state = state
        frame = apply_logo(base, logo, xy, fade_opacity(now - started))
        show(frame)
        time.sleep(FRAME_S)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
