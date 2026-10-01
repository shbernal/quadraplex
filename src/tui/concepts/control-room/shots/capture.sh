#!/usr/bin/env bash
# Captures the control room at fixed sizes against the real local store. vhs on this
# machine writes frames but its gif and Screenshot encoders output nothing, and it writes
# nothing under a dot directory such as .claude/, so each tape runs from a temp dir and
# its last text frame stands in for the screenshot.
set -euo pipefail
shots="$(cd "$(dirname "$0")" && pwd)"
export CR="$(dirname "$shots")"
work="$(mktemp -d)"
cd "$work"

# name cols rows width height keys (vhs commands, ";" separated)
shot() {
  local name=$1 cols=$2 rows=$3 w=$4 h=$5 keys=${6:-}
  {
    echo "Output frames-$name/"
    echo 'Set FontFamily "JetBrainsMono Nerd Font"'
    echo 'Set FontSize 16'
    echo "Set Width $w"
    echo "Set Height $h"
    echo 'Set Padding 12'
    echo 'Set Theme "Catppuccin Mocha"'
    echo 'Hide'
    echo "Type \"cd \$CR && stty cols $cols rows $rows && clear && bun run main.ts\""
    echo 'Enter'
    echo 'Sleep 2500ms'
    tr ';' '\n' <<<"$keys" | sed '/^$/d;s/$/\nSleep 250ms/'
    echo 'Show'
    echo 'Sleep 500ms'
    echo 'Hide'
    echo 'Ctrl+C'
  } >"$name.tape"
  vhs "$name.tape" >/dev/null 2>&1 || true
  cp "$(ls "frames-$name"/frame-text-*.png | sort | tail -1)" "$shots/$name.png"
  echo "$shots/$name.png"
}

shot control-room-80x24 80 24 920 580
shot control-room-80x24-registries 80 24 920 580 'Tab;Type "jj"'
shot control-room-80x24-legend 80 24 920 580 'Type "?"'
shot control-room-120x40 120 40 1360 920
shot control-room-140x45 140 45 1580 1030
shot control-room-140x45-detail 140 45 1580 1030 'Type "j";Type "j";Type "j";Enter'
rm -rf "$work"
