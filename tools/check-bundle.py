#!/usr/bin/env python3
"""Structurally validate the inline bundle in index.html, with no node required.

tools/check-artifact.mjs does the definitive parse with node's vm, and that is
the right tool when the pinned toolchain is available. This exists because it is
not always: a bundle produced by a concatenating bundler has one characteristic
failure, which is a module boundary that leaves a template literal, a block
comment, or a brace open. That is detectable by scanning the shipped bytes, and
detecting it here is the difference between "the artifact cannot run" and no idea
why the browser shows a blank page.

It is a scanner, not a JavaScript parser: it deliberately knows enough lexical
structure to keep strings, template literals, comments and regular-expression
literals out of the brace count, and nothing more. It cannot say the code is
*correct*, only that it is not visibly truncated or unbalanced.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ARTIFACT = ROOT / "index.html"

# Words that may legally be followed by a '/' that starts a regex rather than a
# division: whatever precedes the slash must be a value for it to be division.
REGEX_PRECEDERS = {"return", "typeof", "instanceof", "in", "of", "new", "case",
                   "delete", "void", "throw", "do", "else", "yield", "await"}


def inline_scripts(html: str) -> list[str]:
    """The bodies of the artifact's inline <script> elements, in order."""
    return [m.group(1) for m in re.finditer(r"<script>([\s\S]*?)</script>", html)]


def _scan_template(source: str, index: int, line: int, label: str) -> tuple[list[str], int, int]:
    """Scan a template literal starting at source[index] == '`'.

    Returns (problems, index just past the closing backtick, line). Interpolated
    ${ } regions are scanned for their own balanced code, including nested
    template literals, which is what lets a `${a ? `x` : y}` inside a template
    come out correctly.
    """
    opened_on = line
    index += 1
    length = len(source)
    while index < length:
        char = source[index]
        if char == "\\":
            index += 2
            continue
        if char == "`":
            return [], index + 1, line
        if source[index: index + 2] == "${":
            inner, index, line = _scan_code(source, index + 2, line, label, until="}")
            if inner:
                return inner, index, line
            continue
        if char == "\n":
            line += 1
        index += 1
    return [f"{label}: template literal opened on line {opened_on} is never closed"], index, line


def _scan_code(source: str, index: int, line: int, label: str, until: str) -> tuple[list[str], int, int]:
    """Scan ordinary code until the matching `until` brace, tracking nesting."""
    pairs = {")": "(", "]": "[", "}": "{"}
    stack: list[str] = []
    length = len(source)
    while index < length:
        char = source[index]
        if char == "\n":
            line += 1
            index += 1
            continue
        if char == "/" and source[index + 1: index + 2] == "/":
            end = source.find("\n", index)
            index = length if end < 0 else end
            continue
        if char == "/" and source[index + 1: index + 2] == "*":
            end = source.find("*/", index + 2)
            if end < 0:
                return [f"{label}: block comment inside a template interpolation is never closed"], index, line
            line += source.count("\n", index, end)
            index = end + 2
            continue
        if char in "\"'":
            quote, opened_on = char, line
            index += 1
            while index < length and source[index] != quote:
                if source[index] == "\\":
                    index += 2
                    continue
                if source[index] == "\n":
                    return [f"{label}: string inside a template interpolation spans a newline"], index, line
                index += 1
            if index >= length:
                return [f"{label}: string opened on line {opened_on} is never closed"], index, line
            index += 1
            continue
        if char == "`":
            problems, index, line = _scan_template(source, index, line, label)
            if problems:
                return problems, index, line
            continue
        if char in "([{":
            stack.append(char)
        elif char in ")]}":
            if char == until and not stack:
                return [], index + 1, line
            if not stack or stack[-1] != pairs[char]:
                return [f"{label}: unbalanced '{char}' inside a template interpolation on line {line}"], index, line
            stack.pop()
        index += 1
    return [f"{label}: template interpolation is never closed"], index, line


