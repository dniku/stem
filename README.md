# Stem

**Cut your own organ pipes, and let the air column decide the pitch.**

An interactive bench of *stopped flue pipes* — tubes closed at the foot and open at the top. Every pipe on screen is a real quarter-wave resonator: its length, its width and the air temperature produce the pitch you hear, computed rather than played back. Nothing is animated and no sound is sampled.

Open [`index.html`](index.html) in any modern browser. It is one self-contained file — no network, no build step, no storage — so it works offline and inside a sandboxed `iframe`.

Try it without cloning: <https://rawcdn.githack.com/dniku/stem/main/index.html>
(verified byte-identical to `index.html`; that's somebody else's CDN in front of
this repo, so treat it as a demo path and the file in the repo as the artifact).

## What you are looking at

A stopped pipe can only hold an **odd** number of quarter-wavelengths, so its pitch is

> **pitch = speed of sound ÷ (4 × length)**

and that single line is responsible for everything the instrument does.

The picture is not decoration. Inside each pipe is the **pressure standing wave**, `cos(k·π·s/2)`, plotted as the function itself: a full bulge at the closed foot, a node at the open mouth, and one more node every time the pipe is forced into a higher register. The label above each pipe states its measured length, its bore and its register, all read from the same object the audio reads — so what you see cannot disagree with what you hear.

## Controls

| Gesture | Effect | Why it behaves that way |
|---|---|---|
| **Drag up from the block** | Cut a new pipe | Length is the denominator: twice as long is an octave lower. |
| **Touch a pipe** (hold) | Blow it | A held note is one oscillator at that pipe's frequency. |
| **Drag a pipe sideways** | Change its bore | A wider mouth makes the pipe *acoustically longer*, so a fat pipe sits **flat** of its measured length. |
| **Drag the brass mouth tab** | Move the windhole | Low = flutey, high = stringy: where the windhole sits decides which partials get excited. |
| **Flick a pipe up hard** | Overblow it | It jumps a **twelfth (3×), not an octave** — a closed pipe has no even partials. The wave gains a node. |
| **Double-tap / double-click** | Remove a pipe | — |
| **Air temperature** slider | Retunes the whole rack | `c = 331.3·√(1 + T/273.15)`: warmer air is faster air, so every pipe goes sharp *together*. |
| **Tune-lock** | Snap to semitones / free | Off, pipes sit exactly where you cut them and neighbours **beat** at their difference. |

On a phone the explanation is a bottom sheet and the gesture reminders sit over
the top of the bench; both are click-through, so the block you drag from stays
usable underneath them, and Close (or Escape) dismisses the sheet without taking
the controls with it.

The most rewarding thing to try: turn tune-lock off, cut two pipes in the same column a few pixels apart, and blow both. You hear the beat frequency, which is literally `|f₁ − f₂|`.

## The physics, and where it is honest

- **Speed of sound** `c = 331.3·√(1 + T/273.15)` m/s. Checked against published values at 0 °C (331.3) and 20 °C (343.2).
- **Resonance** `fₙ = (2n−1)·c / 4·L_eff`. The odd multiple is why a stopped pipe sounds an octave below an open pipe of the same length.
- **End correction** `L_eff = L + 0.6r`. The air just outside the open end moves with the air inside, so a pipe speaks *flat* of its measured length — and a wide pipe more than a narrow one. This is why the bore control changes pitch at all.
- **Registers are 1×, 3×, 5×** — exactly, so the second register is 1901.955 cents: an octave plus a just fifth. A stopped pipe's "octave" is not an octave.
- **Tone colour** comes from partial amplitudes `n^−(1.4−1.1·footprint)`, with even partials exactly zero. Moving the windhole changes the mix, which is audible as well as visible.
- **Temperament**: tune-lock cuts pipes to *equal temperament*, so the rack's G3 sits 1.955 cents flat of the twelfth that same pipe would naturally sound. That gap is real, and it is the reason tune-lock is a toggle rather than a certainty.

Two things are deliberately not modelled: a real pipe's tone also depends on wind pressure and the flue's geometry beyond the windhole position, and the resonances are treated as perfectly harmonic (real pipes deviate slightly, which is called *inharmonicity* and makes their octaves wide).

## Running it

