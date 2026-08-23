#!/usr/bin/env bash
# Renders docs/assets/demo.gif from demo.tape against your own store. vhs captures the
# frames and ffmpeg encodes them here, since vhs's own encode fails silently on ffmpeg 9.
set -euo pipefail
cd "$(dirname "$0")/.."

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

qplex refresh >/dev/null
{ echo "Output \"$work/frames/\""; cat scripts/demo.tape; } >"$work/demo.tape"
vhs "$work/demo.tape" >/dev/null
ffmpeg -y -hide_banner -loglevel error \
  -framerate 25 -i "$work/frames/frame-text-%05d.png" \
  -framerate 25 -i "$work/frames/frame-cursor-%05d.png" \
  -filter_complex "[0][1]overlay,pad=iw+40:ih+40:20:20:color=0x1e1e2e,fps=20,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  docs/assets/demo.gif
