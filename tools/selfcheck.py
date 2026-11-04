#!/usr/bin/env python3
"""A headless harness that runs the app's own gestures against the model.

Why this exists: the real browser suite (tests/interaction.test.mjs) needs Node
and Playwright, which come from the pinned Nix shell. When that shell cannot be
reached -- no daemon, no network, a sandbox that will not start a browser -- the
project still deserves an executable check that the gesture rules and the
acoustics do what the copy claims. So this file re-derives the *behavioural
contract* from src/app.js in plain Python and asserts it.

It is deliberately NOT a re-implementation of the renderer or the audio engine;
it models only the state transitions a gesture causes, so it can catch a rule
that has drifted, not a pixel that has moved. The browser suite owns pixels.

The rule set below is read out of src/app.js by hand. If the two ever disagree,
the browser suite is authoritative and this file is wrong.
"""
from __future__ import annotations

import math
import re
import pathlib
import sys
from dataclasses import dataclass, field

ROOT = pathlib.Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------
# The model, mirroring src/acoustics.js
# --------------------------------------------------------------------------
def speed_of_sound(temperature_c: float) -> float:
    return 331.3 * math.sqrt(1 + temperature_c / 273.15)


def cents_between(frequency: float, reference: float) -> float:
    return 1200 * math.log2(frequency / reference)


@dataclass
class Pipe:
    length_m: float
    radius_m: float
    footprint: float = 0.5
    register: int = 1
    # Screen column, once a gesture has placed the pipe. Absent means "pack left
    # to right", which is how the seeded rack is laid out.
    anchor_x: float | None = None

    @property
    def effective_length_m(self) -> float:
        return self.length_m + 0.6 * self.radius_m

    def frequency_hz(self, temperature_c: float) -> float:
        return (2 * self.register - 1) * speed_of_sound(temperature_c) / (4 * self.effective_length_m)

    def partial_amplitudes(self, count: int = 8) -> list[float]:
        return [
            (1 if n % 2 else 0) * n ** -(1.4 - 1.1 * self.footprint)
            for n in range(1, count + 1)
        ]


@dataclass
class Organ:
    temperature_c: float = 20.0
    snapped: bool = True
    reference_hz: float = 261.63
    pipes: list[Pipe] = field(default_factory=list)

    def nearest_semitone(self, pipe: Pipe) -> int:
        return round(cents_between(pipe.frequency_hz(self.temperature_c), self.reference_hz) / 100)

    def snap_pipe(self, pipe: Pipe) -> None:
        semitones = self.nearest_semitone(pipe)
        target = self.reference_hz * 2 ** (semitones / 12)
        pipe.length_m = (2 * pipe.register - 1) * speed_of_sound(self.temperature_c) / (
            4 * target
        ) - 0.6 * pipe.radius_m


# --------------------------------------------------------------------------
# The bench geometry, mirroring the LAYOUT block in src/app.js
# --------------------------------------------------------------------------
MIN_PIPE_WIDTH_PX = 26
MIN_CUT_M = 0.05
MAX_RACK_SPAN_M = 1.15
MIN_RADIUS_M = 0.004
MAX_RADIUS_M = 0.05


