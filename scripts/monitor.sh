#!/usr/bin/env sh
set -eu

# Run the app
bun main.ts
rc=$?

if [ $rc -ne 0 ]; then
  if [ -n "${GOTIFY_URL:-}" ] && [ -n "${GOTIFY_TOKEN:-}" ]; then
    curl -fsS -X POST "${GOTIFY_URL}/message?token=${GOTIFY_TOKEN}" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "message=process-mining crashed (exit $rc) on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      || echo "gotify notify failed"
  fi
  exit $rc
fi

exit 0
