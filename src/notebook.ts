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

// v1.1 additive — mastery is a review-progress journal, NOT a driver
// of any scheduling algorithm ("不做 SRS" promise, docs/roadmap/README).
// yes/meh/no come from the Android reviewer app; `new` is the default
// for a fresh star that hasn't been reviewed yet. Desktop + plugin
// hosts are read-only: they render the dot, they don't offer buttons.
export type MasteryLevel = "yes" | "meh" | "no" | "new";

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
  // v1.1 fields. Rust side supplies serde defaults, so an old-schema
  // JSON that omits these still deserializes; but reading a row that
  // round-tripped through Rust always yields a materialized value.
  mastery: MasteryLevel;
  lastReviewedAt: number | null;
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

// JSON export — JS-side picks the path via tauri-plugin-dialog's save
// dialog, then hands it to the Rust command which writes the file and
// returns the entry count for the success toast.
export async function exportEntriesJsonToPath(path: string): Promise<number> {
  return invoke<number>("notebook_export_json_to_path", { path });
}

// Anki TSV export — same shape as the JSON command above. The Rust
// side emits Front\tBack\tTags rows; newlines inside fields are
// rewritten to <br> for Anki HTML rendering.
export async function exportEntriesAnkiToPath(path: string): Promise<number> {
  return invoke<number>("notebook_export_anki_to_path", { path });
}

// JSON import — the Rust side parses the v1 envelope, applies the
// schema doc's seven-step merge spec inside a transaction, and returns
// per-bucket counts so the toast can summarize without a list refetch.
export type ImportSummary = {
  totalParsed: number;
  imported: number;
  merged: number;
  skipped: number;
  errors: string[];
};

export async function importEntriesFromPath(path: string): Promise<ImportSummary> {
  return invoke<ImportSummary>("notebook_import_from_path", { path });
}
