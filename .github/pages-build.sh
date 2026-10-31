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
  local bar="<div style=\"position:fixed;right:12px;bottom:12px;z-index:9999;font:13px/1.4 system-ui,sans-serif;background:#1f2937;color:#e5e7eb;padding:8px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.25)\">$html</div>"
  BAR="$bar" perl -0pi -e 's#</body>#$ENV{BAR}\n</body>#' "$file"
  # Tab-Symbol nachrüsten, falls der gebaute Stand noch keins hat (Releases vor 0.2.6)
  grep -q 'rel="icon"' "$file" || perl -0pi -e 's#</head>#  <link rel="icon" type="image/svg+xml" href="icons/icon.svg">\n</head>#' "$file"
}

rm -rf "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Release (Startseite)
git archive "$TAG" | tar -x -C "$TMP"
copy_app "$TMP" "$OUT"
cp "$OUT/popup.html" "$OUT/index.html"
add_bar "$OUT/index.html" "Version ${TAG#v} · <a href=\"live/\" style=\"color:#7dd3fc;font-weight:600\">👀 Neugierig? Hier geht's zur Vorschau →</a>"

# Live (main = aktueller Checkout)
copy_app . "$OUT/live"
cp "$OUT/live/popup.html" "$OUT/live/index.html"
add_bar "$OUT/live/index.html" "🧪 Vorschau (Stand $(git rev-parse --short HEAD)) · frisch aus dem Labor, kann noch blubbern · <a href=\"../\" style=\"color:#7dd3fc;font-weight:600\">← zur stabilen Version ${TAG#v}</a>"

touch "$OUT/.nojekyll"
echo "Release $TAG → $OUT/, main $(git rev-parse --short HEAD) → $OUT/live/"
