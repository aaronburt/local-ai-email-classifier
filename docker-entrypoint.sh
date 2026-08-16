#!/bin/sh
set -e

if [ "$1" = "cron" ] || [ "$1" = "--daemon" ] || [ -z "$1" ]; then
  CRON_EXPR="${CRON_SCHEDULE:-*/5 * * * *}"
  echo "[INFO] Configuring Alpine cron with schedule: $CRON_EXPR"
  echo "$CRON_EXPR cd /app && node dist/index.js --once > /proc/1/fd/1 2> /proc/1/fd/2" | crontab -
  echo "[INFO] Starting initial classification pass on startup..."
  node dist/index.js --once || true
  echo "[INFO] Crond active. Idling at ~1.5MB RAM until next scheduled tick."
  exec crond -f -l 2
fi

exec node dist/index.js "$@"
