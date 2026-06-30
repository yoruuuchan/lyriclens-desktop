# LyricLens Desktop

A standalone desktop companion that surfaces lyrics with LLM-powered learning notes — without depending on any specific music player.

## Status

**Pre-alpha.** Bootstrapping the Tauri v2 shell. Not usable yet.

## Architecture

This is one of two hosts of [LyricLens](https://github.com/yoruuuchan/LyricLens):

- **Plugin (BetterNCM)** — injected into NetEase Cloud Music, lyrics from NCM memory
- **Desktop (this repo)** — independent app, lyrics from LRCLIB, now-playing from SMTC/MRMR/MPRIS

Both are independent complete products. Data interchange is JSON import/export, no live sync.

## MVP scope (Windows-only)

- SMTC reader for now-playing metadata (title / artist / duration / position)
- LRCLIB client for synced lyrics (`https://lrclib.net`)
- Sync-scrolling lyric display
- LLM-powered per-line analysis (prompt + card schema reused from the plugin)
- SQLite for favorites (scaffolded but empty in MVP)

Not in MVP: vocab CDN, JLPT tagging, word frequency, macOS / Linux support.

## Development

Prereqs: Rust toolchain, Node 18+.

```powershell
npm install
npm run tauri dev
```

## License

TBD — defaults to source-available, no redistribution until decided.
