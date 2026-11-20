#!/usr/bin/env bash
# AlphaDesk 一键启动：broker 同时提供面板与账本 API；员工由 broker 拉起独立的 dsh headless 会话
set -euo pipefail
cd "$(dirname "$0")"

# 本地 .env（gitignored）：模型 Key / DSH_BIN / PANEL_TOKEN
if [ -f .env ]; then set -a; . ./.env; set +a; fi

# hithink-finance skill: secrets and local CLI
if [ -f runtime/secrets/hithink-finance.env ]; then set -a; . runtime/secrets/hithink-finance.env; set +a; fi
if [ -d runtime/hithink-cli/node_modules/.bin ]; then export PATH="$PWD/runtime/hithink-cli/node_modules/.bin:$PATH"; fi

PORT="${PORT:-7801}"
HOST="${HOST:-127.0.0.1}"

if ! command -v node >/dev/null 2>&1; then
  echo "[start] 缺少 node：需要 Node.js 18+（https://nodejs.org）" >&2
  exit 1
fi

# dsh 是员工运行本体：DSH_BIN > PATH > macOS App 自带路径
if [ -z "${DSH_BIN:-}" ]; then
  CAND="$(command -v dsh || true)"
  if [ -n "$CAND" ]; then DSH_BIN="$CAND"; fi
fi
if [ -z "${DSH_BIN:-}" ] && [ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" ]; then
  DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
fi
if [ -z "${DSH_BIN:-}" ]; then
  echo "[start] 警告：未找到 dsh —— 面板可看可配，但员工无法启动（用 DSH_BIN=/path/to/dsh 指定）" >&2
else
  export DSH_BIN
  echo "[start] dsh = $DSH_BIN"
fi

if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ] && [ -z "${PANEL_TOKEN:-}" ]; then
  echo "[start] 警告：HOST=$HOST 且没设 PANEL_TOKEN —— 同网段任何人都能读写账本、下载文件" >&2
  echo "[start]       建议：PANEL_TOKEN=换成你的口令 ./start.sh" >&2
fi

ARGS=(--port "$PORT" --host "$HOST")
if [ -n "${PANEL_TOKEN:-}" ]; then ARGS+=(--token "$PANEL_TOKEN"); fi

echo "[start] 面板：http://$HOST:$PORT/live"
exec node runtime/server/broker.js "${ARGS[@]}"
