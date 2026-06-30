# LyricLens Desktop — Roadmap

Sibling repo: [`yoruuuchan/LyricLens`](https://github.com/yoruuuchan/LyricLens) (the BetterNCM plugin host).

## North star

LyricLens is one product, two hosts. This repo is **host 2 (Desktop)**: a standalone Tauri app that does not require NetEase Cloud Music or BetterNCM. The two hosts share schema (JSON import/export) but no live sync.

See the plugin repo's `docs/roadmap/README.md` for the full architecture diagram.

## Current stage map

```
Stage 0 · Scaffold (this commit)
├─ ✅ Tauri v2 + Vanilla TS shell
└─ ✅ Cargo + npm dependencies for SMTC + LRCLIB

Stage 1 · MVP loop (Windows only)
├─ ✅ Task #1 · SMTC reader (windows-rs Media_Control)
├─ ✅ Task #2 · LRCLIB client (title + artist + duration → synced LRC)
├─ ✅ Task #3 · Sync-scrolling lyric UI
└─ ✅ Task #4 · LLM analysis (copy plugin's prompt + card schema)

Stage 2 · Productization
├─ ⏳ SQLite for favorites
├─ ✅ Settings UI (provider / model / prompt)
└─ ✅ Installer (.msi via tauri bundle)

Stage 3 · Cross-host data interchange
├─ ⏳ JSON export schema agreed with plugin repo
└─ ⏳ Import from plugin export

Stage 4 · ~~Cross-platform~~ **Cancelled 2026-06-30**
└─ Locked: Windows only. macOS / Linux not on the roadmap anymore.
```

## Locked decisions

(All inherited from the plugin repo's roadmap and re-affirmed here. The plugin repo at `D:\LyricLens\docs\roadmap\README.md` is the canonical decision log — additions made there auto-apply here.)

1. **Two-host north star.** Plugin and desktop are independent complete products.
2. **Windows only.** macOS / Linux explicitly cancelled on 2026-06-30 (see plugin roadmap decision #11). `阶段 4 · Cross-platform` is dead.
3. **LRCLIB is the lyric source.** 97.9% hit rate measured across 290 songs in probe E.
4. **SMTC is the now-playing source — but treated as a tiered capability**, not a yes/no interface. See plugin roadmap decision #18: `timeline_healthy` enables row-level sync, `metadata_only` falls back to static notebook-style cards. Background: SMTC timeline research report at `C:\Users\15877\Downloads\lyriclens_smtc_timeline_research.md`.
5. **Core extraction deferred.** Copy prompt + card schema verbatim from the plugin for MVP. Extract a shared `@lyriclens/core` package only after the desktop SQLite schema and per-line batching stabilize. Premature extraction will re-do the interface.
6. **No live sync between hosts.** JSON export/import only. Merge rule: both sides preserved, `userNote` concatenated with `---来自 <source>---` separator. See plugin roadmap decision #15 and [`NotebookEntry` schema](../../../LyricLens/docs/schema/notebook-entry.md).
7. **Learning loop = notebook-style.** Star + user-written notes + Anki export. No SRS. No word-frequency counter. Plugin roadmap decision #13.
8. **Notebook entry granularity = one lyric line's full card** (original + translation + all highlights + LLM note + userNote bundled). Not per-highlight, not per-vocab. Plugin roadmap decision #14.
9. **MVP vocabulary stack = CEFR-J (English) + JLPT (Japanese) dual.** JLPT source needs license vetting (in flight). Plugin roadmap decision #12.
10. **Permanently out of scope** (do not re-propose without re-opening the discussion): WASAPI loopback for position derivation, NCM InfLink-rs compatibility, Spotify Web API deep integration, any Apple-ecosystem support, live cross-host sync, SRS, word-frequency stats, WAV-onset auto-alignment to LRC. Plugin roadmap decision #17.

## Progress

See [progress.md](progress.md).

## Note for the next me

- This is a young repo. Read `docs/HANDOFF-*.md` (gitignored) before doing anything.
- Sibling repo path on Yoru's machine: `D:\LyricLens` (plugin).
- All comments / commits in English; conversations with Yoru in Chinese.
- Tauri v2 stable, Rust 1.96+, Node 18+ assumed.
