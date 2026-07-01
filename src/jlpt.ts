// Typed shim over the Rust `jlpt_lookup` command + a small render
// helper that formats zero-to-many candidate entries as a JLPT badge.
//
// Store side of the world (src-tauri/src/jlpt.rs) does the network
// bootstrap, sha256, brotli decompression, and HashMap lookup. This
// module is deliberately thin: no localStorage, no timing, no cache
// (the store IS the cache), just a typed call and a render string.

import { invoke } from "@tauri-apps/api/core";

export type JlptEntry = {
  level: "N1" | "N2" | "N3" | "N4" | "N5";
  reading?: string;
  source: string;
  // "source": the surface+reading both matched, or reading was
  //           unspecified and the surface has a single candidate.
  // "source-surface": surface matched but the requested reading
  //           didn't; the ambiguity marker is UI-visible.
  // "lemma": surface hit via lemma normalization (reserved — the
  //           MVP client-side lookup doesn't do lemma).
  confidence: "source" | "source-surface" | "lemma";
};

export async function jlptLookup(
  surface: string,
  reading?: string,
): Promise<JlptEntry[]> {
  if (!surface || !surface.trim()) return [];
  try {
    return await invoke<JlptEntry[]>("jlpt_lookup", {
      surface,
      reading: reading && reading.trim() ? reading : null,
    });
  } catch {
    // JLPT badges are a nice-to-have. A store that hasn't finished
    // bootstrapping (or a Rust-side error) should render as "no badge",
    // not surface a user-visible failure.
    return [];
  }
}

// Format a set of lookup results into the badge label per docs/schema/
// jlpt-vocab.md §UI 渲染规则:
//   一 level  → "JLPT N5"
//   多 level  → "JLPT N3 / N4"  (ascending by N-number)
//   零 candidates → null, caller renders nothing
export function formatBadgeLabel(entries: JlptEntry[]): string | null {
  if (entries.length === 0) return null;
  const levels = Array.from(new Set(entries.map((e) => e.level)));
  levels.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return `JLPT ${levels.join(" / ")}`;
}

// Confidence tag for the UI to hint ambiguity. If every entry is
// "source" we return null (no marker); if any entry is source-surface
// we return the "*" symbol so the tooltip can explain it.
export function ambiguityMarker(entries: JlptEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries.some((e) => e.confidence === "source-surface") ? "*" : null;
}
