# LyricLens Desktop

[中文](README.md) · [English](README.en.md)

A standalone desktop companion that surfaces lyrics with LLM-powered learning notes. It reads the current track from Windows SMTC, pulls the synced lyrics from LRCLIB, and asks an LLM for learning cards inline — **tiered by how healthy each player's timeline actually is**, not by player name. Players whose position genuinely advances (Spotify Desktop, Media Player, NetEase Cloud Music, QQ Music, Apple Music, …) get per-line sync; players that only publish metadata (foobar2000 in default config, etc.) automatically fall back to fan-out cards. The classification is driven by observed snapshots, so the support tier follows reality instead of a hard-coded allowlist.

## Status

**Alpha · MVP loop wired + notebook fully closed (phase 3 done).** SMTC pulls now-playing from any Windows player that exposes it (Spotify / QQ Music / foobar2000 / Edge media / …), LRCLIB resolves the synced lyrics, the sync-scrolling lyric pane works, the 4-tab settings panel matches the BetterNCM plugin one-to-one, and OpenAI-compatible LLM cards now render inline under the active lyric line. Session 2 landed mainland-China connectivity (self-hosted CF Worker proxy for LRCLIB), LRCLIB candidate-ranking fix, and a local analysis-result cache. Session 3-4 landed the full notebook loop: SQLite store · star-to-save · note sheet · batch delete · JSON import/export · Anki TSV export · seven-step merge rule — the data path to the sibling Android review app is ready.

## Architecture

This is **host 2** of the LyricLens dual-host product:

```
┌─ Plugin (BetterNCM) ──────────┐   ┌─ Desktop (this repo) ────────┐
│ injected into NetEase Cloud   │   │ standalone Tauri app          │
│ lyrics: NCM memory             │   │ lyrics: LRCLIB (CF Worker)    │
│ storage: IndexedDB             │   │ storage: SQLite (deferred)    │
│ ui: NCM overlay                │   │ ui: independent window        │
└────────────────────────────────┘   └───────────────────────────────┘
                 ↕ JSON export / import (no live sync)
```

