#!/usr/bin/env bash
# The UniFFI runtime under the Breez binding (uniffi-bindgen-react-native) ships .ts sources rather
# than declarations. An imported file is always type-checked, so no `exclude` removes them, and
# skipLibCheck does not reach them because it applies only to .d.ts files. An error reported inside
# node_modules belongs to that package, so this script ignores those and fails on every other
# error, instead of silencing everything.
#
# TYPECHECK_TSCONFIG points the gate at another config, so it can be shown to fail on a broken one
# without breaking tsconfig.json.
set -uo pipefail

# tsc prints paths relative to the working directory, and the node_modules/ test below relies on it.
cd "$(dirname "$0")/.." || exit 1

output=$(npx tsc --noEmit -p "${TYPECHECK_TSCONFIG:-tsconfig.json}" 2>&1)
status=$?

if [ "$status" -ne 0 ]; then
  errors=$(grep -E 'error TS[0-9]+' <<<"$output" || true)
  # Every error outside node_modules counts, not only those under a known source directory, because a
  # config error (`tsconfig.json(2,3): error TS...`) or a global one (`error TS18003: No inputs were
  # found`) names no source file at all.
  ours=$(grep -vE '^node_modules/' <<<"$errors" || true)
  if [ -n "$ours" ]; then
    echo "$ours"
    exit 1
  fi
  # A non-zero exit with no TS error line means tsc did not run (npx failing, node crashing), and
  # that proves nothing about the types.
  if [ -z "$errors" ]; then
    echo "tsc exited with status $status without reporting a type error:"
    echo "${output:-(no output)}"
    exit 1
  fi
fi

ignored=$(grep -cE '^node_modules/.*error TS[0-9]+' <<<"$output" || true)
echo "typecheck OK ($ignored errors inside node_modules ignored)"
