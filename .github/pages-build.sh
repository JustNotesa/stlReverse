#!/usr/bin/env bash
# Baut die Web-Version für GitHub Pages:
#   /       = neuester Release (höchster Tag v*), hat Vorrang
#   /live/  = aktueller Stand von main (unveröffentlicht, kann wackeln)
# Aufruf aus dem Repo-Root: .github/pages-build.sh [ausgabeordner]   (Standard: _site)
set -euo pipefail
OUT="${1:-_site}"
TAG="$(git tag --list 'v*' --sort=-v:refname | head -1)"
[ -n "$TAG" ] || { echo "kein Release-Tag v* gefunden" >&2; exit 1; }

# kopiert die App-Dateien aus Ordner $1 nach $2 (keine Tests/Samples)
copy_app() {
  local src="$1" dst="$2"
  mkdir -p "$dst"
  for f in "$src"/*.js; do
    case "$(basename "$f")" in background.js|segmentation.js) ;; *) cp "$f" "$dst/" ;; esac
  done
  cp "$src/popup.html" "$src/popup.css" "$dst/"
  cp -r "$src/libs" "$src/icons" "$dst/"
}

# fügt vor </body> einen kleinen Hinweis-Streifen ein (nur in der index.html der Webseite)
add_bar() {
  local file="$1" html="$2"
  local bar="<div style=\"position:fixed;right:12px;bottom:12px;z-index:9999;font:12px/1.4 system-ui,sans-serif;background:rgba(20,20,20,.82);color:#fff;padding:6px 10px;border-radius:6px\">$html</div>"
  BAR="$bar" perl -0pi -e 's#</body>#$ENV{BAR}\n</body>#' "$file"
}

rm -rf "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Release (Startseite)
git archive "$TAG" | tar -x -C "$TMP"
copy_app "$TMP" "$OUT"
cp "$OUT/popup.html" "$OUT/index.html"
add_bar "$OUT/index.html" "Version ${TAG#v} · <a href=\"live/\" style=\"color:#9cf\">Live-Version (neuester Stand, ungetestet)</a>"

# Live (main = aktueller Checkout)
copy_app . "$OUT/live"
cp "$OUT/live/popup.html" "$OUT/live/index.html"
add_bar "$OUT/live/index.html" "Live-Version $(git rev-parse --short HEAD) · kann Fehler enthalten · <a href=\"../\" style=\"color:#9cf\">zur Release-Version ${TAG#v}</a>"

touch "$OUT/.nojekyll"
echo "Release $TAG → $OUT/, main $(git rev-parse --short HEAD) → $OUT/live/"
