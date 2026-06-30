// Thin TS shim over the Rust `notebook_*` commands.
//
// Why this exists: every TS caller goes through these typed wrappers
// so a future schema change shows up as a compile error instead of a
// runtime crash inside `invoke<unknown>`. The Rust side validates the
// payload (uuid v4, starredAt <= updatedAt, source enum), so the
// callers here can stay declarative.
//
// Schema source of truth:
// `D:/LyricLens/docs/schema/notebook-entry.md` (locked 2026-06-30).

import { invoke } from "@tauri-apps/api/core";
import type { AnalysisCard } from "./analysis";

export type EntrySource = "plugin" | "desktop";

export type NotebookEntry = {
  id: string;
  songKey: string;
  songTitle: string;
  songArtist: string;
  lineIndex: number;
  lineText: string;
  card: AnalysisCard;
  userNote: string;
  starredAt: number;
  updatedAt: number;
  source: EntrySource;
  importMergedFrom?: string[];
};

// Schema-canonical songKey: title and artist are trim+lowercase, and
// duration rounds to the nearest second. main.ts's existing trackKey()
// matches *almost* — it skips the trim. Once the star button lands and
// notebook entries start landing on the same songKey trackKey was
// keying analysis-cache on, the two need to converge; the next PR will
// swap main.ts over.
export function makeSongKey(
  title: string,
  artist: string,
  durationMs: number,
): string {
  return [
    title.trim().toLowerCase(),
    artist.trim().toLowerCase(),
    Math.round(durationMs / 1000),
  ].join("|");
}

// `crypto.randomUUID` is available in the Tauri webview (modern Edge
// WebView2). Wrap it so callers don't need to remember the API. The
// Rust side re-validates the uuid v4 shape regardless.
export function newEntryId(): string {
  return crypto.randomUUID();
}

export async function saveEntry(entry: NotebookEntry): Promise<NotebookEntry> {
  return invoke<NotebookEntry>("notebook_upsert", { entry });
}

export async function listEntries(): Promise<NotebookEntry[]> {
  return invoke<NotebookEntry[]>("notebook_list");
}

export async function removeEntry(id: string): Promise<boolean> {
  return invoke<boolean>("notebook_remove", { id });
}