Open `index.html` directly — `file://`, a local server, or an opaque-origin `iframe` with scripts allowed. There is no server component, no dependency on sibling files, and it uses no browser storage (which a sandboxed frame would deny anyway).

Audio needs a user gesture, as browsers require: **the first touch of the bench starts it.** If a browser refuses audio entirely, the app says so and stays fully usable — the picture and the numbers carry everything.

## Development

Source lives in `src/`: `src/acoustics.js` (the physics, no DOM), `src/audio.js` (Web Audio), `src/app.js` (layout, gestures, rendering), `src/page.html` and `src/styles.css`. Tooling is in `tools/`, tests in `tests/`.

The artifact is a **build product committed beside its sources**, generated by concatenating the modules into one classic inline script — module scripts are blocked from `file://` and from an opaque origin, so the JavaScript has to be inline.

```bash
# Everything, in the pinned toolchain: build, syntax, parity, model, browser, goldens
nix develop --command ./check.sh

# Another engine. In this container Firefox is the only one that starts:
# Chromium dies in its setuid sandbox helper (`shutdown: Operation not
# permitted`) and WebKit in IPC socket adoption, so `--engine chromium` fails
# with that reason rather than testing something else.
nix develop --command ./check.sh --engine chromium

# Regenerate golden baselines -- a developer action, never a CI one
nix develop --command ./check.sh --update
```

**If `nix` cannot reach a daemon**, `./tools/with-store-toolchain.sh ./check.sh`
runs the same kind of toolchain from the paths already in `/nix/store`
(node 22, Playwright 1.64.1, its browsers) with no daemon and no network. It is
a PATH shim over whatever those store paths currently hold, not a guarantee of
the versions `nix develop` would resolve -- the repo has no `flake.lock`, so
nothing pins either. See the reproducibility note under CI.

`tools/build_preview.py` regenerates `index.html` with nothing but `python3`.
`tools/build.mjs` is the authoritative bundler, phase 2b requires the two to
agree byte for byte, and CI asserts the committed artifact matches a rebuild.

## Tests

Six phases, all of which **fail** rather than skip when a tool, a baseline or an interpreter is missing — a suite that prints success after painting nothing is worse than a red build.

1. **Build** the artifact. Tests read it, so a stale one can never pass.
2. **Syntax and self-containment**: per-file parse; bracket balance, unterminated literals, leftover `import`/`export` and duplicate top-level names via `tools/check-syntax.py` (python3 only); a scan of the **shipped bundle** for a truncation introduced by the bundler itself (`tools/check-bundle.py`, python3 only); no external references, no storage APIs, both font faces present as `data:font/woff2`.
3. **Model self-check** (`tools/selfcheck.py`): 40+ behavioural assertions — the gesture rules and the acoustics — with **no node and no browser**. It also asserts its own assumptions about `src/app.js`, so it cannot quietly drift into checking a rule the app no longer implements.
4. **Acoustics**: reference values and named behaviours in plain node.
5. **Interaction**: drives the built artifact with real browser input and asserts observable state — cutting adds a pipe whose pitch is `c/4L` for the length drawn, widening the bore drops the pitch, a firm flick multiplies it by exactly 3, a small drag changes nothing, temperature shifts every pipe by the same ratio.
6. **Golden screenshots**: per-engine baselines (there is no cross-engine fallback, because engines disagree about sub-pixel text layout and such a diff means nothing), decoded to RGBA before comparison so an RGB and an RGBA capture of the same frame compare equal.

Baselines live in `tests/golden/firefox/` and are regenerated by
`node tests/golden.test.mjs --engine firefox --update`, a developer action that is
never a CI one: the suite fails rather than silently repainting a baseline it
disagrees with.

### What it actually looks like

Captured from the built artifact in Firefox, at the three viewports it is designed for.

| Desktop, first run | Phone, portrait | Phone, landscape |
|---|---|---|
| ![Desktop first run, the explanation open beside the bench](docs/first-run.png) | ![Phone in portrait, the explanation sheet over the bench](docs/phone-portrait.png) | ![Phone in landscape, the bench with its controls](docs/phone-landscape.png) |

An overblown pipe — the register-2 standing wave, with the label and status naming
the twelfth:

![A pipe overblown into register 2](docs/overblown.png)

## Verification status

**The full checklist passes here, in a real browser.** `./check.sh --engine firefox`
runs green: build, syntax, builder parity, model self-check, acoustics, 14
interaction tests, and 8 golden screenshots that were each looked at individually.

| Phase | Result |
|---|---|
| 1 Build | node bundler produces `index.html`; the python port reproduces it byte for byte |
| 2 Syntax | per-file parse under node's `vm`; structural check; shipped-bundle scan |
| 2b Builder parity | python port is byte-identical to the committed artifact |
| 3 Model self-check | 46 behavioural assertions, no node and no browser |
| 4 Acoustics | 9 tests |
| 5 Interaction | 14 tests driving the built artifact in Firefox 157 |
| 6 Goldens | 8 states, byte-identical to reviewed baselines |

Getting there found real bugs that no assertion had caught, all confirmed by
looking at a rendered page or by driving it with real input: a landscape canvas
that overflowed its box and swallowed taps on the control bar, a translucent
explanation sheet that let the bench show through its own text, the gesture
reminders covering the tallest pipe's label, a startup message claiming a note was
sounding when none was, a brass lip that was drawn wider than it was grabbable,
two wrong assertions in the acoustics test, and a builder that did not build.

What is still **not** verified:

- **Chromium and WebKit.** Baselines exist for Firefox only. Cross-engine goldens
  are deliberately not faked with a fallback, because engines disagree about
  sub-pixel text layout and such a diff means nothing.
- **Sound.** Nothing here listens to the audio output; the audio engine is checked
  through the amplitudes and voice bookkeeping it exposes, not through what a
  listener hears.
- **Real touch hardware.** Playwright's mobile emulation (`hasTouch`, `isMobile`,
  `deviceScaleFactor: 2`) is used, but gestures are delivered as mouse input, and
  the browser's touchscreen API is unimplemented in Firefox. Synthetic
  `PointerEvent`s were tried first and proved misleading — they have no active
  pointer id, so they exercise a different path than a finger does.
- **A pinned toolchain.** There is no `flake.lock`, so `nix develop` re-resolves
  nixpkgs; CI and a local machine can therefore run different node/Playwright
  builds, and the goldens only mean identical pixels within one of them.

Run `nix develop --command ./check.sh` (or, on a machine where nix cannot reach a
daemon, `./tools/with-store-toolchain.sh ./check.sh`, which finds a node and
Playwright already in `/nix/store`) to reproduce.

## CI

[`.github/workflows/check.yml`](.github/workflows/check.yml) runs the same toolchain definition and the same `./check.sh` as local development, not a second recipe — a CI that defines "correct" differently from the local shell is a CI that drifts. It additionally builds `packages.default` and requires the result to match the committed `index.html`, because `nix develop` alone never builds the package.

**Reproducibility caveat.** There is no committed `flake.lock`, so `nix build`
and `nix develop` re-resolve nixpkgs on each run. The artifact check is still
meaningful because it rebuilds from this checkout inside the same job, so it
catches a stale or hand-edited `index.html` whatever the toolchain; the weaker
claim is the golden screenshots, which compare pixels painted by whatever
Firefox that run resolved. Committing a lockfile (`nix flake lock`) closes the
gap. It was never generated before 2026-11-04 because the flake did not parse.

The workflow has run green on GitHub Actions, and the log was read to confirm the
phases actually executed rather than skipped: six phases, 46 behavioural
assertions, 9 acoustics and 14 interaction tests passing, all 8 Firefox
goldens, and `nix build` producing an `index.html` whose SHA-256 equals the
committed one. Green is not evidence that checks ran, so this is a log check,
not a badge check.

That CI run is also what found the flake bug: `flake.nix` had never parsed
(missing closing brace on `outputs`), and no local check could see it, because
every local check goes through a `/nix/store` PATH shim that never asks nix to
evaluate the flake.

## Fonts

Text is set in a subset of DejaVu Sans, embedded as two WOFF2 faces (Regular and Bold, ~15 KiB and ~14 KiB). The artifact owns its fonts because `system-ui` resolves to whatever a host provides — this container ships one font, a runner ships another, and full-page screenshots would then disagree for reasons that have nothing to do with the app. Glyph coverage is a build-time contract: every printable character in the app's own source must have a glyph, asserted by reading the subset back, since a missing glyph falls back silently and only on machines with different fonts.
