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

Stage 4 · Cross-platform
├─ ⏳ macOS (MRMediaRemote, private API risk)
└─ ⏳ Linux (MPRIS)
```

## Locked decisions

(All inherited from the plugin repo's roadmap and re-affirmed here.)

1. **Two-host north star.** Plugin and desktop are independent complete products.
2. **MVP = Windows only.** macOS/Linux come after the Windows loop works end-to-end.
3. **LRCLIB is the lyric source.** 97.9% hit rate measured across 290 songs in probe E.
4. **SMTC is the now-playing source.** Covers Spotify / QQ / foobar2000; NCM Win32 needs BetterNCM bridge (plugin host handles that).
5. **No core extraction yet.** Copy prompt + card schema verbatim from the plugin. Extract a shared core only after both hosts have stabilized.
6. **No live sync between hosts.** JSON export/import only.

## Progress

See [progress.md](progress.md).

## Note for the next me

- This is a young repo. Read `docs/HANDOFF-*.md` (gitignored) before doing anything.
- Sibling repo path on Yoru's machine: `D:\LyricLens` (plugin).
- All comments / commits in English; conversations with Yoru in Chinese.
- Tauri v2 stable, Rust 1.96+, Node 18+ assumed.
