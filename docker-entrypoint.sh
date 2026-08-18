#!/bin/sh
set -e

SERVER_PID=""
CRON_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$OLLAMA_PID" ]; then
    kill -TERM "$OLLAMA_PID" 2>/dev/null || true
    wait "$OLLAMA_PID" 2>/dev/null || true
  fi
  if [ -n "$CRON_PID" ]; then
    kill -TERM "$CRON_PID" 2>/dev/null || true
    wait "$CRON_PID" 2>/dev/null || true
  fi
  exit 0
}

trap cleanup TERM INT

if [ "$EMBEDDED_OLLAMA" = "true" ] || [ "$EMBEDDED_OLLAMA" = "1" ]; then
  mkdir -p /app/data/models
  export OLLAMA_MODELS="/app/data/models"

  if ! command -v ollama >/dev/null 2>&1; then
    echo "[INFO] Installing Ollama standalone bundle..."
    curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh
  fi

  export OLLAMA_HOST="0.0.0.0:11434"
  ollama serve > /proc/1/fd/1 2> /proc/1/fd/2 &
  OLLAMA_PID=$!

  echo "[INFO] Waiting for local Ollama service to become ready..."
  RETRIES=0
  MAX_RETRIES=30
  until curl -sf http://127.0.0.1:11434/ >/dev/null 2>&1; do
    RETRIES=$((RETRIES + 1))
    if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
      echo "[ERROR] Timed out waiting for Ollama service to start" >&2
      exit 1
    fi
    sleep 1
  done

  TARGET_MODEL="${OLLAMA_MODEL:-phi4-mini}"
  if ! curl -sf http://127.0.0.1:11434/api/tags | grep -q "\"name\":\"${TARGET_MODEL}"; then
    echo "[INFO] Target model '$TARGET_MODEL' not found in local cache. Pulling now..."
    ollama pull "$TARGET_MODEL"
  else
    echo "[INFO] Target model '$TARGET_MODEL' is already available in local cache."
  fi

  export OLLAMA_HOST="http://127.0.0.1:11434"
fi

if [ "$1" = "cron" ] || [ "$1" = "--daemon" ] || [ -z "$1" ]; then
  CRON_EXPR="${CRON_SCHEDULE:-*/5 * * * *}"
  echo "[INFO] Configuring Debian cron with schedule: $CRON_EXPR"

  export -p > /app/.cronenv

  (
    echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    echo "$CRON_EXPR . /app/.cronenv; cd /app && /usr/local/bin/node dist/index.js --once > /proc/1/fd/1 2> /proc/1/fd/2"
  ) | crontab -

  echo "[INFO] Starting persistent Web Dashboard server on port 3000..."
  (
    while true; do
      /usr/local/bin/node dist/index.js --server > /proc/1/fd/1 2> /proc/1/fd/2 || true
      sleep 2
    done
  ) &
  SERVER_PID=$!

  echo "[INFO] Starting initial classification pass on startup..."
  /usr/local/bin/node dist/index.js --once || true

  echo "[INFO] Cron & Web UI active. Waiting for scheduled ticks..."
  cron -f &
  CRON_PID=$!
  wait "$CRON_PID"
fi

exec /usr/local/bin/node dist/index.js "$@"
