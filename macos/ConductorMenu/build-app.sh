#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_PATH="$SCRIPT_DIR/.build/ConductorMenu.app"
BINARY_PATH="$SCRIPT_DIR/.build/release/ConductorMenu"

cd "$SCRIPT_DIR"
export CLANG_MODULE_CACHE_PATH="$SCRIPT_DIR/.build/module-cache"

swift build -c release

rm -rf "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources/bin"

cp "$BINARY_PATH" "$APP_PATH/Contents/MacOS/ConductorMenu"
cp "$REPO_ROOT/bin/conductor-cli.js" "$APP_PATH/Contents/Resources/bin/conductor-cli.js"
cp "$REPO_ROOT/package.json" "$APP_PATH/Contents/Resources/package.json"
chmod +x "$APP_PATH/Contents/Resources/bin/conductor-cli.js"
printf "%s\n" "$REPO_ROOT/bin/conductor-cli.js" \
  > "$APP_PATH/Contents/Resources/conductor-cli-path.txt"

cat > "$APP_PATH/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>ConductorMenu</string>
  <key>CFBundleIdentifier</key>
  <string>dev.conductor.cli.menu</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Conductor</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright 2026</string>
</dict>
</plist>
PLIST

echo "$APP_PATH"
