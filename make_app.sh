#!/bin/bash
# Builds "My AI Drive.app" in ~/Applications, so you can start the app from the Dock, Launchpad or Spotlight.
# Re-run it if you move this folder.
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
APP="$HOME/Applications/My AI Drive.app"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }

rm -rf "$APP"
mkdir -p "$HOME/Applications"
# A compiled AppleScript applet rather than a bare shell script: macOS only asks "Allow access to
# the Desktop folder?" for a real app binary, and this project folder may live in a protected place.
osacompile -o "$APP" -e "do shell script \"/bin/bash \" & quoted form of (POSIX path of (path to me) & \"Contents/Resources/launch.sh\")"
defaults write "$APP/Contents/Info" CFBundleIdentifier local.my-ai-drive.launcher
defaults write "$APP/Contents/Info" CFBundleName "My AI Drive"
defaults write "$APP/Contents/Info" NSDesktopFolderUsageDescription "My AI Drive starts its server from the project folder."
defaults write "$APP/Contents/Info" NSDocumentsFolderUsageDescription "My AI Drive starts its server from the project folder."
plutil -convert xml1 "$APP/Contents/Info.plist"

cat > "$APP/Contents/Resources/launch.sh" <<LAUNCHER
#!/bin/bash
# Starts the My AI Drive server if it isn't running, then opens the app in its own window.
DIR="$DIR"
LAUNCHER
cat >> "$APP/Contents/Resources/launch.sh" <<'LAUNCHER'
PORT="${PORT:-8765}"
URL="http://127.0.0.1:$PORT"
# Apps opened from the Dock get a bare PATH; borrow the login shell's so the agent (`claude`) is found.
P="$(/bin/zsh -ilc 'printf "\n%s" "$PATH"' 2>/dev/null </dev/null | tail -n 1)"
[ -n "$P" ] && export PATH="$P"
up() { curl -fs -m 1 -o /dev/null "$URL/api/settings"; }
if ! up; then
  cd "$DIR" || exit 1
  nohup .venv/bin/uvicorn server.main:app --host 127.0.0.1 --port "$PORT" >> data/server.log 2>&1 </dev/null &
  for _ in $(seq 1 80); do up && break; sleep 0.25; done
fi
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL"   # a clean window without tabs or an address bar
else
  open "$URL"
fi
LAUNCHER

# Icon: the app's logo, rendered from SVG with PyMuPDF.
TMP="$(mktemp -d)"
.venv/bin/python - "$TMP" <<'PY'
import sys, pymupdf
svg = b"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<path d="M285 100H739A185 185 0 0 1 924 285V739A185 185 0 0 1 739 924H285A185 185 0 0 1 100 739V285A185 185 0 0 1 285 100Z" fill="#2b59c3"/>
<path d="M322 236h262l148 148v404H322z" fill="#ffffff"/>
<path d="M584 236v148h148z" fill="#b9c9ee"/>
<rect x="392" y="468" width="270" height="30" rx="15" fill="#c6d4f2"/>
<rect x="392" y="540" width="270" height="30" rx="15" fill="#c6d4f2"/>
<rect x="392" y="612" width="170" height="30" rx="15" fill="#c6d4f2"/>
</svg>"""
doc = pymupdf.open(stream=svg, filetype="svg")
doc[0].get_pixmap(alpha=True).save(sys.argv[1] + "/icon.png")
PY
mkdir "$TMP/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/applet.icns"
rm -rf "$TMP"
codesign --force --deep -s - "$APP" >/dev/null 2>&1  # re-seal after changing the bundle
touch "$APP"

# Shortcuts on the Desktop and in this folder.
ln -sfn "$APP" "$HOME/Desktop/My AI Drive.app"
ln -sfn "$APP" "$DIR/My AI Drive.app"

# Pin to the Dock (once).
URL="file://$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$APP")/"
if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "My%20AI%20Drive.app"; then
  defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$URL</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  killall Dock
fi

echo "Built: $APP"
echo "The first launch asks to access the folder this project is in: click Allow."
echo "Shortcuts: your Desktop, this folder and the Dock. Spotlight finds it too (type \"My AI Drive\")."