The two hosts are independent complete products. If BetterNCM dies, the desktop host carries the product forward unaffected. See the sibling repo [`yoruuuchan/LyricLens`](https://github.com/yoruuuchan/LyricLens) for the plugin host and the full dual-host roadmap.

## What's in the box right now

- **SMTC reader** — Title / artist / album / duration / position / playback status / `LastUpdatedTime` / `PlaybackRate` / `SourceAppUserModelId`, pulled via `windows-rs` `Media_Control`. Polled every 1s; the frontend extrapolates position between polls for smooth lyric highlight.
- **Timeline health classification** — Each SMTC session runs through a 6-tier state machine: `timeline_healthy` / `timeline_candidate` → per-line sync; `timeline_unstable` → per-line with warning; `metadata_only` / `timeline_dead` → fan all cards out automatically. The decision is driven by whether position actually advances at the expected rate over a ≥3-frame window, not by an allowlist of player names.
- **Debug panel** — Settings → 调试 tab shows the current session plus every sibling SMTC session with raw fields (position / duration / lastUpdated / capturedAt / playbackRate) and a colored health badge. One screenshot when something goes wrong is enough to triage.
- **LRCLIB client + Cloudflare Worker proxy** — `/api/get` with `/api/search` fallback, ±5s duration tolerance, LRC parser handles multi-stamp lines (Probe E measured 97.9% hit rate across 290 songs in 8 categories — see the plugin repo's roadmap for the benchmark). **All requests route through a self-hosted Cloudflare Worker at `https://lrclib.yoru-and-akari.dev/api`** — HK/SG edge nodes are far more reachable from mainland China than lrclib.net directly, with 6h edge caching for 200s and no-store for 404/5xx. Rust client retries once on transient failures and surfaces typed friendly errors (timeout / connect / 5xx / 4xx each map to a plain-language hint).
- **Candidate ranking prefers synced** — LRCLIB `/api/search` can return 10+ candidates of mixed quality. Artists like `Aimer / EGOIST` (ninelie) miss `/api/get` and must use search, where plain-only candidates (no timestamps, last line literally `(End)`) often outrank synced ones by duration. The Rust client sorts in two passes: **first by whether `syncedLyrics` is non-empty, then by duration distance** — so the plain-only `(End)` ghost can't win anymore.
- **Sync-scrolling lyric pane (auto fan-out for plain-only)** — Active line highlighted in primary blue, faded past/future lines, smooth scroll-into-view. When the LRC has no timeline at all (every line `timeMs=0`), the pane auto-switches to "expand all cards" mode instead of letting the active-index walker pin to the last line.
- **LLM analysis pipeline** — Reuses the plugin prompt frame / typed-points schema, calls an OpenAI-compatible Chat Completions endpoint, parses JSON, and renders the learning card below the active lyric line.
- **Local analysis-result cache** — localStorage FIFO (50-entry cap), keyed by `${trackKey}|${analysisSignature}`. Replaying the same track with the same settings hits the cache instantly and the card flips its top-right badge to `cached` (primary tint — no need to open DevTools to confirm). Both primary-path and fallback successes write to the cache, so once you've gotten a song to render you never pay the "primary fails → fallback" cost twice. Schema changes are invalidated via a `CACHE_VERSION` bump.
- **yoru-and-akari Console Design System** — Neumorphism surfaces, akari (light) / yoru (dark) themes, Geist + Noto Sans SC as bundled woff2 files (no Google Fonts round-trip, no fallback flash).
- **Real window transparency** — Toggleable 40–100 % alpha. The desktop bleeds through behind the lyric pane while surfaces (now-playing strip, settings cards, footer) stay solid so text never blurs.
- **Settings — 4 tabs matching the plugin** —
  - **常规**: 自动分析 toggle · 主题 · 字体大小 · 窗口透明度 slider
  - **AI 服务**: OpenAI-compatible endpoint / key / model + live "测试连接" with HTTP status & latency; learning preferences (target language · knowledge-point checkboxes · collapsible custom-prompt editor that previews the live default focus block)
  - **高级**: card-generation mode · timeout · max lines · max tokens · temperature · thinking mode · response-format mode · fallback-on-timeout knob bundle
  - **关于**: version · GitHub link (opens in system browser) · feedback form (POSTs to `lyriclens.yoru-and-akari.dev/feedback` tagged `app: "lyriclens-desktop"`)
- **JLPT reference-level badge** — Vocabulary and grammar points on every learning card get a `JLPT N?` mini-pill on the right, sourced from [Bluskyo/JLPT_Vocabulary](https://github.com/Bluskyo/JLPT_Vocabulary) (MIT repo + Tanos CC BY upstream data). The compressed word list ships via a self-hosted `dicts.yoru-and-akari.dev` KV CDN; on boot the Rust side pulls the manifest, sha256-verifies the versioned blob, brotli-decompresses, and keeps a `HashMap<surface, [entry]>` resident. `jlpt_lookup(surface, reading?)` follows a three-tier fallback: `exact(surface, reading)` → `exact(surface)` (confidence downgraded to `source-surface`) → nothing (no "unknown" placeholder). The wording is deliberately "reference level" — no affiliation with the JLPT organizers. First-ever cold boot pays a ~200-500 ms round trip; subsequent starts hit the disk cache. Multi-reading surfaces (e.g. `年` → とし N5 / ねん N4) surface every candidate sorted ascending by N-number.
- **Notebook** — Top-right book icon opens a first-class overlay (peer of the settings overlay). The ★ button on any learning card saves the current line to SQLite (`%APPDATA%\dev.lyriclens.desktop\notebook.sqlite`, schema follows the parent repo's [`docs/schema/notebook-entry.md`](https://github.com/yoruuuchan/LyricLens/blob/main/docs/schema/notebook-entry.md) `lyriclens.notebook.v1`). The overlay toolbar has 4 buttons:
  - **Refresh** — reload the database snapshot
  - **Import JSON** — pick a v1 envelope file and merge per the seven-step rule: keep local `id` · concatenate `userNote` with a `---来自 <source>（<iso>）---` marker · take the newer `card` by `updatedAt` · take the earlier `starredAt` · bump `updatedAt` to now · append and dedupe `importMergedFrom` · leave `source` alone. Entries already merged from the same source are skipped in full (three-AND check: incoming.userNote non-empty + local contains the marker + local contains incoming.userNote verbatim). Toast reports `new N · merged M · skipped K`.
  - **Export JSON** — writes a v1 envelope (`schema` / `exportedAt` RFC3339 UTC / `exportedFrom: "desktop"` / `entries[]`), mirror image of what the Android review app consumes.
  - **Export Anki** — writes TSV, one entry per row → one card per row: Front `<title> — <artist><br><lineText>`, Back `translation` + blank + `<label>: <text>` per point + blank + LLM note + blank + `---` + userNote (empty sections skipped whole so no dangling `---`), Tags `lyriclens song:<sanitized_song_key> source:<source>`. Field-internal `\n → <br>` and `\t → space` keep the columns intact; Japanese/Chinese in tags round-trips fine.
- **Note sheet** — Each entry has 加备注 / 编辑备注 to open a floating editor. Sheet uses primary tint so user notes are visually distinct from LLM notes. Closes on ESC / cancel / backdrop.
- **Batch delete** — Per-entry checkboxes with a slide-in bar showing `已选 N / M / 全选 / 取消全选 / 删除选中`. Uses `Promise.allSettled` so one row failing doesn't take out the rest.

## What's not in the MVP yet

- ⏳ Real-provider validation: enter endpoint / key / model and confirm request, parsing, and inline card render all work end to end.
- ⏳ Vocab CDN, JLPT / CEFR-J level tags
- ⏳ Per-line card request batching (work around the 4096-token truncation)

> Windows-only. macOS / Linux were dropped from the roadmap on purpose; see the parent repo's long-term direction decisions.

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
  main.ts             SMTC poll loop, settings + notebook overlays, lyric render
  analysis.ts         LLM analysis pipeline + cache entry points
  analysis-cache.ts   localStorage FIFO cache (CACHE_VERSION-gated)
  notebook.ts         typed Rust invoke shim + makeSongKey / newEntryId
  jlpt.ts             typed jlpt_lookup shim + badge label formatter
  styles.css          design-system surfaces + window-alpha + components
  tokens.css          design-system tokens (verbatim from yoru-and-akari)
  fonts/              Geist (variable) + Geist Mono (variable) + Noto Sans SC
src-tauri/
  src/lib.rs          Tauri commands wrapping the modules below
  src/smtc.rs         Windows SMTC reader
  src/lrclib.rs       LRCLIB client + LRC parser (retry + candidate ranking)
  src/notebook.rs     notebook SQLite store + seven-step merge + Anki TSV writer
  src/jlpt.rs         JLPT vocab bootstrap (manifest + sha256 + brotli) + HashMap three-tier lookup
  tauri.conf.json     window: 480×720, transparent: true, decorations: true
cloudflare-worker-dicts/  dicts.yoru-and-akari.dev CDN Worker + KV upload scripts
cloudflare-worker/    LRCLIB reverse-proxy Worker + deploy script
  worker.js           /api/get, /api/search passthrough + /healthz + edge cache
  wrangler.toml       route declaration
  deploy.sh           one-shot multipart API upload, runs inside WSL
docs/roadmap/         README, progress log (HANDOFF-*.md is gitignored)
```

## License

TBD — defaults to source-available, no redistribution until decided.
