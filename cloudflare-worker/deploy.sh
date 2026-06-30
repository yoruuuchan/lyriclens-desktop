#!/usr/bin/env bash
# Deploy worker.js to Cloudflare via API directly (no wrangler needed).
# Reads CLOUDFLARE_API_TOKEN from ~/.config/codex/private.env when present.
#
# This Worker is a pure reverse proxy in front of lrclib.net — no KV, no
# R2, no secrets. The bindings array stays empty on purpose.
#
# Usage: bash deploy.sh
set -eu
set -o pipefail 2>/dev/null || true

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-5e96dfd2bf22d385e4ffdaa794d74676}"
SCRIPT_NAME="${WORKER_NAME:-lrclib-proxy}"
COMPAT_DATE="${COMPAT_DATE:-2026-06-01}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_FILE="${HERE}/worker.js"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  if [[ -f "$HOME/.config/codex/private.env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.config/codex/private.env"
  fi
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "missing CLOUDFLARE_API_TOKEN — export it or put it in ~/.config/codex/private.env" >&2
  exit 1
fi
if [[ ! -f "$WORKER_FILE" ]]; then
  echo "worker.js not found at $WORKER_FILE" >&2
  exit 1
fi

BOUNDARY="----lrclib-proxy-$(date +%s)$RANDOM"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# No bindings: this Worker proxies HTTP and nothing more. The empty
# array is intentional — keep this in sync with wrangler.toml if either
# side ever grows bindings.
read -r -d '' METADATA_JSON <<JSON || true
{
  "main_module": "worker.js",
  "compatibility_date": "${COMPAT_DATE}",
  "bindings": []
}
JSON

{
  printf -- "--%s\r\n" "$BOUNDARY"
  printf -- 'Content-Disposition: form-data; name="metadata"\r\n'
  printf -- 'Content-Type: application/json\r\n\r\n'
  printf -- '%s\r\n' "$METADATA_JSON"
  printf -- "--%s\r\n" "$BOUNDARY"
  printf -- 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
  printf -- 'Content-Type: application/javascript+module\r\n\r\n'
  cat "$WORKER_FILE"
  printf -- "\r\n--%s--\r\n" "$BOUNDARY"
} > "$TMP"

echo "uploading $(wc -c < "$WORKER_FILE") bytes of worker.js → $SCRIPT_NAME"

RESPONSE=$(curl --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: multipart/form-data; boundary=$BOUNDARY" \
  --data-binary "@$TMP" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME")

if echo "$RESPONSE" | grep -qE '"success":[[:space:]]*true'; then
  ETAG=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print((data.get("result") or {}).get("etag") or "")' <<<"$RESPONSE")
  echo "deploy ok · etag ${ETAG:-unknown}"
else
  echo "deploy failed:"
  echo "$RESPONSE"
  exit 1
fi
