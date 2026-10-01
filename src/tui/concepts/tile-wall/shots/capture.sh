#!/usr/bin/env bash
# Records one vhs tape per shot and keeps its last frame as the PNG. On this machine vhs
# writes frames but its gif and Screenshot encoders output nothing, and it writes nothing
# at all under a dot directory such as .claude/, so it runs from a temp dir and the last
# text frame, which carries the background, stands in for a screenshot.
set -euo pipefail
shots="$(cd "$(dirname "$0")" && pwd)"
wall="$(dirname "$shots")"
work="$(mktemp -d)"
cd "$work"

# name cols rows width-px height-px keys...
shot() {
  local name=$1 cols=$2 rows=$3 w=$4 h=$5
  shift 5
  {
    echo "Output frames-$name/"
    echo 'Set FontSize 16'
    echo 'Set FontFamily "JetBrainsMono Nerd Font"'
    echo "Set Width $w"
    echo "Set Height $h"
    echo 'Set Padding 12'
    echo 'Set Theme "Catppuccin Mocha"'
    echo 'Hide'
    echo "Type \"cd $wall && stty cols $cols rows $rows && clear && bun run main.ts\""
    echo 'Enter'
    echo "Sleep 3s"
    for key in "$@"; do echo "$key"; done
    echo 'Sleep 400ms'
    echo 'Show'
    echo 'Sleep 500ms'
    echo 'Hide'
    echo 'Type "q"'
  } >"$name.tape"
  vhs "$name.tape" >/dev/null 2>&1 || true
  cp "$(ls "frames-$name"/frame-text-*.png | sort | tail -1)" "$shots/$name.png"
  echo "$shots/$name.png"
}

shot wall-80x24 80 24 870 565
shot wall-80x24-detail 80 24 870 565 'Right' 'Enter'
shot wall-140x45 140 45 1460 1005
shot wall-140x45-registries 140 45 1460 1005 'Tab' 'Right 2'
rm -rf "$work"
