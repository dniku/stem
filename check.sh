#!/usr/bin/env bash
# Acceptance checklist. Every phase runs or fails the build: a phase that cannot
# run is a red result, never a skip. Printing ALL CHECKS PASSED after having
# executed nothing is worse than erroring, because it describes the code as
# verified when nothing was.
#
# Run inside the pinned toolchain:  nix develop --command ./check.sh
set -uo pipefail
cd "$(dirname "$0")"

NODE=${NODE:-$(command -v node || true)}
STATUS=0
report() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; STATUS=1; }

# --engine picks the browser for the browser phases; --update rewrites the
# golden baselines, which is a developer action and never a CI one.
ENGINE=firefox
ARGS=()
for ((i = 1; i <= $#; i++)); do
  case "${!i}" in
    --engine) i=$((i + 1)); ENGINE="${!i:-}" ;;
    *) ARGS+=("${!i}") ;;
  esac
done
[[ -z $ENGINE ]] && { echo "--engine needs a value" >&2; exit 2; }
case $ENGINE in firefox|chromium|webkit) ;; *) echo "--engine must be firefox, chromium or webkit" >&2; exit 2 ;; esac

PYTHON=${PYTHON:-$(command -v python3 || true)}
if [[ -z $NODE ]]; then
  fail "node is not on PATH. Run: nix develop --command ./check.sh"
  exit $STATUS
fi

# Test scratch space. A fresh checkout (CI) has none, and a redirect into a
# missing directory fails before the command runs, which would report a harness
# error rather than a test result.
mkdir -p .tmp

# 1. Build. The tests read the artifact, so a stale artifact must never pass.
report "1/6 build artifact"
if "$NODE" tools/build.mjs; then :; else fail "build failed"; fi

# 2. Syntax and self-containment, per file so an error localises to the file
#    that has it rather than to whichever test imported it first.
#
#    The Python pass runs first and needs nothing but python3: bracket balance,
#    unterminated literals, leftover module keywords, and duplicate top-level
#    names in the bundle's single scope. When node itself is unavailable, this is
#    the difference between "the artifact cannot parse" and no idea why.
report "2/6 syntax"
for file in src/*.js tools/*.mjs tests/*.mjs; do
  if ! "$NODE" --experimental-vm-modules -e '
    const fs = require("fs"), vm = require("vm");
    const file = process.argv[1];
    try { new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file }); }
    catch (e) { console.error(`${file}: ${e.message}`); process.exit(1); }
  ' "$file"; then
    fail "syntax error in $file"
  fi
done
if [[ -n $PYTHON ]]; then
  "$PYTHON" tools/check-syntax.py || fail "structural JS check failed"
  # Scans the bundle as it is actually shipped, which is the only way to catch a
  # truncation introduced by the bundler rather than by a source file.
  "$PYTHON" tools/check-bundle.py || fail "the built bundle does not scan as complete JavaScript"
else
  fail "python3 is not on PATH; tools/check-syntax.py cannot run"
fi
"$NODE" tools/check-artifact.mjs || fail "artifact self-containment check failed"

# 2b. Builder parity. Two implementations produce this artifact -- node (the
#     authority CI hashes) and a python3 port for machines that cannot run node.
#     They are only worth having if they agree byte for byte; a difference means
#     the local preview and the shipped file are different apps, and nothing else
#     here would notice.
report "2b/6 builder parity"
# Write the python port to a file rather than piping it inside a `!` condition:
# negation would make an interpreter error (a bad import, a crashed builder)
# look exactly like a byte-identical artifact, which is the one thing this phase
# must never do.
PARITY=.tmp/parity-artifact.html
if [[ -z $PYTHON ]]; then
  fail "python3 is not on PATH; builder parity cannot be checked"
elif "$PYTHON" tools/build_preview.py --stdout > "$PARITY" 2> .tmp/parity-error.log; then
  if diff "$PARITY" index.html; then
    echo "python port reproduces the artifact byte for byte"
  else
    fail "the python builder and the committed artifact differ (rebuild with node and re-check the port)"
  fi
else
  tail -5 .tmp/parity-error.log
  fail "the python builder did not run; parity is unverified, not passed"
fi

# 3. Model self-check, in plain Python. This is the one phase that runs with no
#    node and no browser, so the gesture rules and the acoustics stay covered on a
#    machine that cannot reach the pinned toolchain at all. It also guards its own
#    assumptions about src/app.js, so it cannot quietly drift into asserting a
#    rule the app no longer implements.
report "3/6 model self-check (python)"
if [[ -z $PYTHON ]]; then
  fail "python3 is not on PATH; the model self-check cannot run"
elif ! "$PYTHON" tools/selfcheck.py > .tmp/selfcheck.log 2>&1; then
  tail -40 .tmp/selfcheck.log; fail "model self-check failed"
else
  grep -cE '^  ok ' .tmp/selfcheck.log | xargs -I{} echo "{} behavioural assertions passed"
fi

# 4. Acoustics. The part everything else depends on, tested without a browser.
report "4/6 acoustics"
if "$NODE" tests/acoustics.test.mjs > .tmp/acoustics.log 2>&1; then
  grep -E '^# (pass|fail)' .tmp/acoustics.log
else
  tail -40 .tmp/acoustics.log; fail "acoustics tests failed"
fi

# 4. Interaction. Drives the loaded artifact and checks observable behaviour.
report "5/6 interaction (engine: $ENGINE)"
if "$NODE" tests/interaction.test.mjs --engine "$ENGINE" > .tmp/interaction.log 2>&1; then
  grep -E '^# (pass|fail)' .tmp/interaction.log
else
  tail -40 .tmp/interaction.log; fail "interaction tests failed ($ENGINE)"
fi

# 5. Goldens. Byte comparison against reviewed baselines.
report "6/6 golden screenshots (engine: $ENGINE)"
if "$NODE" tests/golden.test.mjs --engine "$ENGINE" "${ARGS[@]+"${ARGS[@]}"}" > .tmp/golden.log 2>&1; then
  tail -6 .tmp/golden.log
else
  tail -40 .tmp/golden.log; fail "golden screenshots changed or missing ($ENGINE)"
fi

echo
if [[ $STATUS -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "CHECKS FAILED"; fi
exit $STATUS
