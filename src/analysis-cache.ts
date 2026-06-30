// Persistent analysis cache keyed by `${trackKey}|${analysisSignature}`.
//
// Why this exists: same song played twice in a row used to fire the LLM
// twice, burning tokens and forcing the user to wait through a second
// "正在生成学习卡片…" round. With the cache, the second play is instant
// as long as both the track and the relevant settings haven't changed.
//
// Storage is a single localStorage blob. Cards are plain JSON arrays so
// re-hydrating is just `JSON.parse`; no Map serialization needed.
// Capacity is a soft cap — when we go over it we drop oldest entries by
// `savedAtMs`. Quota/parse failures are swallowed: cache is a perf
// optimization, not a correctness requirement.

import type { AnalysisCard } from "./analysis";

const STORAGE_KEY = "lyriclens.desktop.analysis-cache";
// Bump when a fix changes what the analysis pipeline *should* produce
// for the same (trackKey, signature). v2 invalidates the v1 entries
// that may have cached the ninelie-style "(End)" cards generated when
// the search() candidate ranking picked a plain-only LRCLIB row.
const CACHE_VERSION = 2;
const MAX_ENTRIES = 50;

type CacheEntry = {
  cards: AnalysisCard[];
  savedAtMs: number;
};

type CacheShape = {
  version: number;
  entries: Record<string, CacheEntry>;
};

function emptyCache(): CacheShape {
  return { version: CACHE_VERSION, entries: {} };
}

function readRaw(): CacheShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyCache();
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    if (!parsed || parsed.version !== CACHE_VERSION) return emptyCache();
    if (!parsed.entries || typeof parsed.entries !== "object") return emptyCache();
    return parsed as CacheShape;
  } catch {
    return emptyCache();
  }
}

function writeRaw(cache: CacheShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Quota exceeded / private mode / disabled storage. Cache misses are
    // not a failure mode — the next analysis just runs as if cold.
  }
}

function cacheKey(trackKey: string, signature: string): string {
  return `${trackKey}|${signature}`;
}

export function readAnalysisCache(
  trackKey: string,
  signature: string,
): AnalysisCard[] | null {
  if (!trackKey) return null;
  const cache = readRaw();
  const entry = cache.entries[cacheKey(trackKey, signature)];
  if (!entry || !Array.isArray(entry.cards) || entry.cards.length === 0) {
    return null;
  }
  return entry.cards;
}

export function writeAnalysisCache(
  trackKey: string,
  signature: string,
  cards: AnalysisCard[],
  nowMs: number = Date.now(),
): void {
  if (!trackKey || cards.length === 0) return;
  const cache = readRaw();
  cache.entries[cacheKey(trackKey, signature)] = {
    cards,
    savedAtMs: nowMs,
  };
  const keys = Object.keys(cache.entries);
  if (keys.length > MAX_ENTRIES) {
    const sorted = keys
      .map((k) => ({ k, t: cache.entries[k].savedAtMs }))
      .sort((a, b) => a.t - b.t);
    for (const { k } of sorted.slice(0, keys.length - MAX_ENTRIES)) {
      delete cache.entries[k];
    }
  }
  writeRaw(cache);
}

export function clearAnalysisCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same swallow as writeRaw — clear is best-effort.
  }
}