@dataclass
class Bench:
    width: int
    height: int
    organ: Organ = field(default_factory=Organ)
    block_y: float = 0.0
    px_per_m: float = 1.0
    pipe_gap: float = 0.0
    first_pipe_x: float = 0.0

    def __post_init__(self) -> None:
        self.block_y = self.height - max(42, min(72, self.height * 0.09))
        self.usable_height_px = self.block_y - max(72, self.height * 0.12)
        self.pipe_gap = max(12, min(30, self.width / 34))
        self.row_margin_px = 18.0
        self.row_scale = 1.0
        self.update_scale()
        self.layout_row()

    def layout_row(self) -> None:
        """Centre the row. Called after the rack changes, as computeLayout is."""
        self.first_pipe_x = max(self.row_margin_px, (self.width - self.rack_width_px()) / 2)

    def rack_width_px(self) -> float:
        """Fitted width of the row; sets row_scale, as rackWidthPx() does."""
        count = len(self.organ.pipes)
        if count == 0:
            self.row_scale = 1.0
            return 0.0
        natural = (sum(self.natural_width_px(p) for p in self.organ.pipes)
                   + (count - 1) * self.pipe_gap)  # gaps enter unscaled, then scale
        available = max(0.0, self.width - 2 * self.row_margin_px)
        self.row_scale = available / natural if natural > available else 1.0
        return natural * self.row_scale

    #: How much length the bench shows at full height. Fixed per viewport -- the
    #: scale must not depend on the content, or drag length and view scale feed
    #: back into each other. See updateScale() in src/app.js.
    VIEW_SPAN_M = 0.75

    def update_scale(self) -> None:
        self.px_per_m = self.usable_height_px / self.VIEW_SPAN_M

    #: Drawn width, mirroring LAYOUT in src/app.js: base plus an amplified share
    #: of the true bore, floored at the touch target. See pipeWidthPx() there.
    BASE_PIPE_WIDTH_PX = 48.0
    BORE_VISUAL_GAIN = 1.6

    def natural_width_px(self, pipe: Pipe) -> float:
        true_width_px = pipe.radius_m * 2 * self.px_per_m
        return max(MIN_PIPE_WIDTH_PX,
                   self.BASE_PIPE_WIDTH_PX + true_width_px * self.BORE_VISUAL_GAIN)

    def pipe_width_px(self, pipe: Pipe) -> float:
        return self.natural_width_px(pipe) * self.row_scale

    def pipe_center_x(self, index: int) -> float:
        pipe = self.organ.pipes[index]
        if pipe.anchor_x is not None:
            return pipe.anchor_x
        x = self.first_pipe_x
        gap = self.pipe_gap * self.row_scale
        for earlier in self.organ.pipes[:index]:
            x += self.pipe_width_px(earlier) + gap
        return x + self.pipe_width_px(pipe) / 2

    def pipe_height_px(self, pipe: Pipe) -> float:
        return pipe.length_m * self.px_per_m

    def mouth_y(self, pipe: Pipe) -> float:
        return self.block_y - pipe.footprint * self.pipe_height_px(pipe)

    def length_from_y(self, y: float) -> float:
        return min(max((self.block_y - y) / self.px_per_m, 0.0), self.VIEW_SPAN_M)

    def hit_test(self, x: float, y: float) -> tuple[str, int | None, Pipe | None]:
        """Topmost (last-drawn) pipe wins, and the mouth is grabbed by its tab."""
        for index in range(len(self.organ.pipes) - 1, -1, -1):
            pipe = self.organ.pipes[index]
            center_x = self.pipe_center_x(index)
            half = self.pipe_width_px(pipe) / 2
            top_y = self.block_y - self.pipe_height_px(pipe)
            if not (center_x - half - 8 <= x <= center_x + half + 8):
                continue
            if not (top_y - 10 <= y <= self.block_y + 8):
                continue
            at_edge = abs(x - center_x) > half + 10 - 8
            at_mouth = abs(y - self.mouth_y(pipe)) <= 18
            if at_edge and at_mouth:
                return "mouth", index, pipe
            return "pipe", index, pipe
        return "none", None, None

    # --- gestures -------------------------------------------------------
    def press(self, x: float, y: float) -> "Gesture":
        kind, _, pipe = self.hit_test(x, y)
        if kind == "mouth" and pipe is not None:
            return Gesture(self, "mouth", pipe, x, y)
        if kind == "pipe" and pipe is not None:
            return Gesture(self, "pipe", pipe, x, y)
        new_pipe = Pipe(length_m=self.length_from_y(y), radius_m=0.012, anchor_x=x)
        self.organ.pipes.append(new_pipe)
        return Gesture(self, "cut", new_pipe, x, y)


