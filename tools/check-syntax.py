#!/usr/bin/env python3
"""Structural JavaScript checks that need no Node.

This is a checker, not a parser: it catches what a careful reading misses after a
paste -- unbalanced brackets, an unterminated template literal, a `const` left
behind by the export-stripping bundler, two modules declaring the same top-level
name in the shared bundle scope. It cannot catch a bad identifier or a type
error, which is what `node --experimental-vm-modules` does in check.sh.

It exists for sessions where Node is unavailable: the pinned toolchain comes from
a Nix daemon plus a network, and when either is missing the project should still
be checkable rather than simply unverifiable.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["src/acoustics.js", "src/audio.js", "src/app.js"]


def blank_noise(text: str) -> tuple[str, list[str]]:
    """Replace comments, strings, template literals and regex literals with spaces.

    Bracket counting then sees only the brackets that are code. Returns the
    rewritten text and any lexical problem found on the way, since "the file ends
    inside a template literal" is exactly the class of bug being looked for.
    """
    out: list[str] = []
    problems: list[str] = []
    i, n = 0, len(text)
    line = 1

    def advance_to(index: int) -> None:
        nonlocal i, line
        line += text.count("\n", i, index)
        out.append(" " * (index - i))
        i = index

    while i < n:
        char = text[i]
        if char == "/" and text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                problems.append(f"unterminated block comment starting at line {line}")
                break
            advance_to(end + 2)
            continue
        if char == "/" and text.startswith("//", i):
            end = text.find("\n", i)
            advance_to(n if end < 0 else end)
            continue
        if char in "\"'":
            quote, start = char, line
            j = i + 1
            while j < n and text[j] != quote:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "\n":
                    break
                j += 1
            if j >= n or text[j] != quote:
                problems.append(f"unterminated string starting at line {start}")
                break
            advance_to(j + 1)
            continue
        if char == "`":
            start, depth = line, 0
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text.startswith("${", j):
                    depth += 1
                    j += 2
                    continue
                if depth and text[j] == "}":
                    depth -= 1
                    j += 1
                    continue
                if text[j] == "`" and depth == 0:
                    break
                j += 1
            if j >= n:
                problems.append(f"unterminated template literal starting at line {start}")
                break
            advance_to(j + 1)
            continue
        out.append(char)
        if char == "\n":
            line += 1
        i += 1
    return "".join(out), problems


def check_balancing(code: str) -> list[str]:
    pairs = {")": "(", "]": "[", "}": "{"}
    stack: list[tuple[str, int]] = []
    problems: list[str] = []
    line = 1
    for char in code:
        if char == "\n":
            line += 1
        elif char in "([{":
            stack.append((char, line))
        elif char in ")]}":
            if not stack:
                problems.append(f"unmatched closing {char!r} at line {line}")
                break
            opened, opened_line = stack.pop()
            if opened != pairs[char]:
                problems.append(f"{char!r} at line {line} closes {opened!r} opened at line {opened_line}")
                break
    if stack and not problems:
        opened, opened_line = stack[0]
        problems.append(f"unclosed {opened!r} opened at line {opened_line}")
    return problems


def main() -> int:
    problems: list[str] = []
    declared: dict[str, str] = {}  # symbol -> where it was first declared
    for rel in FILES:
        path = ROOT / rel
        if not path.exists():
            problems.append(f"{rel} is missing")
            continue
        code, lexical = blank_noise(path.read_text())
        problems.extend(f"{rel}: {problem}" for problem in lexical)
        problems.extend(f"{rel}: {problem}" for problem in check_balancing(code))
        for match in re.finditer(r"^(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)", code, re.M):
            symbol, line = match.group(1), code[: match.start()].count("\n") + 1
            where = f"{rel}:{line}"
            if symbol in declared:
                # A duplicate is fatal in either direction. Across files it is
                # fatal because the bundle is one scope; within a file `const x`
                # twice is a SyntaxError on its own. (`var` and `function` may
                # legally redeclare, but never do here, and flagging it is the
                # safer default for a bundler this simple.)
                problems.append(f"top-level name {symbol!r} declared twice: {declared[symbol]} and {where}")
            declared[symbol] = where
        # The bundler strips these; anything left over is a form it does not
        # understand, which would ship a script the browser refuses to parse.
        if re.search(r"^\s*(export|import)\b", code, re.M):
            problems.append(f"{rel}: still contains a module keyword the bundler should have removed")

    print(f"checked {len(FILES)} files, {len(declared)} top-level declarations")
    if problems:
        print("SYNTAX PROBLEMS:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("JS structural check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
