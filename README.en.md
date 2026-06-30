# LyricLens Desktop

[中文](README.md) · [English](README.en.md)

A standalone desktop companion that surfaces lyrics with LLM-powered learning notes — without depending on any specific music player.

## Status

**Alpha · MVP loop wired, pending real-provider validation.** SMTC pulls now-playing from any Windows player that exposes it (Spotify / QQ Music / foobar2000 / Edge media / …), LRCLIB resolves the synced lyrics, the sync-scrolling lyric pane works, the 4-tab settings panel matches the BetterNCM plugin one-to-one, and OpenAI-compatible LLM cards now render inline under the active lyric line.

## Architecture

This is **host 2** of the LyricLens dual-host product:

```
┌─ Plugin (BetterNCM) ──────────┐   ┌─ Desktop (this repo) ────────┐
│ injected into NetEase Cloud   │   │ standalone Tauri app          │
│ lyrics: NCM memory             │   │ lyrics: LRCLIB                │
│ storage: IndexedDB             │   │ storage: SQLite (deferred)    │
│ ui: NCM overlay                │   │ ui: independent window        │
└────────────────────────────────┘   └───────────────────────────────┘
                 ↕ JSON export / import (no live sync)
```

The two hosts are independent complete products. If BetterNCM dies, the desktop host carries the product forward unaffected. See the sibling repo [`yoruuuchan/LyricLens`](https://github.com/yoruuuchan/LyricLens) for the plugin host and the full dual-host roadmap.

## What's in the box right now

- **SMTC reader** — Title / artist / album / duration / position / playback status pulled via `windows-rs` `Media_Control`. Polled every 1s; the frontend extrapolates position between polls for smooth lyric highlight.
- **LRCLIB client** — `/api/get` with `/api/search` fallback, ±5s duration tolerance, LRC parser handles multi-stamp lines. (Probe E measured 97.9% hit rate across 290 songs in 8 categories — see the plugin repo's roadmap for the benchmark.)
- **Sync-scrolling lyric pane** — Active line highlighted in primary blue, faded past/future lines, smooth scroll-into-view.
- **LLM analysis pipeline** — Reuses the plugin prompt frame / typed-points schema, calls an OpenAI-compatible Chat Completions endpoint, parses JSON, and renders the learning card below the active lyric line.
- **yoru-and-akari Console Design System** — Neumorphism surfaces, akari (light) / yoru (dark) themes, Geist + Noto Sans SC as bundled woff2 files (no Google Fonts round-trip, no fallback flash).
- **Real window transparency** — Toggleable 40–100 % alpha. The desktop bleeds through behind the lyric pane while surfaces (now-playing strip, settings cards, footer) stay solid so text never blurs.
- **Settings — 4 tabs matching the plugin** —
  - **常规**: 自动分析 toggle · 主题 · 字体大小 · 窗口透明度 slider
  - **AI 服务**: OpenAI-compatible endpoint / key / model + live "测试连接" with HTTP status & latency; learning preferences (target language · knowledge-point checkboxes · collapsible custom-prompt editor that previews the live default focus block)
  - **高级**: card-generation mode · timeout · max lines · max tokens · temperature · thinking mode · response-format mode · fallback-on-timeout knob bundle
  - **关于**: version · GitHub link (opens in system browser) · feedback form (POSTs to `lyriclens.yoru-and-akari.dev/feedback` tagged `app: "lyriclens-desktop"`)

## What's not in the MVP yet

- ⏳ Real-provider validation: enter endpoint / key / model and confirm request, parsing, and inline card render all work end to end.
- ⏳ Favorites / SQLite store (scaffolded but empty)
- ⏳ Cross-host JSON import/export
- ⏳ Vocab CDN, JLPT tagging, word-frequency stats
- ⏳ macOS (MRMediaRemote) / Linux (MPRIS) — Windows-first

## Development

Prereqs: Rust 1.80+, Node 18+, Windows 10/11.

```powershell
npm install
npm run tauri dev        # dev server + hot-reload webview
npm run tauri build      # release .msi at src-tauri/target/release/bundle/msi/
```

In-app debugging: press **F12** or **Ctrl + Shift + I** for the webview devtools (debug builds enable them by default). The Vite dev server pins port 1420 — if a previous instance crashed and left the port held, `Get-NetTCPConnection -LocalPort 1420 | Stop-Process` clears it.

## Repository layout

```
src/                  vanilla TS frontend
  main.ts             SMTC poll loop, settings overlay, lyric render
  styles.css          design-system surfaces + window-alpha + components
  tokens.css          design-system tokens (verbatim from yoru-and-akari)
  fonts/              Geist (variable) + Geist Mono (variable) + Noto Sans SC
src-tauri/
  src/lib.rs          Tauri commands wrapping the modules below
  src/smtc.rs         Windows SMTC reader
  src/lrclib.rs       LRCLIB client + LRC parser
  tauri.conf.json     window: 480×720, transparent: true, decorations: true
docs/roadmap/         README, progress log (HANDOFF-*.md is gitignored)
```

## License

TBD — defaults to source-available, no redistribution until decided.
