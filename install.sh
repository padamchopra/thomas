#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${ROOT_DIR}/bin/conductor-cli.js"

if [[ ! -f "${TARGET}" ]]; then
  echo "Missing CLI entrypoint: ${TARGET}" >&2
  exit 1
fi

chmod +x "${TARGET}"

if [[ -n "${CONDUCTOR_CLI_INSTALL_DIR:-}" ]]; then
  INSTALL_DIR="${CONDUCTOR_CLI_INSTALL_DIR}"
elif [[ -d "/usr/local/bin" && -w "/usr/local/bin" ]]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

mkdir -p "${INSTALL_DIR}"
ln -sfn "${TARGET}" "${INSTALL_DIR}/conductor-cli"

echo "Installed conductor-cli -> ${INSTALL_DIR}/conductor-cli"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "Note: ${INSTALL_DIR} is not on PATH."
    echo "Add this to your shell profile:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
