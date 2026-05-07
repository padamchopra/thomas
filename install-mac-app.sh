#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_SCRIPT="${ROOT_DIR}/macos/ConductorMenu/build-app.sh"
SOURCE_APP="${ROOT_DIR}/macos/ConductorMenu/.build/ConductorMenu.app"
DEST_APP="${CONDUCTOR_MAC_APP_DEST:-/Applications/Conductor.app}"
OPEN_AFTER_INSTALL=1
BUNDLE_ID="dev.conductor.cli.menu"

usage() {
  cat <<'USAGE'
Usage:
  ./install-mac-app.sh [--no-open] [--dest <app-path>]

Builds the native macOS menu bar app and installs it to:
  /Applications/Conductor.app

Options:
  --no-open        Install without launching the app afterward
  --dest <path>    Install to a custom .app path
  -h, --help       Show this help

Environment:
  CONDUCTOR_MAC_APP_DEST=/path/App.app   Default install destination
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-open)
      OPEN_AFTER_INSTALL=0
      shift
      ;;
    --dest)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --dest" >&2
        exit 1
      fi
      DEST_APP="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The macOS menu app can only be built and installed on macOS." >&2
  exit 1
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "Missing Swift toolchain. Install Xcode or Xcode Command Line Tools." >&2
  exit 1
fi

if [[ ! -x "${BUILD_SCRIPT}" ]]; then
  echo "Missing build script: ${BUILD_SCRIPT}" >&2
  exit 1
fi

"${BUILD_SCRIPT}" >/dev/null

if [[ ! -d "${SOURCE_APP}" ]]; then
  echo "Build did not create app bundle: ${SOURCE_APP}" >&2
  exit 1
fi

osascript -e "tell application id \"${BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true

mkdir -p "$(dirname "${DEST_APP}")"
rm -rf "${DEST_APP}"
ditto "${SOURCE_APP}" "${DEST_APP}"

echo "Installed Conductor menu app -> ${DEST_APP}"

if [[ "${OPEN_AFTER_INSTALL}" -eq 1 ]]; then
  open "${DEST_APP}"
  echo "Launched Conductor menu app."
fi
