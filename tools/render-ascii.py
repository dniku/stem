#!/usr/bin/env python3
"""Render the bench as text, from the same geometry the canvas uses.

The golden screenshots are the real check of how this looks, and they need a
browser. When one cannot be started, this is what is left: the layout maths from
src/app.js, sampled into characters, so "is the tallest pipe clipped?", "do the
pipes fit across?", "is the block where the hint says it is?" can be answered by
looking rather than by trusting an arithmetic assertion.

It draws what the renderer draws -- block, pipe bodies, standing wave, mouth tab,
label band -- at one character per sample. It is not a pixel reference and does
not try to be: it exists to catch a layout that is wrong in an obvious way.
"""
from __future__ import annotations

import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from selfcheck import Bench, Pipe  # noqa: E402  (the geometry, not a copy of it)

ROWS = 30
COLS = 108


def render(bench: Bench, title: str, sounding: set[int] = frozenset()) -> str:
    """Sample the bench geometry into a character grid."""
    # Canvas CSS pixels -> grid cells.
    sx = COLS / bench.width
    sy = ROWS / bench.height
    grid = [[" "] * COLS for _ in range(ROWS)]

    def put(x: float, y: float, char: str) -> None:
        col, row = int(x * sx), int(y * sy)
        if 0 <= row < ROWS and 0 <= col < COLS:
            grid[row][col] = char

    block_row = int(bench.block_y * sy)
    for col in range(COLS):
        grid[min(block_row, ROWS - 1)][col] = "="

    for index, pipe in enumerate(bench.organ.pipes):
        center_x = bench.pipe_center_x(index)
        width_px = bench.pipe_width_px(pipe)
        height_px = bench.pipe_height_px(pipe)
        top_y = bench.block_y - height_px
        left, right = center_x - width_px / 2, center_x + width_px / 2
        body = "#" if index in sounding else "|"
        # Body edges, every row between the top and the block.
        steps = max(1, int(height_px * sy))
        for step in range(steps + 1):
            y = top_y + (block_row and (bench.block_y - top_y)) * step / steps
            put(left, y, "[")
            put(right, y, "]")
        # Standing wave: the function the canvas actually plots.
        k = 2 * pipe.register - 1
        amplitude = width_px / 2 - 2
        for step in range(steps * 3 + 1):
            fraction = step / (steps * 3)
            y = bench.block_y - fraction * height_px
            x = center_x + math.sin(k * math.pi * fraction / 2) * amplitude
            put(x, y, "~" if index not in sounding else "*")
        # Mouth tab, drawn wider than the bore the way the canvas does.
        mouth = bench.mouth_y(pipe)
        for offset in (-width_px / 2 - 8, width_px / 2 + 8):
            put(center_x + offset, mouth, "T")
        put(left - 6, mouth - 6, "m")  # grab affordance label
        # Label band above the pipe.
        note = f"{pipe.length_m * 100:.0f}cm r{pipe.register}"
        label_row = max(0, int(top_y * sy) - 1)
        start = max(0, min(COLS - len(note) - 1, int(center_x * sx) - len(note) // 2))
        for i, ch in enumerate(note):
            grid[label_row][start + i] = ch
        if top_y < 0:
            # Loud rather than subtle: a pipe drawn off the top of the screen is
            # the failure this whole file is here to make visible.
            for i, ch in enumerate("CLIPPED-ABOVE"):
                grid[0][i] = ch

    rows_out = ["".join(row).rstrip() for row in grid]
    header = f"{title}  ({bench.width}x{bench.height} css px, blockY={bench.block_y:.0f}, pxPerM={bench.px_per_m:.0f})"
    return header + "\n" + "\n".join("|" + row.ljust(COLS) + "|" for row in rows_out)


def seeded(width: int, height: int) -> Bench:
    bench = Bench(width=width, height=height)
    bench.organ.pipes = []
    for length, radius in [(0.65, 0.012), (0.427, 0.018), (0.3226, 0.009)]:
        pipe = Pipe(length_m=length, radius_m=radius)
        bench.organ.snap_pipe(pipe)
        bench.organ.pipes.append(pipe)
    bench.update_scale()
    return bench


def main() -> int:
    for name, width, height in [
        ("desktop", 1280, 860),
        ("phone portrait", 390, 844),
        ("phone landscape", 844, 390),
    ]:
        print()
        print(render(seeded(width, height), name))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
