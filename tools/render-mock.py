#!/usr/bin/env python3
"""Draw the bench as SVG, from the geometry in src/app.js.

Not a test and not a pixel reference: the golden screenshots, taken in a real
browser, are how the app's appearance is verified, and those need Playwright.
This exists for the sessions where a browser cannot be started at all, so that
"does the layout make sense on a phone in portrait?" is still a question that can
be answered by looking at something rather than by trusting an arithmetic
assertion about coordinates.

What it shares with the app, deliberately: the pipe/block/mouth geometry comes
from tools/selfcheck.py's Bench, which mirrors src/app.js, and the standing wave
is the same sin(k*pi*s/2) the canvas plots. What it does NOT have: the real font,
the real gradients, or any of the canvas compositing. Text is laid out by
character count, so label widths here are approximate.
"""
from __future__ import annotations

import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from selfcheck import Bench, Pipe  # noqa: E402

SEEDS = [(0.65, 0.012), (0.427, 0.018), (0.3226, 0.009)]
NAMES = ["C3", "G3", "C4"]


def seeded(width: int, height: int) -> Bench:
    bench = Bench(width=width, height=height)
    bench.organ.pipes = []
    for length, radius in SEEDS:
        pipe = Pipe(length_m=length, radius_m=radius)
        bench.organ.snap_pipe(pipe)
        bench.organ.pipes.append(pipe)
    bench.update_scale()
    return bench


def hue(index: int) -> int:
    """The same derived-not-chosen colour rule the canvas uses, roughly."""
    return (index * 140) % 360


def svg_panel(bench: Bench, title: str, sounding: int = -1) -> str:
    w, h = bench.width, bench.height
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
        f'<defs><linearGradient id="bg{title}" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#141d2c"/></linearGradient></defs>',
        f'<rect width="{w}" height="{h}" fill="url(#bg{title})"/>',
    ]
    # Windchest.
    parts.append(f'<rect x="0" y="{bench.block_y:.1f}" width="{w}" height="{h - bench.block_y:.1f}" fill="#26324a"/>')
    parts.append(f'<rect x="0" y="{bench.block_y:.1f}" width="{w}" height="3" fill="#3a4c69"/>')
    meter_w = min(150, w * 0.3)
    parts.append(
        f'<rect x="{w - meter_w - 14:.1f}" y="{bench.block_y + 14:.1f}" width="{meter_w:.1f}" height="6" fill="#1a2434"/>'
    )
    parts.append(
        f'<rect x="{w - meter_w - 14:.1f}" y="{bench.block_y + 14:.1f}" width="{meter_w * 0.35:.1f}" height="6" fill="#7fd6c1"/>'
    )

    for index, pipe in enumerate(bench.organ.pipes):
        center_x = bench.pipe_center_x(index)
        width_px = bench.pipe_width_px(pipe)
        height_px = bench.pipe_height_px(pipe)
        top_y = bench.block_y - height_px
        left = center_x - width_px / 2
        lit = index == sounding
        colour = f"hsl({hue(index)}, 46%, {70 if lit else 45}%)"
        dark = f"hsl({hue(index)}, 34%, {54 if lit else 29}%)"
        parts.append(
            f'<rect x="{left:.1f}" y="{top_y:.1f}" width="{width_px:.1f}" height="{height_px:.1f}" fill="{colour}"/>'
        )
        # Closed foot.
        parts.append(
            f'<rect x="{left - 2:.1f}" y="{bench.block_y - 5:.1f}" width="{width_px + 4:.1f}" height="5" fill="{dark}"/>'
        )
        # Standing wave.
        k = 2 * pipe.register - 1
        amplitude = max(2.0, width_px / 2 - 2)
        points = []
        for step in range(49):
            fraction = step / 48
            y = bench.block_y - fraction * height_px
            x = center_x + math.sin(k * math.pi * fraction / 2) * amplitude
            points.append(f"{x:.1f},{y:.1f}")
        parts.append(
            f'<polyline points="{" ".join(points)}" fill="none" '
            f'stroke="{"rgba(8,18,30,0.8)" if lit else "rgba(8,18,30,0.4)"}" '
            f'stroke-width="{max(1.5, width_px * 0.1):.1f}"/>'
        )
        # Mouth tab.
        mouth = bench.mouth_y(pipe)
        tab = width_px + 22
        parts.append(
            f'<rect x="{center_x - tab / 2:.1f}" y="{mouth - 4:.1f}" width="{tab:.1f}" height="8" '
            f'fill="{"#ffdca0" if lit else "#d9a468"}"/>'
        )
        parts.append(
            f'<rect x="{center_x - width_px * 0.3:.1f}" y="{mouth - 2.5:.1f}" width="{width_px * 0.6:.1f}" '
            f'height="5" fill="{"#1b1105" if lit else "#2b1d0c"}"/>'
        )
        if lit:
            parts.append(
                f'<rect x="{left - 3:.1f}" y="{top_y - 3:.1f}" width="{width_px + 6:.1f}" '
                f'height="{height_px + 6:.1f}" fill="none" stroke="rgba(160,232,255,0.55)" stroke-width="2"/>'
            )
        # Labels.
        base = max(11.0, min(15.0, w / 85))
        label_y = max(base + 2, top_y - 6)
        parts.append(
            f'<text x="{center_x:.1f}" y="{label_y:.1f}" text-anchor="middle" font-size="{base:.1f}" '
            f'font-weight="700" fill="{"#f2fbff" if lit else "#c3d5e8"}" '
            f'font-family="DejaVu Sans, sans-serif">{NAMES[index]}</text>'
        )
        parts.append(
            f'<text x="{center_x:.1f}" y="{max(12, label_y - base - 1):.1f}" text-anchor="middle" '
            f'font-size="{max(10, base - 2.5):.1f}" fill="#8ba3c0" font-family="DejaVu Sans, sans-serif">'
            f'{pipe.length_m * 100:.0f} cm &#183; &#0198;{pipe.radius_m * 2000:.0f} mm &#183; r{pipe.register}</text>'
        )
    parts.append('</svg>')
    return "".join(parts)


def main() -> int:
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(".tmp/mock.svg")
    scenes = [
        ("desktop", 1280, 860, 20, 20),
        ("portrait", 390, 844, 1360, 20),
        ("landscape", 844, 390, 1810, 20),
    ]
    total_w = 20 + 1280 + 40 + 390 + 40 + 844 + 20
    total_h = 20 + 860 + 20
    panels = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w}" height="{total_h}" '
              f'viewBox="0 0 {total_w} {total_h}"><rect width="{total_w}" height="{total_h}" fill="#05080e"/>']
    for name, w, h, x, y in scenes:
        bench = seeded(w, h)
        sounding = 0 if name == "desktop" else -1
        body = svg_panel(bench, name, sounding)
        inner = body.split(">", 1)[1].rsplit("</svg>", 1)[0]
        panels.append(f'<g transform="translate({x},{y})">{inner}</g>')
        panels.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="#33465e"/>')
        panels.append(
            f'<text x="{x}" y="{y - 4}" font-size="15" fill="#7fd6c1" '
            f'font-family="DejaVu Sans, sans-serif">{name} {w}&#215;{h}</text>'
        )
    panels.append('</svg>')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(panels))
    print(f"wrote {out} ({out.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
