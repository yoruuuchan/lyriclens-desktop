import { invoke } from "@tauri-apps/api/core";

type NowPlaying = {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  positionMs: number;
  capturedAtMs: number;
  status: string;
};

type LyricLine = { timeMs: number; text: string };

type LyricResult = {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  duration?: number | null;
  instrumental: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

type CmdError =
  | { kind: "no_session" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const el = {
  title: () => $("#np-title"),
  artist: () => $("#np-artist"),
  album: () => $("#np-album"),
  status: () => $("#np-status"),
  timing: () => $("#np-timing"),
  lyrics: () => $("#lyrics"),
  hint: () => $("#hint"),
  refresh: () => $<HTMLButtonElement>("#btn-refresh"),
};

const state = {
  np: null as NowPlaying | null,
  trackKey: "",
  lines: [] as LyricLine[],
  fetchingLyrics: false,
  lyricsMessage: "",
};

function trackKey(np: NowPlaying | null): string {
  if (!np || !np.title) return "";
  return `${np.title.toLowerCase()}|${np.artist.toLowerCase()}|${Math.round(
    np.durationMs / 1000,
  )}`;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const ss = (total % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function liveStatus(np: NowPlaying | null): { label: string; live: boolean } {
  if (!np) return { label: "no smtc session", live: false };
  if (!np.title) return { label: "session empty", live: false };
  if (np.status === "playing") return { label: "playing", live: true };
  return { label: np.status, live: false };
}

function extrapolatedPositionMs(np: NowPlaying | null): number {
  if (!np) return 0;
  const base = np.positionMs;
  if (np.status !== "playing") return base;
  return base + (Date.now() - np.capturedAtMs);
}

function renderNowPlaying() {
  const np = state.np;
  el.title().textContent = np?.title || "—";
  el.artist().textContent = np?.artist || "—";
  el.album().textContent = np?.album || "—";
  const { label, live } = liveStatus(np);
  const badge = el.status();
  badge.textContent = label;
  badge.classList.toggle("live", live);

  const pos = extrapolatedPositionMs(np);
  const dur = np?.durationMs ?? 0;
  el.timing().textContent = `${formatTime(pos)} / ${formatTime(dur)}`;
}

function renderLyrics() {
  const container = el.lyrics();
  if (state.lyricsMessage && state.lines.length === 0) {
    container.innerHTML = `<p class="placeholder">${state.lyricsMessage}</p>`;
    return;
  }
  if (state.lines.length === 0) {
    container.innerHTML = `<p class="placeholder">play something — smtc will pick it up.</p>`;
    return;
  }

  const pos = extrapolatedPositionMs(state.np);
  // Active line = last line whose timestamp ≤ position.
  let activeIdx = -1;
  for (let i = 0; i < state.lines.length; i++) {
    if (state.lines[i].timeMs <= pos) activeIdx = i;
    else break;
  }

  // Render the lines as a list and let CSS handle the rolling layout.
  const html = state.lines
    .map((line, i) => {
      const classes = ["line"];
      if (i === activeIdx) classes.push("active");
      else if (i < activeIdx) classes.push("past");
      else classes.push("future");
      const text = line.text || "♪";
      return `<div class="${classes.join(" ")}" data-i="${i}">${escapeHtml(text)}</div>`;
    })
    .join("");

  container.innerHTML = html;
  const active = container.querySelector<HTMLElement>(".line.active");
  if (active) {
    active.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function fetchLyricsFor(np: NowPlaying) {
  if (state.fetchingLyrics) return;
  if (!np.title || !np.artist) {
    state.lines = [];
    state.lyricsMessage = "need title + artist from smtc.";
    renderLyrics();
    return;
  }
  state.fetchingLyrics = true;
  state.lyricsMessage = "looking up on lrclib…";
  state.lines = [];
  renderLyrics();
  try {
    const result = await invoke<LyricResult>("lrclib_find", {
      trackName: np.title,
      artistName: np.artist,
      albumName: np.album || null,
      durationSecs: np.durationMs > 0 ? np.durationMs / 1000 : null,
    });
    if (result.instrumental) {
      state.lines = [];
      state.lyricsMessage = "instrumental · no lyrics on lrclib.";
    } else if (result.syncedLyrics) {
      const lines = await invoke<LyricLine[]>("lrclib_parse_synced", {
        synced: result.syncedLyrics,
      });
      state.lines = lines;
      state.lyricsMessage = "";
    } else if (result.plainLyrics) {
      state.lines = result.plainLyrics
        .split(/\r?\n/)
        .filter((s) => s.length > 0)
        .map((text) => ({ timeMs: 0, text }));
      state.lyricsMessage = "plain lyrics · no timestamps.";
    } else {
      state.lines = [];
      state.lyricsMessage = "lrclib hit but no lyrics in payload.";
    }
  } catch (err) {
    const e = err as CmdError;
    if (e?.kind === "not_found") {
      state.lyricsMessage = "no match on lrclib.";
    } else {
      state.lyricsMessage = `lookup error · ${(e as { message?: string })?.message ?? String(err)}`;
    }
    state.lines = [];
  } finally {
    state.fetchingLyrics = false;
    renderLyrics();
  }
}

async function pollSmtc() {
  try {
    const np = await invoke<NowPlaying>("smtc_now_playing");
    state.np = np;
    const key = trackKey(np);
    if (key && key !== state.trackKey) {
      state.trackKey = key;
      fetchLyricsFor(np);
    }
  } catch (err) {
    const e = err as CmdError;
    if (e?.kind === "no_session") {
      state.np = null;
      state.trackKey = "";
      state.lines = [];
      state.lyricsMessage = "no smtc session.";
    } else {
      state.np = null;
      state.lyricsMessage = `smtc error · ${(e as { message?: string })?.message ?? String(err)}`;
    }
  }
  renderNowPlaying();
  renderLyrics();
}

function startLoops() {
  // SMTC poll: once a second is plenty (timeline is stable between polls).
  pollSmtc();
  setInterval(pollSmtc, 1_000);

  // High-frequency render so the extrapolated position + active line stay
  // smooth. Cheap because we only re-mark .active when the index changes.
  let lastActive = -1;
  setInterval(() => {
    const pos = extrapolatedPositionMs(state.np);
    let idx = -1;
    for (let i = 0; i < state.lines.length; i++) {
      if (state.lines[i].timeMs <= pos) idx = i;
      else break;
    }
    if (idx !== lastActive) {
      lastActive = idx;
      renderLyrics();
    }
    if (el.timing()) {
      el.timing().textContent = `${formatTime(pos)} / ${formatTime(state.np?.durationMs ?? 0)}`;
    }
  }, 200);
}

window.addEventListener("DOMContentLoaded", () => {
  el.refresh().addEventListener("click", () => {
    state.trackKey = "";
    pollSmtc();
  });
  startLoops();
});
