/*
 * dicts-cdn Worker.
 *
 * Serves dicts.yoru-and-akari.dev/* by pulling manifest and versioned
 * blobs out of the LYRICLENS_DICTS KV namespace. Sibling of the
 * lrclib-proxy Worker but a completely separate concern: this one owns
 * the reference-dictionary distribution channel (JLPT for the MVP,
 * CEFR-J later — same route prefix per family).
 *
 * Content model:
 *   KV key                                  → served path
 *   "jlpt/manifest.json"                    → GET /jlpt/manifest.json
 *   "jlpt/jlpt-levels.<version>.v1.json.br" → GET /jlpt/jlpt-levels.<version>.v1.json.br
 *
 * The desktop client's Rust bootstrap fetches manifest.json first,
 * checks its sha256 against the local cache, then downloads the
 * versioned blob only when it actually changed. See docs/schema/
 * jlpt-vocab.md for the manifest / envelope shape.
 *
 * Cache strategy:
 *   manifest.json → 1h edge cache, cache-control: public, max-age=3600
 *   *.json.{br,gz} → immutable, cache-control: public, max-age=31536000, immutable
 *   /healthz      → uncached "ok"
 *   /             → uncached banner
 *   anything else → 404
 *
 * Content-Encoding: blobs are served as raw compressed bytes with
 * Content-Type octet-stream; every client does its own
 * sha256-then-decompress. .br keeps the historical Content-Encoding: br
 * marker (the edge strips it in practice; the desktop Rust client never
 * relied on it). .gz — the variant for the BetterNCM plugin host, whose
 * Chromium 91 only has a gzip DecompressionStream — deliberately gets
 * NO Content-Encoding: if it did, the edge/browser could transparently
 * decompress and the plugin's sha256-of-compressed-bytes would never
 * match the manifest.
 */

const MANIFEST_CACHE_TTL_SECONDS = 3600; // 1h
const BLOB_CACHE_TTL_SECONDS = 31536000; // 1y, blobs are immutable per (source, version)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return textResponse("dicts cdn · yoru-and-akari.dev\n", 200, 60);
    }
    if (url.pathname === "/healthz") {
      return textResponse("ok", 200);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("method not allowed", 405);
    }

    const key = url.pathname.slice(1); // drop leading "/"
    if (!isAllowedKey(key)) {
      return textResponse("not found", 404);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    if (!env.LYRICLENS_DICTS) {
      // KV binding missing → 500 rather than 404 so a misconfigured
      // deploy is loud. `bindings` in deploy.sh should always contain
      // this binding, and wrangler.toml declares it too.
      return textResponse("kv binding not configured", 500);
    }

    const isManifest = key.endsWith("/manifest.json");
    const kvType = isManifest ? "text" : "arrayBuffer";
    const value = await env.LYRICLENS_DICTS.get(key, kvType);
    if (value === null) {
      // Missing blob in KV is a 404 rather than a 5xx — the client's
      // bootstrap treats "manifest fetch 404" as first-ever-run cold path.
      return textResponse("not found", 404);
    }

    const headers = new Headers();
    headers.set("access-control-allow-origin", "*");

    let response;
    if (isManifest) {
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set(
        "cache-control",
        `public, max-age=${MANIFEST_CACHE_TTL_SECONDS}, s-maxage=${MANIFEST_CACHE_TTL_SECONDS}`
      );
      response = new Response(value, { status: 200, headers });
    } else {
      // Blobs are compressed JSON payloads served as raw bytes
      // (Content-Type octet-stream — application/json would trick
      // reqwest into auto-decompressing before the client can sha256).
      // Only .br carries the Content-Encoding marker; .gz must not,
      // see the header comment.
      headers.set("content-type", "application/octet-stream");
      if (key.endsWith(".br")) headers.set("content-encoding", "br");
      headers.set(
        "cache-control",
        `public, max-age=${BLOB_CACHE_TTL_SECONDS}, s-maxage=${BLOB_CACHE_TTL_SECONDS}, immutable`
      );
      response = new Response(value, { status: 200, headers });
    }

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

// Only accept keys we intentionally serve. The KV namespace is scoped
// per-worker but a defense-in-depth allowlist keeps future accidental
// writes (say, someone puts a private note under "internal/") from
// leaking through this Worker.
function isAllowedKey(key) {
  if (typeof key !== "string") return false;
  if (key.length === 0 || key.length > 128) return false;
  if (key.includes("..") || key.startsWith("/")) return false;
  // families/manifest.json  or  families/*.json.{br,gz}
  const parts = key.split("/");
  if (parts.length !== 2) return false;
  const family = parts[0];
  const file = parts[1];
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(family)) return false; // "jlpt", "cefrj", ...
  if (file === "manifest.json") return true;
  if (/^[a-zA-Z0-9._-]{1,96}\.json\.(br|gz)$/.test(file)) return true;
  return false;
}

function textResponse(body, status, maxAge = 0) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control":
        maxAge > 0
          ? `public, max-age=${maxAge}, s-maxage=${maxAge}`
          : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
