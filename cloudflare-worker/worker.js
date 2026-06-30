/*
 * LRCLIB reverse-proxy Worker.
 *
 * Serves lrclib.yoru-and-akari.dev/api/* by transparently fetching
 * https://lrclib.net/api/* through Cloudflare's edge.
 *
 * Why this exists: in mainland China, direct TLS handshakes to
 * lrclib.net regularly get reset by the GFW — the desktop client sees
 * `reqwest::Error::is_connect()` and the user sees "查询出错 · http
 * error: error sending request for url ...". Cloudflare's edge
 * presence in HK/SG terminates the user's TLS, then the server-to-
 * server hop to lrclib.net's actual host runs from Cloudflare's
 * backbone, bypassing the consumer GFW path entirely.
 *
 * Secondary benefit: edge caching. LRCLIB content is effectively
 * immutable once published (lyric corrections are rare), so a 6-hour
 * cache keeps repeat queries inside Cloudflare's edge and reduces our
 * upstream burn.
 *
 * Surface:
 *   GET /              → "lrclib proxy" healthcheck (text/plain)
 *   GET /healthz       → "ok" (text/plain)
 *   GET /api/get       → pass-through to lrclib.net/api/get
 *   GET /api/search    → pass-through to lrclib.net/api/search
 *   (anything else)    → 404 not_found
 *
 * No KV, no R2, no secrets — the bindings array in deploy.sh is empty
 * on purpose.
 */

const UPSTREAM_BASE = "https://lrclib.net";
const SUCCESS_CACHE_TTL_SECONDS = 21600; // 6h
const USER_AGENT =
  "LyricLens-Proxy/0.1 (+https://lyriclens.yoru-and-akari.dev)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return textResponse("lrclib proxy · yoru-and-akari.dev\n", 200, 60);
    }
    if (url.pathname === "/healthz") {
      return textResponse("ok", 200);
    }
    if (!url.pathname.startsWith("/api/")) {
      return textResponse("not found", 404);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("method not allowed", 405);
    }

    // Preserve path + query verbatim — LRCLIB's matching depends on
    // exact track_name / artist_name spelling, including punctuation.
    const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_BASE);

    // Edge-cache by full canonical URL. Cloudflare's cache.default is
    // keyed on the Request URL, so two identical client queries (same
    // track/artist/duration) collapse to a single upstream fetch.
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        // Belt-and-braces — `cf.cacheTtl` is Cloudflare's edge cache
        // hint, separate from cache.default we drive ourselves below.
        // Setting both means even if our explicit put() somehow misses,
        // edge HTTP caching still amortizes.
        cf: {
          cacheTtl: SUCCESS_CACHE_TTL_SECONDS,
          cacheEverything: true,
        },
      });
    } catch (err) {
      // We failed to even reach lrclib.net from Cloudflare's side —
      // surface that as a 502 so the desktop client's HttpStatus
      // branch fires instead of pretending the song doesn't exist.
      return new Response(
        JSON.stringify({
          error: "upstream_unreachable",
          message: String(err?.message ?? err),
        }),
        {
          status: 502,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          },
        }
      );
    }

    // Pass headers through but normalize cache/CORS so the desktop
    // doesn't trip on whatever LRCLIB happens to return. Drop any
    // cookies — we don't carry session state and don't want to leak.
    const headers = new Headers(upstream.headers);
    headers.delete("set-cookie");
    headers.set("access-control-allow-origin", "*");
    if (upstream.status === 200) {
      headers.set(
        "cache-control",
        `public, max-age=${SUCCESS_CACHE_TTL_SECONDS}, s-maxage=${SUCCESS_CACHE_TTL_SECONDS}`
      );
    } else {
      // 404 / 5xx should not pin to edge — users keep adding new songs
      // to LRCLIB and the next try might land. no-store is firmer than
      // no-cache because some intermediaries treat no-cache as "ask
      // every time but still allowed to store".
      headers.set("cache-control", "no-store");
    }

    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });

    // Only cache full hits. 404 from /api/get is *normal* (the client
    // falls back to /api/search) so we don't want a 6-hour negative
    // pin on songs that may have just been uploaded. 5xx is transient.
    if (upstream.status === 200) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};

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
