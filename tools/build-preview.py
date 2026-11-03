#!/usr/bin/env python3
"""Write index.html from src/ using only the Python standard library.

This is a convenience port of tools/build-lib.mjs, which is the real bundler and
the one CI runs. It exists because a browser has to be launched through Nix on
some machines and not on others: whoever is iterating on the app still needs an
artifact to look like the thing that will ship. The two must agree byte for byte,
and `check.sh` regenerates the artifact with node before any test reads it, so a
drift between them is a red build rather than a silently different file.

Run `node tools/build.mjs` (or ./check.sh) to produce the authoritative copy.
"""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODULES = ["acoustics.js", "audio.js", "app.js"]
FACES = [(400, "StemSans-regular.woff2.base64"), (700, "StemSans-bold.woff2.base64")]
FAMILY = "Stem Sans"
FONT_TOKEN = "/* __FONT_FACE__ */"
CSS_TOKEN = "/* __STEM_CSS__ */"
SCRIPT_PLACEHOLDER = re.compile(r"<script>\n/\* __STEM_JS__ \*/\n</script>")


def font_face_css() -> str:
    rules = []
    for weight, filename in FACES:
        blob = (ROOT / "build" / filename).read_text().strip()
        if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", blob):
            raise SystemExit(f"{filename} is not base64")
        if base64.b64decode(blob)[:4] != b"wOF2":
            raise SystemExit(f"{filename} is not a WOFF2 file")
        rules.append(
            "@font-face {\n"
            f'  font-family: "{FAMILY}";\n'
            "  font-style: normal;\n"
            f"  font-weight: {weight};\n"
            f"  src: url(data:font/woff2;base64,{blob}) format(\"woff2\");\n"
            "}"
        )
    return "\n".join(rules)


def strip_module_syntax(source: str, name: str) -> str:
    """Drop the module forms the bundler's shared scope makes unnecessary."""
    kept = []
    for line in source.split("\n"):
        if re.match(r"^import\s+\{[^}]*\}\s+from '\.\/[^']+';?\s*$", line):
            continue
        if re.match(r"^import\s", line):
            raise SystemExit(f"{name}: unsupported import form: {line}")
        if re.match(r"^export\s+(class|function|const|let)\s", line):
            kept.append(re.sub(r"^export\s+", "", line))
            continue
        if re.match(r"^export\b", line):
            raise SystemExit(f"{name}: unsupported export form: {line}")
        kept.append(line)
    return "\n".join(kept)


def build() -> str:
    template = (ROOT / "src" / "page.html").read_text()
    styles = (ROOT / "src" / "styles.css").read_text()
    if styles.count(FONT_TOKEN) != 1:
        raise SystemExit("styles.css is missing the font-face placeholder")
    styles = styles.replace(FONT_TOKEN, font_face_css(), 1)

    sources = [(name, strip_module_syntax((ROOT / "src" / name).read_text(), name)) for name in MODULES]
    declared: dict[str, str] = {}
    for name, source in sources:
        for match in re.finditer(r"^(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)", source, re.M):
            symbol = match.group(1)
            if symbol in declared and declared[symbol] != name:
                raise SystemExit(f'top-level name "{symbol}" declared in both {declared[symbol]} and {name}')
            declared[symbol] = name
    bundle = "\n\n".join(f"// ---- src/{name} ----\n{source}" for name, source in sources)

    if not SCRIPT_PLACEHOLDER.search(template):
        raise SystemExit("template is missing the script placeholder")
    inlined = "<script>\n(function () {\n'use strict';\n\n" + bundle + "\n})();\n</script>"
    page = SCRIPT_PLACEHOLDER.sub(lambda _: inlined, template, count=1)
    if CSS_TOKEN not in page:
        raise SystemExit("template is missing the style placeholder")
    page = page.replace(CSS_TOKEN, styles, 1)
    for token in ("__STEM_JS__", "__STEM_CSS__", "__FONT_FACE__"):
        if token in page:
            raise SystemExit(f"a build placeholder survived into the artifact: {token}")
    return page


def main(argv: list[str]) -> None:
    # Output path is an argument for symmetry with tools/build.mjs, whose path
    # matters inside `nix build`; here it only ever defaults to the project root.
    out = pathlib.Path(argv[1]) if len(argv) > 1 else ROOT / "index.html"
    page = build()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    print(f"built {out} ({len(page.encode('utf-8')) / 1024:.1f} KiB) -- python port; run node tools/build.mjs for the authoritative copy")


if __name__ == "__main__":
    main(sys.argv)