def scan(source: str, label: str) -> list[str]:
    """Walk one script body once, tracking nesting and lexical state."""
    problems: list[str] = []
    depth: list[tuple[str, int]] = []          # (bracket, line it opened on)
    pairs = {")": "(", "]": "[", "}": "{"}
    line = 1
    index = 0
    length = len(source)
    previous_significant = ""

    while index < length:
        char = source[index]
        following = source[index + 1] if index + 1 < length else ""
        if char == "\n":
            line += 1
            index += 1
            continue
        # Every construct below records `line` as where it opened, so any scan
        # that runs past a newline must advance the counter itself.
        # Line comment.
        if char == "/" and following == "/":
            end = source.find("\n", index)
            index = length if end < 0 else end
            continue
        # Block comment.
        if char == "/" and following == "*":
            end = source.find("*/", index + 2)
            if end < 0:
                problems.append(f"{label}: block comment opened on line {line} is never closed")
                return problems
            line += source.count("\n", index, end)
            index = end + 2
            continue
        # Quoted string: backslash escapes, and a newline inside is an error in JS.
        if char in "\"'":
            quote, opened_on = char, line
            index += 1
            while index < length:
                if source[index] == "\\":
                    index += 2
                    continue
                if source[index] == quote:
                    break
                if source[index] == "\n":
                    problems.append(f"{label}: {quote} string opened on line {opened_on} spans a newline")
                    return problems
                index += 1
            else:
                problems.append(f"{label}: {quote} string opened on line {opened_on} is never closed")
                return problems
            index += 1
            previous_significant = quote
            continue
        # Template literal: may span lines, and ${ } nests arbitrarily.
        #
        # This must be tested before the brace cases below. A `${` occurring
        # inside a template is part of that literal, not the block brace the
        # outer loop would otherwise read it as -- consuming it there corrupts
        # the nesting stack and reports a perfectly good file as truncated.
        if char == "`":
            problems_here, index, line = _scan_template(source, index, line, label)
            if problems_here:
                problems.extend(problems_here)
                return problems
            previous_significant = "`"
            continue
        # A '/' that is a regex literal rather than division.
        if char == "/" and (previous_significant == "" or previous_significant in "=([,{;:!&|?+-*%<>~^"
                            or previous_significant in REGEX_PRECEDERS):
            opened_on = line
            index += 1
            in_class = False
            while index < length:
                current = source[index]
                if current == "\\":
                    index += 2
                    continue
                if current == "[":
                    in_class = True
                elif current == "]":
                    in_class = False
                elif current == "/" and not in_class:
                    break
                elif current == "\n":
                    problems.append(f"{label}: regex opened on line {opened_on} spans a newline")
                    return problems
                index += 1
            else:
                problems.append(f"{label}: regex literal opened on line {opened_on} is never closed")
                return problems
            index += 1
            previous_significant = "/"
            continue
        if char in "([{":
            depth.append((char, line))
        elif char in ")]}":
            if not depth:
                problems.append(f"{label}: stray '{char}' closing nothing on line {line}")
                return problems
            opener, opened_on = depth.pop()
            if opener != pairs[char]:
                problems.append(f"{label}: '{opener}' opened on line {opened_on} is closed by '{char}' on line {line}")
                return problems
        if not char.isspace():
            previous_significant = char
        index += 1

    for opener, opened_on in depth:
        problems.append(f"{label}: '{opener}' opened on line {opened_on} is never closed")
    return problems


def main(argv: list[str]) -> int:
    html = ARTIFACT.read_text() if len(argv) < 2 else pathlib.Path(argv[1]).read_text()
    bodies = inline_scripts(html)
    if not bodies:
        print(f"FAIL: {ARTIFACT.name} has no inline <script> to check", file=sys.stderr)
        return 1
    problems: list[str] = []
    for position, body in enumerate(bodies):
        label = f"{ARTIFACT.name} script {position}"
        problems.extend(scan(body, label))
        # Top-level statements in a concatenated bundle are a scope collision:
        # every module ends up sharing one function scope.
        if "(function" not in body[:400] and "!function" not in body[:400]:
            problems.append(f"{label} is not wrapped in an IIFE, so module-level names collide")
    if problems:
        print("\n".join(f"FAIL {p}" for p in problems), file=sys.stderr)
        return 1
    total = sum(len(b.splitlines()) for b in bodies)
    print(f"bundle scan passed: {len(bodies)} inline script(s), {total} lines, balanced")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