@dataclass
class Gesture:
    bench: Bench
    kind: str
    pipe: Pipe
    start_x: float
    start_y: float

    def move(self, x: float, y: float) -> None:
        organ = self.bench.organ
        self.bench.update_scale()
        if self.kind == "cut":
            self.pipe.length_m = self.bench.length_from_y(y)
            if organ.snapped:
                organ.snap_pipe(self.pipe)
            return
        if self.kind == "mouth":
            height_px = self.bench.pipe_height_px(self.pipe)
            if height_px <= 0:
                return
            fraction = min(max((self.bench.block_y - y) / height_px, 0.05), 1.0)
            if abs(fraction - self.pipe.footprint) > 1e-4:
                self.pipe.footprint = fraction
                if organ.snapped:
                    organ.snap_pipe(self.pipe)
            return
        dx = x - self.start_x
        dy = y - self.start_y
        threshold = 90
        if dy < -threshold and self.pipe.register < 3:
            self.pipe.register += 1
            self.start_x, self.start_y = x, y
            return
        if dy > threshold and self.pipe.register > 1:
            self.pipe.register -= 1
            self.start_x, self.start_y = x, y
            return
        if abs(dx) > abs(dy):
            start_width = max(MIN_PIPE_WIDTH_PX, self.pipe.radius_m * 2 * self.bench.px_per_m)
            radius = (start_width + dx * 1.5) / 2 / self.bench.px_per_m
            self.pipe.radius_m = min(max(radius, MIN_RADIUS_M), MAX_RADIUS_M)
            if organ.snapped:
                organ.snap_pipe(self.pipe)

    def release(self) -> bool:
        """Return True if the pipe survives the release."""
        self.bench.update_scale()
        if self.kind != "cut":
            return True
        if self.pipe.length_m < MIN_CUT_M:
            self.bench.organ.pipes.remove(self.pipe)
            return False
        if self.bench.organ.snapped:
            self.bench.organ.snap_pipe(self.pipe)
        return True


# --------------------------------------------------------------------------
# Source-contract checks: does src/ still say what this harness assumes?
# --------------------------------------------------------------------------
def check_source_contract() -> list[str]:
    """Guard the harness's own assumption that it mirrors src/app.js.

    Without this, a change to a threshold in src/ would leave the harness
    asserting the old rule and passing, which is worse than having no harness."""
    app_js = (ROOT / "src" / "app.js").read_text()
    acoustics_js = (ROOT / "src" / "acoustics.js").read_text()
    problems: list[str] = []

    def expect(pattern: str, description: str, text: str = app_js) -> None:
        if not re.search(pattern, text):
            problems.append(f"src contract changed, harness may now assert a stale rule: {description}")

    expect(r"Math\.max\(42, Math\.min\(72, height \* 0\.09\)\)", "blockY formula")
    expect(r"Math\.max\(72, height \* 0\.12\)", "top label reserve")
    expect(r"viewSpanM: 0\.75", "fixed view span")
    expect(r"LAYOUT\.pxPerM = LAYOUT\.usableHeightPx / LAYOUT\.viewSpanM", "scale from viewport only")
    # The regression this guards: a scale derived from the longest pipe makes two
    # drags of different pixel length come out identical, killing the beat demo.
    if "longest * 1.08" in app_js or "smoothedSpanM" in app_js:
        problems.append("drawing scale reads the rack again; drag length stops being reliable")
    expect(r"usableHeightPx = LAYOUT\.blockY - Math\.max\(72, height \* 0\.12\)", "usable height")
    expect(r"for \(let index = app\.organ\.pipes\.length - 1; index >= 0; index -= 1\)", "topmost-first hit test")
    expect(r"halfWidth \+ 10", "mouth tab grab reach")
    expect(r"minPipeWidthPx: 26", "min touch width")
    expect(r"basePipeWidthPx: 48", "base drawn pipe width")
    expect(r"boreVisualGain: 1\.6", "bore visual gain")
    expect(r"LAYOUT\.basePipeWidthPx \+ trueWidthPx \* LAYOUT\.boreVisualGain", "pipe width rule")
    expect(r"pipeGap = Math\.max\(12, Math\.min\(30, width / 34\)\)", "pipe gap")
    expect(r"\(width - rackWidthPx\(\)\) / 2", "rack is centred")
    expect(r"minCutM: 0\.05", "minimum cut length")
    expect(r"mouthBandPx = 18", "mouth hit band")
    expect(r"overblowThresholdPx = 90", "overblow threshold")
    expect(r"dx \* 1\.5", "bore drag gain")
    expect(r"MIN_RADIUS_M = 0\.004", "min radius")
    expect(r"MAX_RADIUS_M = 0\.05", "max radius")
    expect(r"0\.6 \* this\.radiusM", "end correction 0.6r", acoustics_js)
    expect(r"331\.3 \* Math\.sqrt\(1 \+ temperatureC / 273\.15\)", "sound speed formula", acoustics_js)
    expect(r"return Math\.cos\(\(k \* Math\.PI \* sample\) / 2\)", "standing wave is pressure (cos)")
    return problems


