#!/usr/bin/env bash
# Records each tape to a frame directory and keeps its last frame as the PNG. On this
# machine vhs writes frames but its gif and Screenshot encoders output nothing, and it
# writes nothing at all under a dot directory such as .claude/, so it runs from a temp
# dir and the last text frame, which carries the background, stands in for a screenshot.
set -euo pipefail
shots="$(cd "$(dirname "$0")" && pwd)"
export ATTN="$(dirname "$shots")"
work="$(mktemp -d)"
cd "$work"
for name in board-80x24 board-120x40 board-80x24-evidence; do
  vhs "$shots/$name.tape" >/dev/null 2>&1 || true
  last=$(ls "frames-$name"/frame-text-*.png | sort | tail -1)
  cp "$last" "$shots/$name.png"
  echo "$shots/$name.png"
done
rm -rf "$work"
