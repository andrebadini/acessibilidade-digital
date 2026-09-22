#!/bin/sh
set -eu
asset_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
render_directory=$(mktemp -d "${TMPDIR:-/tmp}/audita-promo-render.XXXXXX")
trap 'rm -rf "$render_directory"' EXIT HUP INT TERM
qlmanage -t -s 440 -o "$render_directory" "$asset_directory/promo-small.svg"
swift "$asset_directory/render-promo.swift" \
  "$render_directory/promo-small.svg.png" "$asset_directory/promo-small.png"
sips -g pixelWidth -g pixelHeight -g hasAlpha "$asset_directory/promo-small.png"