# --------------------------------------------------------------------------
# Behavioural assertions
# --------------------------------------------------------------------------
FAILURES: list[str] = []


def check(description: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {description}")
    else:
        print(f"  FAIL {description}{' :: ' + detail if detail else ''}")
        FAILURES.append(description)


def seeded(width: int, height: int) -> Bench:
    """A bench with the app's opening rack, at one viewport size."""
    bench = Bench(width=width, height=height)
    bench.organ.pipes = []
    for length, radius in [(0.65, 0.012), (0.427, 0.018), (0.3226, 0.009)]:
        pipe = Pipe(length_m=length, radius_m=radius)
        bench.organ.snap_pipe(pipe)
        bench.organ.pipes.append(pipe)
    bench.update_scale()
    bench.layout_row()
    return bench


def stack_two_close_pipes(width: int, height: int) -> tuple[Bench, list[Pipe]]:
    """Two pipes cut in the same column a few pixels apart: the beating setup.

    Length is quantised by the view scale -- one pixel of drag is one pixel over
    px_per_m metres, about 2.7 cents at the desktop scale -- so "a few cents
    apart" means a handful of pixels, and the drags must stay inside the height
    the bench can actually show."""
    bench = seeded(width, height)
    bench.organ.snapped = False
    # The column is empty bench to begin with; each press must start on empty
    # bench, so the second pipe is pressed at its own top rather than at the
    # block, which the first pipe is now occupying.
    column = bench.width - 70
    base_px = bench.usable_height_px * 0.62
    cut: list[Pipe] = []
    for extra_px in (0, 4):
        start_y = bench.block_y - 10 if not cut else bench.block_y - (base_px + extra_px) - 30
        gesture = bench.press(column, start_y)
        if gesture.kind != "cut":
            # Pressing on the pipe below would grab it instead. Above it is bench.
            gesture = bench.press(column, bench.block_y - base_px - extra_px - 60)
        for step in range(1, 17):
            gesture.move(column, bench.block_y - 10 - (base_px + extra_px) * step / 16)
        gesture.release()
        cut.append(gesture.pipe)
    return bench, cut


def organ_index(bench: Bench, pipe: Pipe) -> int:
    """Where a pipe actually ended up in the rack, rather than where it was added."""
    return bench.organ.pipes.index(pipe)


def main() -> int:
    print("== source contract ==")
    contract = check_source_contract()
    for problem in contract:
        print(f"  FAIL {problem}")
    if contract:
        print("\nHarness is out of date with src/app.js; fix it before trusting anything below.")
        return 1
    print("  ok   harness thresholds still match src/app.js")

    desktop = seeded(1280, 860)
    print("\n== seeded rack (desktop 1280x860) ==")
    notes = [p.frequency_hz(20) for p in desktop.organ.pipes]
    print(f"  frequencies: {', '.join(f'{f:.2f} Hz' for f in notes)}")
    semitones = [round(cents_between(f, 261.63) / 100) for f in notes]
    check("rack is C3, G3, C4 (a stopped pipe's 1x, 3x and an octave)", semitones == [-12, -5, 0],
          f"semitones {semitones}")
    # The rack is cut to *equal temperament*, so G3 sits at 700.0 cents, four
    # tenths of a cent below the pipe's own just twelfth at 1901.955. That gap is
    # the real, physical difference between "in tune with a piano" and "in tune
    # with this pipe's own resonance" -- the reason tune-lock is a toggle rather
    # than a certainty, and the reason the two pipes below beat when unlocked.
    check("the seeded rack is in equal temperament, so its twelfth is 700.0 cents",
          abs(cents_between(notes[1], notes[0]) - 700.0) < 0.01,
          f"{cents_between(notes[1], notes[0]):.3f} cents")
    just = desktop.organ.pipes[0]
    just_hz = just.frequency_hz(20) * 3
    check("a pipe's own 3rd resonance is the just twelfth at 1901.955 cents",
          abs(cents_between(just_hz, notes[0]) - 1901.955) < 0.01,
          f"{cents_between(just_hz, notes[0]):.3f} cents")
    # The rack's G3 is one octave below the pipe's own 3rd resonance, so the
    # comparison is 1901.955 - 1900 = 1.955 cents: equal temperament tunes that
    # G3 about two cents flat of the twelfth this pipe would naturally sound.
    twelfth_above_rack_g3 = cents_between(just_hz, notes[1])
    check("equal temperament tunes the rack's G3 ~2 cents flat of the pipe's own twelfth",
          1.9 < twelfth_above_rack_g3 - 1200 < 2.0,
          f"{twelfth_above_rack_g3 - 1200:.3f} cents off")
    for index, pipe in enumerate(desktop.organ.pipes):
        top = desktop.block_y - desktop.pipe_height_px(pipe)
        check(f"pipe {index} top ({top:.0f}px) is on screen", top >= 0)
    total_width = sum(desktop.pipe_width_px(p) for p in desktop.organ.pipes) + 2 * desktop.pipe_gap
    check("the three pipes fit across the desktop bench",
          desktop.first_pipe_x + total_width < desktop.width, f"{total_width:.0f}px used")

    print("\n== cutting a pipe ==")
    bench = seeded(1280, 860)
    x, y = bench.width - 60, bench.block_y - 10
    kind, _, _ = bench.hit_test(x, y)
    check("chosen start point is empty bench", kind == "none", kind)
    gesture = bench.press(x, y)
    # A steady upward drag, sampled the way a finger moves: the view eases out to
    # follow the pipe, so this must converge rather than run away.
    for step in range(1, 31):
        gesture.move(x, y - step * 20)
    gesture.release()
    cut = bench.organ.pipes[-1]
    long_hz = cut.frequency_hz(20)
    check("a cut pipe appears on the rack", len(bench.organ.pipes) == 4)
    check("a long cut pipe is lower than middle C", long_hz < 261.63, f"{long_hz:.1f} Hz")
    height_px = bench.pipe_height_px(cut)
    check("the longest pipe fills most of the bench rather than a strip of it",
          0.6 < height_px / bench.usable_height_px <= 1.0,
          f"{height_px:.0f} of {bench.usable_height_px:.0f}px")
    check("a cut pipe still lands on a semitone while tune-lock is on",
          abs(cents_between(long_hz, 261.63) / 100 - round(cents_between(long_hz, 261.63) / 100)) < 1e-9)

    print("\n== a tap that never leaves the block ==")
    bench = seeded(1280, 860)
    before = len(bench.organ.pipes)
    gesture = bench.press(bench.width - 60, bench.block_y - 10)
    gesture.move(bench.width - 60, bench.block_y - 6)
    survived = gesture.release()
    check("a tap is not a pipe", len(bench.organ.pipes) == before and not survived)

    print("\n== halving the length raises an octave ==")
    bench = seeded(1280, 860)
    gesture = bench.press(bench.width - 60, bench.block_y - 10)
    gesture.move(bench.width - 60, bench.block_y - 500)
    gesture.release()
    bench.organ.snapped = False
    half = bench.organ.pipes[-1]
    # Snap it first so the comparison is between in-tune pipes.
    bench.organ.snapped = True
    bench.organ.snap_pipe(half)
    reference_hz = half.frequency_hz(20)
    # Halve the effective length, keeping the end correction in place: that is the
    # claim. Halving the measured length instead is a *slightly* smaller interval,
    # which is the same subtlety the end correction is taught with.
    half.length_m = half.length_m / 2 - 0.3 * half.radius_m
    check("half the effective length is exactly one octave up",
          abs(cents_between(half.frequency_hz(20), reference_hz) - 1200) < 0.01,
          f"{cents_between(half.frequency_hz(20), reference_hz):.2f} cents")

    print("\n== overblowing ==")
    bench = seeded(1280, 860)
    pipe = bench.organ.pipes[0]
    fundamental = pipe.frequency_hz(20)
    center_x = bench.pipe_center_x(0)
    middle_y = bench.block_y - bench.pipe_height_px(pipe) / 2
    gesture = bench.press(center_x, middle_y)
    gesture.move(center_x, middle_y - 160)
    ratio = pipe.frequency_hz(20) / fundamental
    check("a firm flick lands on a twelfth (3x), not an octave (2x)",
          pipe.register == 2 and abs(ratio - 3) < 0.02, f"register {pipe.register}, {ratio:.3f}x")
    gesture.move(center_x, middle_y - 320)
    check("a second flick reaches register 3 (5x)",
          pipe.register == 3 and abs(pipe.frequency_hz(20) / fundamental - 5) < 0.02)

    print("\n== the distance gate ==")
    bench = seeded(1280, 860)
    pipe = bench.organ.pipes[0]
    fundamental = pipe.frequency_hz(20)
    center_x = bench.pipe_center_x(0)
    middle_y = bench.block_y - bench.pipe_height_px(pipe) / 2
    gesture = bench.press(center_x, middle_y)
    gesture.move(center_x + 6, middle_y - 14)
    check("a small drag changes neither register nor pitch",
          pipe.register == 1 and abs(pipe.frequency_hz(20) - fundamental) < 1e-9)

    print("\n== bore and the end correction ==")
    bench = seeded(1280, 860)
    pipe = bench.organ.pipes[0]
    bench.organ.snapped = False
    narrow_hz = pipe.frequency_hz(20)
    narrow_radius = pipe.radius_m
    before_length = pipe.length_m
    center_x = bench.pipe_center_x(0)
    grab_y = bench.block_y - bench.pipe_height_px(pipe) * 0.25
    gesture = bench.press(center_x, grab_y)
    gesture.move(center_x + 120, grab_y)
    check("dragging sideways widens the bore", pipe.radius_m > narrow_radius,
          f"{narrow_radius * 1000:.1f} -> {pipe.radius_m * 1000:.1f} mm")
    check("a wider bore sits flatter, at the same measured length",
          pipe.frequency_hz(20) < narrow_hz,
          f"{narrow_hz:.2f} -> {pipe.frequency_hz(20):.2f} Hz")
    # The app snaps to a semitone after a bore drag when tune-lock is on, so the
    # honest claim is that the length stays in the neighbourhood it started in,
    # not that it is bit-identical.
    check("a bore drag leaves the length near where it was",
          abs(pipe.length_m - before_length) < 0.02,
          f"{before_length * 100:.1f} -> {pipe.length_m * 100:.1f} cm")

    print("\n== windhole position and tone colour ==")
    bench = seeded(1280, 860)
    pipe = bench.organ.pipes[0]
    bench.organ.snapped = False
    mouth = bench.mouth_y(pipe)
    center_x = bench.pipe_center_x(0)
    # Grab the tab that sticks out past the bore: that is what the hit test
    # treats as the mouth, and grabbing the centre is deliberately a body drag.
    tab_x = center_x + bench.pipe_width_px(pipe) / 2 + 4
    check("the mouth tab is the thing that grabs as a mouth",
          bench.hit_test(tab_x, mouth)[0] == "mouth", bench.hit_test(tab_x, mouth)[0])
    check("the centre of the same row is a body, not a mouth",
          bench.hit_test(center_x, mouth)[0] == "pipe", bench.hit_test(center_x, mouth)[0])
    gesture = bench.press(tab_x, mouth)
    gesture.move(tab_x, mouth + 90)
    low_ratio = pipe.partial_amplitudes(3)[2] / pipe.partial_amplitudes(3)[0]
    check("dragging the mouth down moves the windhole", pipe.footprint < 0.4,
          f"footprint {pipe.footprint:.2f}")
    check("a low windhole has a weak third partial (flutey)", low_ratio < 0.35, f"ratio {low_ratio:.3f}")
    pipe.footprint = 0.95
    high_ratio = pipe.partial_amplitudes(3)[2] / pipe.partial_amplitudes(3)[0]
    check("a high windhole has a strong third partial (stringy)", high_ratio > 0.6, f"ratio {high_ratio:.3f}")

    print("\n== stacking two pipes in one column ==")
    bench, (first, second) = stack_two_close_pipes(1280, 860)
    check("a pipe cut above another keeps its column",
          abs(bench.pipe_center_x(organ_index(bench, first)) - bench.pipe_center_x(organ_index(bench, second))) < 1,
          "columns differ")
    check("the topmost pipe in the overlap grabs its own gesture, not the one behind",
          bench.hit_test(bench.pipe_center_x(organ_index(bench, second)),
                         bench.block_y - bench.pipe_height_px(second) / 2)[2] is second)
    difference = abs(first.frequency_hz(20) - second.frequency_hz(20))
    check("two pipes cut a few mm apart beat in the audible range",
          0.3 < difference < 30, f"{difference:.2f} Hz")

    print("\n== temperature ==")
    bench = seeded(1280, 860)
    cold = [p.frequency_hz(15) for p in bench.organ.pipes]
    warm = [p.frequency_hz(30) for p in bench.organ.pipes]
    ratios = [w / c for w, c in zip(warm, cold)]
    check("every pipe shifts by the same ratio", max(ratios) - min(ratios) < 1e-12)
    shift = cents_between(ratios[0] * 440, 440)
    check("15 -> 30 C sharpens by ~44 cents", 43 < shift < 45, f"{shift:.1f} cents")

    print("\n== beating ==")
    bench = seeded(1280, 860)
    bench.organ.snapped = False
    a = Pipe(length_m=0.44, radius_m=0.012)
    b = Pipe(length_m=0.44, radius_m=0.05)
    difference = abs(a.frequency_hz(20) - b.frequency_hz(20))
    check("two bores at one length beat at an audible difference",
          1 < difference < 40, f"{difference:.2f} Hz")

    print("\n== narrow phone portrait ==")
    phone = seeded(390, 844)
    check("block is on screen in portrait", 60 < phone.block_y < 844, f"blockY {phone.block_y:.0f}")
    for index, pipe in enumerate(phone.organ.pipes):
        top = phone.block_y - phone.pipe_height_px(pipe)
        center_x = phone.pipe_center_x(index)
        width_px = phone.pipe_width_px(pipe)
        check(f"portrait pipe {index} is fully inside the viewport",
              top >= 0 and center_x - width_px / 2 >= 0 and center_x + width_px / 2 <= 390,
              f"top {top:.0f}, x {center_x:.0f} w {width_px:.0f}")
    empty = next((round(390 * f) for f in [i / 50 for i in range(5, 48)]
                  if phone.hit_test(round(390 * f / 50 * 50 / 50), phone.block_y - 10)[0] == "none"), None)
    check("there is somewhere on the portrait block to start a cut",
          any(phone.hit_test(round(390 * f), phone.block_y - 10)[0] == "none" for f in [i / 100 for i in range(5, 96)]))

    print("\n== many pipes on a narrow screen ==")
    # Centring is clamped so a row can never start off the left edge, but a rack
    # wide enough still overflows the right. Assert what the app guarantees, and
    # state the limit rather than pretending it is not there.
    crowded = seeded(390, 844)
    crowded.organ.snapped = False
    for _ in range(12):
        crowded.organ.pipes.append(Pipe(length_m=0.2, radius_m=0.006))
    crowded.update_scale()
    crowded.layout_row()
    row = crowded.rack_width_px()
    overflow = crowded.first_pipe_x + row - crowded.width
    print(f"  15 pipes: row {row:.0f}px on a {crowded.width}px bench, overflow {overflow:.0f}px")
    check("a crowded rack never starts off the left edge", crowded.first_pipe_x >= 18,
          f"firstPipeX {crowded.first_pipe_x:.0f}")
    check("a crowded rack shrinks to fit rather than spilling off the right",
          overflow <= 1.0, f"overflow {overflow:.0f}px")
    rightmost = max(crowded.pipe_center_x(i) + crowded.pipe_width_px(p) / 2
                    for i, p in enumerate(crowded.organ.pipes))
    check("every pipe in a 15-pipe rack is inside the screen",
          rightmost <= crowded.width, f"rightmost edge at {rightmost:.0f} of {crowded.width}")
    check("shrinking keeps the bores' proportions",
          abs(crowded.pipe_width_px(crowded.organ.pipes[0]) / crowded.pipe_width_px(crowded.organ.pipes[-1])
              - crowded.natural_width_px(crowded.organ.pipes[0]) / crowded.natural_width_px(crowded.organ.pipes[-1])) < 1e-9)

    print("\n== phone landscape ==")
    landscape = seeded(844, 390)
    check("block is on screen in landscape", 60 < landscape.block_y < 390, f"blockY {landscape.block_y:.0f}")
    for index, pipe in enumerate(landscape.organ.pipes):
        check(f"landscape pipe {index} top is on screen",
              landscape.block_y - landscape.pipe_height_px(pipe) >= 0)

    print()
    if FAILURES or contract:
        print(f"SELFCHECK FAILED: {len(FAILURES)} behavioural, {len(contract)} contract")
        return 1
    print("SELFCHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
