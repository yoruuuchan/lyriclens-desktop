#!/usr/bin/env bash
# Deploy dicts-cdn Worker to Cloudflare via API directly (no wrangler needed).
# Reads CLOUDFLARE_API_TOKEN from ~/.config/codex/private.env when present.
#
# Unlike lrclib-proxy this Worker DOES have a KV binding — the KV
# namespace id has to be baked into the metadata bindings array on
# every deploy or the binding disappears. If you added a namespace via
# the API and don't remember the id, list-kv.sh (or the API call
# GET /accounts/$ACCOUNT_ID/storage/kv/namespaces) will show it.
#
# Usage: KV_NAMESPACE_ID=<hex> bash deploy.sh
set -eu
set -o pipefail 2>/dev/null || true

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-5e96dfd2bf22d385e4ffdaa794d74676}"
SCRIPT_NAME="${WORKER_NAME:-dicts-cdn}"
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
if [[ -z "${KV_NAMESPACE_ID:-}" ]]; then
  echo "missing KV_NAMESPACE_ID — export the LYRICLENS_DICTS namespace id" >&2
  exit 1
fi
if [[ ! -f "$WORKER_FILE" ]]; then
  echo "worker.js not found at $WORKER_FILE" >&2
  exit 1
fi

BOUNDARY="----dicts-cdn-$(date +%s)$RANDOM"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

read -r -d '' METADATA_JSON <<JSON || true
{
  "main_module": "worker.js",
  "compatibility_date": "${COMPAT_DATE}",
  "bindings": [
    {
      "type": "kv_namespace",
      "name": "LYRICLENS_DICTS",
      "namespace_id": "${KV_NAMESPACE_ID}"
    }
  ]
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

echo "uploading $(wc -c < "$WORKER_FILE") bytes of worker.js → $SCRIPT_NAME (kv=${KV_NAMESPACE_ID:0:8}…)"

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
