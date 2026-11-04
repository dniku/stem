#!/usr/bin/env python3
"""Render the bench to PNG with no browser, to look at the layout.

Scope, stated plainly because it matters: this is a *layout* preview, not the
app. It draws the same geometry (from tools/selfcheck.py's Bench, which mirrors
src/app.js) and the same standing-wave function, with block, pipe bodies, feet,
mouth tabs, glow and a level meter. It does not have the real CSS box model, the
real font metrics, gradients at full fidelity, or canvas compositing, and it
draws labels as blocks sized by character count. The golden screenshots taken in
a real browser are what verify appearance; this exists so that on a machine
where no browser can start, "is the rack clipped? do the pipes fill the screen?
is the block where the hint says?" are still answered by looking rather than by
trusting an assertion about numbers.
"""
from __future__ import annotations

import math
import pathlib
import struct
import sys
import zlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from selfcheck import Bench, Pipe  # noqa: E402

SEEDS = [(0.65, 0.012), (0.427, 0.018), (0.3226, 0.009)]


# ---------------------------------------------------------------------------
# A small RGB canvas with the handful of primitives the bench needs.
# ---------------------------------------------------------------------------
class Canvas:
    def __init__(self, width: int, height: int) -> None:
        self.width = width
        self.height = height
        self.data = bytearray(width * height * 3)

    def blend(self, x: int, y: int, colour: tuple[int, int, int], alpha: float = 1.0) -> None:
        if not (0 <= x < self.width and 0 <= y < self.height) or alpha <= 0:
            return
        offset = (y * self.width + x) * 3
        for channel in range(3):
            self.data[offset + channel] = int(
                self.data[offset + channel] * (1 - alpha) + colour[channel] * alpha
            )

    def rect(self, x: float, y: float, w: float, h: float, colour, alpha: float = 1.0) -> None:
        for py in range(max(0, int(y)), min(self.height, int(y + h))):
            for px in range(max(0, int(x)), min(self.width, int(x + w))):
                self.blend(px, py, colour, alpha)

    def vgrad(self, x: float, y: float, w: float, h: float, top, bottom) -> None:
        y0, y1 = max(0, int(y)), min(self.height, int(y + h))
        span = max(1, y1 - y0)
        for py in range(y0, y1):
            t = (py - y0) / span
            colour = tuple(int(top[c] * (1 - t) + bottom[c] * t) for c in range(3))
            self.rect(x, py, w, 1, colour)

    def hgrad(self, x: float, y: float, w: float, h: float, left, mid, right) -> None:
        x0, x1 = max(0, int(x)), min(self.width, int(x + w))
        span = max(1, x1 - x0)
        for px in range(x0, x1):
            t = (px - x0) / span
            a, b = (left, mid) if t < 0.5 else (mid, right)
            u = t * 2 if t < 0.5 else (t - 0.5) * 2
            colour = tuple(int(a[c] * (1 - u) + b[c] * u) for c in range(3))
            self.rect(px, y, 1, h, colour)

    def outline(self, x: float, y: float, w: float, h: float, colour, thickness: int = 2) -> None:
        self.rect(x, y, w, thickness, colour)
        self.rect(x, y + h - thickness, w, thickness, colour)
        self.rect(x, y, thickness, h, colour)
        self.rect(x + w - thickness, y, thickness, h, colour)

    def stroke(self, points, colour, width: float) -> None:
        """Thick polyline by dot stamping; enough for a wave, not a renderer."""
        radius = max(1, int(width / 2))
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            steps = max(int(math.hypot(x1 - x0, y1 - y0)), 1)
            for step in range(steps + 1):
                t = step / steps
                cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
                for dy in range(-radius, radius + 1):
                    for dx in range(-radius, radius + 1):
                        if dx * dx + dy * dy <= radius * radius:
                            self.blend(int(cx) + dx, int(cy) + dy, colour)

    def text_block(self, x: float, y: float, text: str, colour, scale: float = 1.0) -> None:
        """5x7 glyphs at `scale`, centred on x. Not the real font; a footprint."""
        glyph_w, glyph_h = 4 * scale, 6 * scale
        total = len(text) * glyph_w
        start = x - total / 2
        for i, char in enumerate(text):
            bitmap = GLYPHS.get(char.upper(), GLYPHS["?"])
            gx = start + i * glyph_w
            for row, bits in enumerate(bitmap):
                for col in range(5):
                    if bits & (1 << (4 - col)):
                        self.rect(gx + col * scale, y + row * scale, scale, scale, colour)

    def write_png(self, path: pathlib.Path) -> None:
        raw = bytearray()
        for y in range(self.height):
            raw.append(0)
            raw.extend(self.data[y * self.width * 3:(y + 1) * self.width * 3])

        def chunk(tag: bytes, payload: bytes) -> bytes:
            return (struct.pack(">I", len(payload)) + tag + payload
                    + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

        png = b"\x89PNG\r\n\x1a\n"
        png += chunk(b"IHDR", struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        png += chunk(b"IEND", b"")
        path.write_bytes(png)


# Row-major 5x7 bitmaps, MSB first. Enough to read the labels.
GLYPHS: dict[str, list[int]] = {
    " ": [0] * 7, "?": [0b01110, 0b10001, 0b00010, 0b00100, 0b00000, 0b00100, 0b00000],
    ".": [0, 0, 0, 0, 0, 0b00100, 0b00100], "-": [0, 0, 0, 0b11111, 0, 0, 0],
    "=": [0, 0, 0b11111, 0, 0b11111, 0, 0], "/": [0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0, 0],
    "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
    "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
    "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
    "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
    "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
    "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
    "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
    "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
    "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
    "A": [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    "B": [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
    "C": [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
    "D": [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
    "E": [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
    "F": [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
    "G": [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
    "H": [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    "L": [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
    "M": [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
    "N": [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
    "O": [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    "P": [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
    "R": [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
    "S": [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
    "T": [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
    "U": [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    "X": [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
    "Y": [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
}
GLYPHS["—"] = GLYPHS["-"]
GLYPHS["Ø"] = GLYPHS["O"]
GLYPHS["·"] = GLYPHS["."]
GLYPHS["°"] = GLYPHS["."]


def hsl(hue: float, saturation: float, lightness: float) -> tuple[int, int, int]:
    """HSL -> RGB, matching what `hsl()` in the canvas produces."""
    c = (1 - abs(2 * lightness - 1)) * saturation
    x = c * (1 - abs(((hue / 60) % 2) - 1))
    m = lightness - c / 2
    r, g, b = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][int(hue // 60) % 6]
    return (int((r + m) * 255), int((g + m) * 255), int((b + m) * 255))


def seeded(width: int, height: int, register0: int = 1) -> Bench:
    bench = Bench(width=width, height=height)
    bench.organ.pipes = []
    for length, radius in SEEDS:
        pipe = Pipe(length_m=length, radius_m=radius)
        bench.organ.snap_pipe(pipe)
        bench.organ.pipes.append(pipe)
    bench.organ.pipes[0].register = register0
    bench.update_scale()
    total = (len(bench.organ.pipes) - 1) * bench.pipe_gap + sum(bench.pipe_width_px(p) for p in bench.organ.pipes)
    bench.first_pipe_x = max(18, (bench.width - total) / 2)
    return bench


def draw_bench(canvas: Canvas, bench: Bench, sounding: int = -1, offset_x: int = 0) -> None:
    w, h = bench.width, bench.height
    canvas.vgrad(offset_x, 0, w, h, (11, 18, 32), (20, 29, 44))
    canvas.rect(offset_x, bench.block_y, w, h - bench.block_y, (38, 50, 74))
    canvas.rect(offset_x, bench.block_y, w, 3, (58, 76, 105))
    meter_w = min(150, w * 0.3)
    canvas.rect(offset_x + w - meter_w - 14, bench.block_y + 14, meter_w, 6, (26, 36, 52))
    canvas.rect(offset_x + w - meter_w - 14, bench.block_y + 14, meter_w * 0.4, 6, (127, 214, 193))

    for index, pipe in enumerate(bench.organ.pipes):
        center_x = offset_x + bench.pipe_center_x(index)
        width_px = bench.pipe_width_px(pipe)
        height_px = bench.pipe_height_px(pipe)
        top_y = bench.block_y - height_px
        left = center_x - width_px / 2
        lit = index == sounding
        semitones = index * 7 - 12
        hue_val = ((semitones * 9) % 360 + 360) % 360
        lightness = 0.68 if lit else 0.44
        canvas.hgrad(left, top_y, width_px, height_px,
                     hsl(hue_val, 0.34, lightness - 0.16),
                     hsl(hue_val, 0.46, lightness),
                     hsl(hue_val, 0.34, lightness - 0.10))
        canvas.rect(left - 2, bench.block_y - 5, width_px + 4, 5, hsl(hue_val, 0.30, lightness - 0.24))

        # Standing wave: the same sin(k*pi*s/2) the canvas plots.
        k = 2 * pipe.register - 1
        amplitude = max(2.0, width_px / 2 - 2)
        points = [
            (center_x + math.cos(k * math.pi * (step / 48) / 2) * amplitude,
             bench.block_y - (step / 48) * height_px)
            for step in range(49)
        ]
        canvas.stroke(points, (8, 18, 30), max(1.5, width_px * 0.1))

        mouth = bench.mouth_y(pipe)
        tab = width_px + 22
        canvas.rect(center_x - tab / 2, mouth - 4, tab, 8, (255, 220, 160) if lit else (217, 164, 104))
        canvas.rect(center_x - width_px * 0.3, mouth - 2.5, width_px * 0.6, 5, (27, 17, 5) if lit else (43, 29, 12))
        if lit:
            canvas.outline(left - 3, top_y - 3, width_px + 6, height_px + 6, (160, 232, 255), 2)

        base = max(11.0, min(15.0, w / 85))
        label = ["C3", "G3", "C4"][index] if index < 3 else "C?"
        detail = f"{pipe.length_m * 100:.0f}CM R{pipe.register}"
        label_y = max(base + 2, top_y - 6)
        canvas.text_block(center_x, label_y - 6 * (base / 11), label, (242, 251, 255) if lit else (195, 213, 232),
                          scale=max(1.4, base / 8))
        canvas.text_block(center_x, max(2, label_y - 6 * (base / 11) - 7 * (base / 11)), detail,
                          (139, 163, 192), scale=max(1.2, base / 10))


def main(argv: list[str]) -> int:
    out = pathlib.Path(argv[1] if len(argv) > 1 else ".tmp/preview-layout.png")
    out.parent.mkdir(parents=True, exist_ok=True)

    # One sheet: desktop, and a rack overblown into register 2 beside it.
    scenes = [("desktop 1280x860", seeded(1280, 860), 0),
              ("overblown r2", seeded(1280, 860, register0=2), -1)]
    gap = 24
    total_w = sum(s[1].width for s in scenes) + gap * (len(scenes) + 1)
    total_h = max(s[1].height for s in scenes) + 60
    canvas = Canvas(total_w, total_h)
    cursor = gap
    for title, bench, sounding in scenes:
        draw_bench(canvas, bench, sounding, offset_x=cursor)
        canvas.text_block(cursor + bench.width / 2, 20, title.upper(), (127, 214, 193), scale=3)
        cursor += bench.width + gap
    canvas.write_png(out)
    print(f"wrote {out} ({out.stat().st_size / 1024:.1f} KiB) -- layout preview, not the app")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
