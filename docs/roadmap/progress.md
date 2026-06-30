# Progress log

Newest first. Format:

```
## YYYY-MM-DD [tag] one-line title
- what got done
- what was learned
- next
```

tags: `[plan]` route decision / `[ship]` shipped functionality / `[probe]` probe result / `[debug]` problem hunt / `[note]` misc

---

## 2026-06-30 [ship] Scaffold lyriclens-desktop

Bootstrapped the desktop host of LyricLens as an independent repo. Driven by the dual-host north star ratified in the plugin repo on 2026-06-29, with probes D (SMTC coverage) and E (LRCLIB hit rate) both green.

What landed:
- `npm create tauri-app` with vanilla TS template
- Cargo deps added for SMTC (`windows-rs` Media_Control feature) and LRCLIB (`reqwest` + `tokio`)
- `tauri.conf.json` tuned for a 480x720 lyric window (vs the 800x600 default)
- `.gitignore`, `README.md`, `docs/roadmap/{README,progress}.md` initialized

Next:
- Write SMTC reader (Task #1)
- Write LRCLIB client (Task #2)
- Wire them into a minimal sync-scrolling UI (Task #3)
