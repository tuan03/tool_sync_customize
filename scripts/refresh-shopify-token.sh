#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PYTHON_BIN="${PYTHON_BIN:-python3}"
PM2_APP_NAME="${PM2_APP_NAME:-amazon-customizer}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-}"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env.shopify}"

log() {
  printf '[refresh-shopify-token] %s\n' "$*"
}

run_token_refresh() {
  log "Refreshing Shopify Admin API token into ${ENV_FILE}"
  cd "${PROJECT_ROOT}"
  SHOPIFY_ENV_FILE="${ENV_FILE}" "${PYTHON_BIN}" shopify_codex_tool.py token-client-credentials --save
}

restart_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    return 1
  fi
  if ! pm2 describe "${PM2_APP_NAME}" >/dev/null 2>&1; then
    return 1
  fi
  log "Restarting PM2 app ${PM2_APP_NAME}"
  pm2 restart "${PM2_APP_NAME}" >/dev/null
  return 0
}

restart_systemd() {
  if [[ -z "${SYSTEMD_SERVICE_NAME}" ]]; then
    return 1
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi
  log "Restarting systemd service ${SYSTEMD_SERVICE_NAME}"
  systemctl restart "${SYSTEMD_SERVICE_NAME}"
  return 0
}

main() {
  run_token_refresh

  if restart_pm2; then
    log "Token refreshed and PM2 app restarted successfully"
    return 0
  fi

  if restart_systemd; then
    log "Token refreshed and systemd service restarted successfully"
    return 0
  fi

  log "Token refreshed. No PM2 app or systemd service was restarted."
  log "Set PM2_APP_NAME or SYSTEMD_SERVICE_NAME if you want automatic restart."
}

main "$@"
