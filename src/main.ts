// Geist + Geist Mono + Zen Kaku Gothic New are imported at the TOP of
// styles.css so they load synchronously with the rest of the
// stylesheet, before this JS module evaluates. Don't move them back
// here — it would re-introduce a one-frame Segoe UI fallback.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  analysisSettingsSignature,
  buildDefaultFocus,
  missingAnalysisConfig,
  requestAnalysis,
  toAnalysisInputLines,
  type AnalysisCard,
  type AnalysisSettings,
  type CardMode,
  type KnowledgePoint,
  type ResponseFormatMode,
  type ThinkingMode,
} from "./analysis";
import {
  clearAnalysisCache,
  countAnalysisCacheEntries,
  readAnalysisCache,
  writeAnalysisCache,
} from "./analysis-cache";
import {
  exportEntriesAnkiToPath,
  exportEntriesJsonToPath,
  importEntriesFromPath,
  listEntries,
  makeSongKey,
  newEntryId,
  removeEntry,
  saveEntry,
  type NotebookEntry,
} from "./notebook";
import {
  ambiguityMarker,
  formatBadgeLabel,
  jlptLookup,
  type JlptEntry,
} from "./jlpt";

const APP_VERSION = "0.1.0";
const FEEDBACK_URL = "https://lyriclens.yoru-and-akari.dev/feedback";

// ─── types ───────────────────────────────────────────────────

type NowPlaying = {
  title: string; artist: string; album: string;
  durationMs: number; positionMs: number; capturedAtMs: number;
  status: string;
  // SMTC LastUpdatedTime as Unix ms. 0 → source has never reported
  // timeline; if it stops changing while status is "playing", the source
  // isn't pushing updates.
  lastUpdatedRawMs: number;
  // SMTC PlaybackRate (1.0 = normal). null when the source doesn't
  // report it — treat as 1.0 for extrapolation.
  playbackRate: number | null;
  // e.g. "Spotify.exe", used by the debug panel to disambiguate sibling
  // sessions when Windows brokers multiple media apps at once.
  sourceAppUserModelId: string;
};
// Layered timeline classification, per SMTC timeline research §7.3.
// `timeline_healthy`/`timeline_candidate` → per-line sync is safe;
// `metadata_only`/`timeline_dead` → fall back to expandAll cards;
// `timeline_unstable` → show cards but flag the user that sync is
// jumpy. `unknown` is the boot state before we have any snapshot.
type TimelineHealth =
  | "unknown"
  | "metadata_only"
  | "timeline_candidate"
  | "timeline_healthy"
  | "timeline_unstable"
  | "timeline_dead";
type LyricLine = { timeMs: number; text: string };
type LyricResult = {
  id: number; trackName: string; artistName: string;
  albumName?: string | null; duration?: number | null;
  instrumental: boolean; plainLyrics?: string | null;
  syncedLyrics?: string | null;
};
type CmdError =
  | { kind: "no_session" }
  | { kind: "not_found" }
  | { kind: "timeout"; message: string }
  | { kind: "connect"; message: string }
  | { kind: "http_status"; message: string; status: number }
  | { kind: "error"; message: string };

type Theme = "akari" | "yoru";
type FontSize = "compact" | "standard" | "large";
type Settings = {
  autoAnalyze: boolean;
  theme: Theme;
  fontSize: FontSize;
  panelOpacity: number; // 40-100
  apiEndpoint: string;
  apiKey: string;
  modelName: string;
  targetLanguage: string;
  knowledgePoints: KnowledgePoint[];
  customPrompt: string;
  cardGenerationMode: CardMode;
  analyzeTimeoutSecs: number;
  maxAnalysisLines: number;
  analyzeMaxTokens: number;
  analyzeTemperature: number;
  thinkingMode: ThinkingMode;
  responseFormatMode: ResponseFormatMode;
  fallbackOnTimeout: boolean;
  fallbackTimeoutSecs: number;
  fallbackMaxLines: number;
  fallbackMaxTokens: number;
};

// ─── persistence ─────────────────────────────────────────────

const SETTINGS_KEY = "lyriclens.desktop.settings";
const VALID_POINTS: KnowledgePoint[] = [
  "vocabulary", "grammar", "culture", "pronunciation", "tone",
];

const DEFAULT_SETTINGS: Settings = {
  autoAnalyze: true,
  theme: "yoru",
  fontSize: "standard",
  panelOpacity: 100,
  apiEndpoint: "",
  apiKey: "",
  modelName: "",
  targetLanguage: "简体中文",
  knowledgePoints: [...VALID_POINTS],
  customPrompt: "",
  cardGenerationMode: "per-line",
  analyzeTimeoutSecs: 60,
  maxAnalysisLines: 80,
  analyzeMaxTokens: 4096,
  analyzeTemperature: 0.2,
  thinkingMode: "off",
  responseFormatMode: "auto",
  fallbackOnTimeout: true,
  fallbackTimeoutSecs: 25,
  fallbackMaxLines: 12,
  fallbackMaxTokens: 2048,
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const p = JSON.parse(raw) as Partial<Settings>;
    const points = Array.isArray(p.knowledgePoints)
      ? (p.knowledgePoints.filter((k) =>
          VALID_POINTS.includes(k as KnowledgePoint),
        ) as KnowledgePoint[])
      : [...DEFAULT_SETTINGS.knowledgePoints];
    return {
      autoAnalyze: p.autoAnalyze !== false,
      theme: p.theme === "akari" ? "akari" : "yoru",
      fontSize: (["compact", "standard", "large"] as FontSize[]).includes(
        p.fontSize as FontSize,
      )
        ? (p.fontSize as FontSize)
        : "standard",
      panelOpacity: clamp(
        Number.isFinite(Number(p.panelOpacity))
          ? Number(p.panelOpacity)
          : DEFAULT_SETTINGS.panelOpacity,
        40,
        100,
      ),
      apiEndpoint: typeof p.apiEndpoint === "string" ? p.apiEndpoint : "",
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      modelName: typeof p.modelName === "string" ? p.modelName : "",
      targetLanguage:
        typeof p.targetLanguage === "string" && p.targetLanguage.trim()
          ? p.targetLanguage
          : DEFAULT_SETTINGS.targetLanguage,
      knowledgePoints: points,
      customPrompt: typeof p.customPrompt === "string" ? p.customPrompt : "",
      cardGenerationMode:
        p.cardGenerationMode === "selected" ? "selected" : "per-line",
      analyzeTimeoutSecs: clamp(
        Number.isFinite(Number(p.analyzeTimeoutSecs))
          ? Number(p.analyzeTimeoutSecs)
          : DEFAULT_SETTINGS.analyzeTimeoutSecs,
        15,
        180,
      ),
      maxAnalysisLines: clamp(
        Number.isFinite(Number(p.maxAnalysisLines))
          ? Math.round(Number(p.maxAnalysisLines))
          : DEFAULT_SETTINGS.maxAnalysisLines,
        5,
        80,
      ),
      analyzeMaxTokens: clamp(
        Number.isFinite(Number(p.analyzeMaxTokens))
          ? Math.round(Number(p.analyzeMaxTokens))
          : DEFAULT_SETTINGS.analyzeMaxTokens,
        256,
        16000,
      ),
      analyzeTemperature: clamp(
        Number.isFinite(Number(p.analyzeTemperature))
          ? Number(p.analyzeTemperature)
          : DEFAULT_SETTINGS.analyzeTemperature,
        0,
        1,
      ),
      thinkingMode: (["off", "auto", "high", "max"] as ThinkingMode[]).includes(
        p.thinkingMode as ThinkingMode,
      )
        ? (p.thinkingMode as ThinkingMode)
        : "off",
      responseFormatMode: (
        ["auto", "json_object", "off"] as ResponseFormatMode[]
      ).includes(p.responseFormatMode as ResponseFormatMode)
        ? (p.responseFormatMode as ResponseFormatMode)
        : "auto",
      fallbackOnTimeout: p.fallbackOnTimeout !== false,
      fallbackTimeoutSecs: clamp(
        Number.isFinite(Number(p.fallbackTimeoutSecs))
          ? Number(p.fallbackTimeoutSecs)
          : DEFAULT_SETTINGS.fallbackTimeoutSecs,
        15,
        180,
      ),
      fallbackMaxLines: clamp(
        Number.isFinite(Number(p.fallbackMaxLines))
          ? Math.round(Number(p.fallbackMaxLines))
          : DEFAULT_SETTINGS.fallbackMaxLines,
        5,
        80,
      ),
      fallbackMaxTokens: clamp(
        Number.isFinite(Number(p.fallbackMaxTokens))
          ? Math.round(Number(p.fallbackMaxTokens))
          : DEFAULT_SETTINGS.fallbackMaxTokens,
        256,
        16000,
      ),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: Settings) {
  // Credentials are persisted via credentials_write on the Rust side —
  // strip them here so localStorage never holds the API key and the
  // two stores can't drift apart. loadSettings still *reads* legacy
  // credential fields so pre-migration users keep their values until
  // refreshCredentialsFromDisk writes them through to disk.
  const { apiEndpoint, apiKey, modelName, ...prefs } = s;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs));
}

// ─── credentials (Rust-side persistence) ─────────────────────

// apiEndpoint / apiKey / modelName live in credentials.json under
// app_data_dir instead of localStorage: localStorage is per-origin, so
// dev (http://localhost:<port>) and release (tauri://localhost) each
// get their own copy and every build-target or dev-port switch lost
// the key. UI preferences stay in localStorage — resetting those to
// defaults is harmless.
type Credentials = {
  apiEndpoint: string;
  apiKey: string;
  modelName: string;
};

function persistCredentials(s: Settings): Promise<void> {
  const creds: Credentials = {
    apiEndpoint: s.apiEndpoint,
    apiKey: s.apiKey,
    modelName: s.modelName,
  };
  return invoke<void>("credentials_write", { creds });
}

// Runs once at module init. Disk wins over whatever loadSettings got
// from localStorage; all-empty disk with legacy localStorage values
// present means "pre-migration user" — write them through once so the
// next origin change can't lose them. state is only touched after the
// first await, i.e. after module init has finished, so referencing it
// from here is safe.
async function refreshCredentialsFromDisk(): Promise<void> {
  try {
    const disk = await invoke<Credentials>("credentials_read");
    if (disk.apiEndpoint || disk.apiKey || disk.modelName) {
      state.settings.apiEndpoint = disk.apiEndpoint;
      state.settings.apiKey = disk.apiKey;
      state.settings.modelName = disk.modelName;
    } else if (
      state.settings.apiEndpoint ||
      state.settings.apiKey ||
      state.settings.modelName
    ) {
      await persistCredentials(state.settings);
    }
  } catch (err) {
    console.warn("credentials hydrate failed", err);
  }
}

// Analysis awaits this so the first auto-analyze after startup can't
// race the disk read and land in missing-config while a key sits in
// credentials.json. Local file read — resolves in milliseconds.
const credentialsReady = refreshCredentialsFromDisk();

function normalizeEndpoint(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  const stripped = v.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(stripped)) return stripped;
  if (/\/v1$/i.test(stripped)) return `${stripped}/chat/completions`;
  return stripped;
}

// ─── theme / font-size / opacity ─────────────────────────────

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const icon = document.querySelector<SVGSVGElement>("#theme-icon");
  if (icon) {
    icon.innerHTML =
      theme === "akari"
        ? `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`
        : `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
  }
}

function applyFontSize(size: FontSize) {
  document.documentElement.setAttribute("data-font-size", size);
}

function applyOpacity(pct: number) {
  // Real window transparency: tauri.conf.json has `transparent: true`,
  // so the webview itself is see-through. We control how much the
  // desktop bleeds through by setting --window-alpha on :root, which
  // is consumed by .app and .settings-overlay's rgb(.../alpha)
  // background. Surfaces like the now-playing bar stay opaque.
  const a = clamp(pct, 40, 100) / 100;
  document.documentElement.style.setProperty("--window-alpha", String(a));
}

// ─── DOM helpers ─────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const el = {
  title: () => $("#np-title"),
  artist: () => $("#np-artist"),
  album: () => $("#np-album"),
  status: () => $("#np-status"),
  timing: () => $("#np-timing"),
  lyrics: () => $("#lyrics"),
  refresh: () => $<HTMLButtonElement>("#btn-refresh"),
  pauseFollowBtn: () => $<HTMLButtonElement>("#btn-pause-follow"),
  pauseFollowLabel: () => $(".pause-follow-label"),
  settingsBtn: () => $<HTMLButtonElement>("#btn-settings"),
  themeBtn: () => $<HTMLButtonElement>("#btn-theme"),
  notebookBtn: () => $<HTMLButtonElement>("#btn-notebook"),
  notebookOverlay: () => $("#notebook-overlay"),
  notebookCloseBtn: () => $<HTMLButtonElement>("#btn-notebook-close"),
  overlay: () => $("#settings-overlay"),
  closeBtn: () => $<HTMLButtonElement>("#btn-settings-close"),
  cancelBtn: () => $<HTMLButtonElement>("#btn-settings-cancel"),
  saveBtn: () => $<HTMLButtonElement>("#btn-settings-save"),
  footerStatus: () => $("#footer-status"),
  testStatus: () => $("#test-status"),
  testBtn: () => $<HTMLButtonElement>("#btn-test-conn"),
  saveToast: () => $("#save-toast"),
  aboutVersion: () => $("#about-version"),
  updSub: () => $("#upd-sub"),
  // form fields
  fEndpoint: () => $<HTMLInputElement>("#cfg-endpoint"),
  fKey: () => $<HTMLInputElement>("#cfg-key"),
  fModel: () => $<HTMLInputElement>("#cfg-model"),
  fTarget: () => $<HTMLInputElement>("#cfg-target"),
  fPrompt: () => $<HTMLTextAreaElement>("#cfg-prompt"),
  fCardMode: () => $<HTMLSelectElement>("#cfg-card-mode"),
  fTimeout: () => $<HTMLInputElement>("#cfg-timeout"),
  fMaxLines: () => $<HTMLInputElement>("#cfg-max-lines"),
  fMaxTokens: () => $<HTMLInputElement>("#cfg-max-tokens"),
  fTemp: () => $<HTMLInputElement>("#cfg-temp"),
  fThinking: () => $<HTMLSelectElement>("#cfg-thinking"),
  fRf: () => $<HTMLSelectElement>("#cfg-rf"),
  fFbTimeout: () => $<HTMLInputElement>("#cfg-fb-timeout"),
  fFbLines: () => $<HTMLInputElement>("#cfg-fb-lines"),
  fFbTokens: () => $<HTMLInputElement>("#cfg-fb-tokens"),
  // toggles
  tglAuto: () => $<HTMLLabelElement>("#tgl-auto-analyze"),
  tglFb: () => $<HTMLLabelElement>("#tgl-fallback"),
  // slider
  sldOpacity: () => $<HTMLInputElement>("#sld-opacity"),
  sldOpacityVal: () => $("#sld-opacity-val"),
  // feedback
  fbEmail: () => $<HTMLInputElement>("#fb-email"),
  fbBody: () => $<HTMLTextAreaElement>("#fb-body"),
  fbCount: () => $("#fb-count"),
  fbStatus: () => $("#fb-status"),
  fbSend: () => $<HTMLButtonElement>("#btn-fb-send"),
  // debug
  debugCurrent: () => $("#debug-current"),
  debugAllSessions: () => $("#debug-all-sessions"),
  // notebook
  notebookCount: () => $("#notebook-count"),
  notebookList: () => $("#notebook-list"),
  notebookRefresh: () => $<HTMLButtonElement>("#btn-notebook-refresh"),
  notebookImportJson: () => $<HTMLButtonElement>("#btn-notebook-import-json"),
  notebookExportJson: () => $<HTMLButtonElement>("#btn-notebook-export-json"),
  notebookExportAnki: () => $<HTMLButtonElement>("#btn-notebook-export-anki"),
  notebookBatchBar: () => $("#notebook-batch-bar"),
  // analysis cache
  cacheStats: () => $("#cache-stats"),
  cacheClear: () => $<HTMLButtonElement>("#btn-cache-clear"),
  // note-edit sheet
  noteSheet: () => $("#note-sheet"),
  noteSheetTitle: () => $("#note-sheet-title"),
  noteSheetSub: () => $("#note-sheet-sub"),
  noteSheetLine: () => $("#note-sheet-line"),
  noteSheetTextarea: () => $<HTMLTextAreaElement>("#note-sheet-textarea"),
  noteSheetStatus: () => $("#note-sheet-status"),
  noteSheetCount: () => $("#note-sheet-count"),
  noteSheetSave: () => $<HTMLButtonElement>("#btn-note-sheet-save"),
};

// ─── state ───────────────────────────────────────────────────

type AnalysisStatus = "idle" | "loading" | "ready" | "error" | "missing-config";

const state = {
  np: null as NowPlaying | null,
  trackKey: "",
  lines: [] as LyricLine[],
  fetchingLyrics: false,
  fetchingLyricsKey: "",
  lyricsMessage: "",
  analysis: {
    trackKey: "",
    settingsSignature: "",
    status: "idle" as AnalysisStatus,
    cards: new Map<number, AnalysisCard>(),
    message: "",
    controller: null as AbortController | null,
    // True when the current ready state came back from analysis-cache
    // instead of a fresh LLM call. Swaps the card's right-side badge
    // from "ready" to "cached" so cache hits are visible without
    // opening DevTools.
    fromCache: false,
  },
  settings: loadSettings(),
  dirty: false,
  // Most recent default focus block written into the prompt textarea.
  // If the textarea still matches this string when target language or
  // points change, we transparently regenerate so the preview tracks
  // the rule changes. Once the user types anything new the textarea
  // diverges and we leave it alone.
  lastDefaultPrompt: "",
  // Cache of the last innerHTML written into #lyrics. pollSmtc fires
  // every second and re-renders unconditionally; without this cache,
  // each second wipes and rebuilds the lyric list, retriggering the
  // analysis-card-enter animation and making cards visibly flicker.
  lastLyricsHtml: "",
  // Rolling window of NowPlaying snapshots for the *current* trackKey.
  // Feeds classifyTimeline so we can tell metadata_only from
  // timeline_healthy / timeline_unstable. Cleared on track change so a
  // healthy previous song doesn't paper over a broken new one.
  snapshots: [] as NowPlaying[],
  timelineHealth: "unknown" as TimelineHealth,
  // Populated by pollAllSessions only while the debug panel is open, so
  // we don't pay for an extra Tauri command every second when nobody is
  // looking.
  allSessions: [] as NowPlaying[],
  debugPanelOpen: false,
  // While true, the lyric view freezes on `frozenActiveIdx` regardless
  // of what the playback position actually does. Now-playing strip
  // keeps showing real position so the user can see where the song
  // moved to. Auto-cleared on track change — a new song means a new
  // context, no point in carrying the freeze over.
  followPaused: false,
  frozenActiveIdx: -1,
  // Keyed by `${songKey}:${lineIndex}` — the same business key the
  // Rust side enforces with UNIQUE. Loaded once at boot and kept in
  // sync by toggleStarForLine / refreshNotebookEntries; the notebook
  // tab also reuses this map instead of refetching every render.
  notebook: {
    entries: new Map<string, NotebookEntry>(),
    loaded: false,
    lastError: "",
    // Entry ids currently checked in the notebook tab — drives both
    // the batch-action toolbar and the per-entry `.is-selected` class.
    // Cleared whenever the tab closes so a re-open starts fresh.
    selectedIds: new Set<string>(),
  },
  // The note-edit sheet floats above settings overlay; when open it
  // captures focus and Escape. entryId tracks which entry we're editing
  // so save knows where to write.
  noteSheet: {
    open: false,
    entryId: "",
  },
  // True only while a star/unstar request is in flight, so the UI can
  // disable the star button and avoid double-fires.
  starBusy: new Set<number>(),
  notebookPanelOpen: false,
};

const SNAPSHOT_WINDOW = 5;

function pushSnapshot(np: NowPlaying) {
  state.snapshots.push(np);
  if (state.snapshots.length > SNAPSHOT_WINDOW) {
    state.snapshots.splice(0, state.snapshots.length - SNAPSHOT_WINDOW);
  }
}

// Port of SMTC timeline research §7.3, with tighter false-positive
// guards: we refuse to call timeline "healthy" until we've actually
// observed position advance at a sane rate. Players that publish a
// frozen position (NetEase Win32 in some builds) or only push a
// one-shot snapshot would otherwise be mis-classified as healthy.
// Buckets drive renderLyrics: healthy/candidate → per-line sync,
// metadata_only/dead → expand all cards, unstable → cards + warning.
function classifyTimeline(snapshots: NowPlaying[]): TimelineHealth {
  if (snapshots.length === 0) return "unknown";
  const latest = snapshots[snapshots.length - 1];
  if (!latest.title && !latest.artist) return "unknown";

  const hasDuration = latest.durationMs > 30_000;
  const hasPosition =
    latest.positionMs >= 0 && latest.positionMs <= latest.durationMs + 2_000;

  // No usable duration AND position pinned at 0 → the player only ever
  // hands us metadata (NetEase Win32, QQ Music with SMTC disabled, etc).
  if (!hasDuration && latest.positionMs === 0) return "metadata_only";
  if (!hasDuration || !hasPosition) return "timeline_unstable";

  // We need at least 3 snapshots before we can tell "real timeline" from
  // "frozen at first tick". Until we get there, stay honest with unknown
  // so the UI can show "等待" instead of flashing green.
  if (snapshots.length < 3) return "unknown";

  const recent = snapshots.slice(-5);
  const lastUpdatedChanged = recent.some(
    (s, i) => i > 0 && s.lastUpdatedRawMs !== recent[i - 1].lastUpdatedRawMs,
  );

  // While "playing", position should advance by roughly dt * rate per
  // tick. If it advances by < 10% of that across a >2s window, the
  // player is faking a timeline — promote to metadata_only (no
  // LastUpdatedTime activity) or candidate (player still pings, but
  // position is frozen, so per-line sync would be wrong).
  if (latest.status === "playing") {
    let totalDt = 0;
    let totalAdvance = 0;
    for (let i = 1; i < recent.length; i++) {
      const dt = recent[i].capturedAtMs - recent[i - 1].capturedAtMs;
      if (dt <= 0) continue;
      totalDt += dt;
      totalAdvance += recent[i].positionMs - recent[i - 1].positionMs;
    }
    if (totalDt >= 2_000) {
      const rate = latest.playbackRate ?? 1;
      const expected = totalDt * rate;
      const ratio = expected > 0 ? totalAdvance / expected : 0;
      if (ratio < 0.1) {
        return lastUpdatedChanged ? "timeline_candidate" : "metadata_only";
      }
    }
  }

  // Big delta between observed position and locally extrapolated
  // position = the player is jumping around. Apple Music on Windows is
  // the canonical case; Lyricify's docs called out unstable timelines
  // there too.
  const jumpy = recent.some((s, i) => {
    if (i === 0) return false;
    const prev = recent[i - 1];
    const dtMs = s.capturedAtMs - prev.capturedAtMs;
    if (dtMs <= 0) return false;
    const rate = prev.playbackRate ?? 1;
    const predicted =
      prev.status === "playing" ? prev.positionMs + dtMs * rate : prev.positionMs;
    return Math.abs(s.positionMs - predicted) > 3_000;
  });

  if (jumpy) return "timeline_unstable";
  return "timeline_healthy";
}

function timelineHealthLabel(h: TimelineHealth): string {
  switch (h) {
    case "timeline_healthy": return "Healthy";
    case "timeline_candidate": return "Candidate";
    case "timeline_unstable": return "Unstable";
    case "metadata_only": return "Metadata only";
    case "timeline_dead": return "Dead";
    case "unknown":
    default: return "Unknown";
  }
}

// ─── lyric flow ──────────────────────────────────────────────

// Schema-canonical song key — same shape the notebook uses, so the
// analysis-cache key and a notebook entry's songKey are now always
// identical for the same NowPlaying snapshot. Pre-convergence the
// cache stripped trim() (kept stable across this refactor by the
// CACHE_VERSION bump in analysis-cache.ts).
function trackKey(np: NowPlaying | null): string {
  if (!np?.title || !np.artist) return "";
  return makeSongKey(np.title, np.artist, np.durationMs);
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60).toString().padStart(2, "0");
  const ss = (total % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function liveStatus(np: NowPlaying | null): { label: string; live: boolean } {
  if (!np) return { label: "无播放器", live: false };
  if (!np.title) return { label: "会话为空", live: false };
  if (np.status === "playing") return { label: "正在播放", live: true };
  const map: Record<string, string> = {
    paused: "已暂停",
    stopped: "已停止",
    changing: "切换中",
    closed: "已关闭",
    opened: "已打开",
  };
  return { label: map[np.status] || np.status, live: false };
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const POINT_TYPE_LABELS: Record<AnalysisCard["points"][number]["type"], string> = {
  vocabulary: "词汇",
  grammar: "语法",
  culture: "文化背景",
  pronunciation: "发音",
  tone: "语感",
  general: "补充",
};

// JLPT lookup cache lives in module scope, not `state`, because it's a
// pure derived view of the Rust store (which itself is the disk cache).
// Losing this Map on hot-reload is harmless — the next render pass
// re-populates from the Rust side in <1ms.
const jlptLookupCache = new Map<string, JlptEntry[]>();
const jlptPendingLookups = new Map<string, Promise<JlptEntry[]>>();

function jlptSlotKey(surface: string, reading: string): string {
  return `${surface}|${reading}`;
}

// Render an empty slot for the JLPT badge, or empty string if the point
// isn't eligible. The actual label is filled in by hydrateJlptBadges
// after the parent innerHTML lands — Tauri's invoke is async and the
// render pipeline is sync string concatenation, so a two-phase pattern
// keeps the initial paint from blocking on IPC.
function renderJlptBadgeSlot(point: AnalysisCard["points"][number]): string {
  if (point.type !== "vocabulary" && point.type !== "grammar") return "";
  const surface = point.surface?.trim();
  if (!surface) return "";
  const reading = point.reading?.trim() ?? "";
  // data-* attrs are read back by hydrateJlptBadges. The slot renders
  // an empty span (no space in the DOM until badge lands) so cards
  // without a matching JLPT entry don't leave a visible gap.
  return `<span class="jlpt-badge-slot" data-surface="${escapeHtml(surface)}" data-reading="${escapeHtml(reading)}"></span>`;
}

function applyJlptBadge(slot: HTMLElement, entries: JlptEntry[]): void {
  slot.classList.add("hydrated");
  const label = formatBadgeLabel(entries);
  if (!label) {
    // Miss → render nothing (schema doc §UI 渲染规则:
    // 未命中 → 不显示 badge (不显示「未知」，避免噪音)).
    slot.innerHTML = "";
    return;
  }
  const marker = ambiguityMarker(entries);
  const display = marker ? `${label}${marker}` : label;
  const title = marker
    ? "JLPT 参考等级 · surface 匹配 · reading 未确认 · 数据来自 Bluskyo / Tanos community list"
    : "JLPT 参考等级 · 数据来自 Bluskyo / Tanos community list";
  slot.innerHTML = `<span class="jlpt-badge" title="${escapeHtml(title)}">${escapeHtml(display)}</span>`;
}

// Walk a subtree looking for un-hydrated JLPT badge slots, resolve each
// through cache-or-invoke, and fill the resulting badge. Safe to call
// after every renderLyrics / renderNotebookPanel — cache-hit slots are
// filled synchronously in the same tick, so the visible flicker is
// bounded to the length of the *first* invoke per (surface, reading).
function hydrateJlptBadges(root: ParentNode): void {
  const slots = root.querySelectorAll<HTMLElement>(
    ".jlpt-badge-slot:not(.hydrated)",
  );
  for (const slot of Array.from(slots)) {
    const surface = slot.dataset.surface ?? "";
    if (!surface) {
      slot.classList.add("hydrated");
      continue;
    }
    const reading = slot.dataset.reading ?? "";
    const key = jlptSlotKey(surface, reading);
    const cached = jlptLookupCache.get(key);
    if (cached) {
      applyJlptBadge(slot, cached);
      continue;
    }
    let pending = jlptPendingLookups.get(key);
    if (!pending) {
      pending = jlptLookup(surface, reading || undefined);
      jlptPendingLookups.set(key, pending);
      pending
        .then((entries) => {
          jlptLookupCache.set(key, entries);
        })
        .finally(() => {
          jlptPendingLookups.delete(key);
        });
    }
    pending.then((entries) => {
      // The DOM may have re-rendered by now; setting innerHTML on a
      // detached element is a no-op that costs nothing, and the next
      // render will find the slot via cache-hit and fill it synchronously.
      applyJlptBadge(slot, entries);
    });
  }
}

// Business key that joins lyric line to NotebookEntry, mirroring the
// UNIQUE(song_key, line_index) constraint on the Rust side. Anywhere
// we need "is this line starred for the current song?" goes through
// here so we never accidentally desync the index.
function notebookKey(songKey: string, lineIndex: number): string {
  return `${songKey}:${lineIndex}`;
}


function findEntryForLine(lineIndex: number): NotebookEntry | undefined {
  const songKey = trackKey(state.np);
  if (!songKey) return undefined;
  return state.notebook.entries.get(notebookKey(songKey, lineIndex));
}

async function loadNotebookEntries(): Promise<void> {
  try {
    const entries = await listEntries();
    state.notebook.entries.clear();
    for (const entry of entries) {
      state.notebook.entries.set(
        notebookKey(entry.songKey, entry.lineIndex),
        entry,
      );
    }
    state.notebook.loaded = true;
    state.notebook.lastError = "";
  } catch (err) {
    state.notebook.lastError =
      (err as { message?: string })?.message || String(err);
    console.warn("notebook list failed", err);
  }
}

async function toggleStarForLine(lineIndex: number): Promise<void> {
  const np = state.np;
  const card = state.analysis.cards.get(lineIndex);
  if (!np || !card) return;
  const songKey = trackKey(np);
  if (!songKey) return;
  if (state.starBusy.has(lineIndex)) return;
  state.starBusy.add(lineIndex);
  // Force re-render so the disabled state shows up immediately.
  state.lastLyricsHtml = "";
  renderLyrics();

  try {
    const key = notebookKey(songKey, lineIndex);
    const existing = state.notebook.entries.get(key);
    if (existing) {
      const removed = await removeEntry(existing.id);
      if (removed) state.notebook.entries.delete(key);
    } else {
      const now = Date.now();
      const lineText = state.lines[lineIndex]?.text?.trim()
        || card.original.trim()
        || "♪";
      const entry: NotebookEntry = {
        id: newEntryId(),
        songKey,
        songTitle: np.title.trim() || np.title,
        songArtist: np.artist.trim() || np.artist,
        lineIndex,
        lineText,
        card,
        userNote: "",
        starredAt: now,
        updatedAt: now,
        source: "desktop",
      };
      const stored = await saveEntry(entry);
      state.notebook.entries.set(key, stored);
    }
  } catch (err) {
    const msg = (err as { message?: string })?.message || String(err);
    state.notebook.lastError = msg;
    console.warn("notebook toggle failed", err);
  } finally {
    state.starBusy.delete(lineIndex);
    state.lastLyricsHtml = "";
    renderLyrics();
    // If the notebook panel is open, refresh it so the new/removed
    // entry shows up without the user having to reopen the tab.
    if (state.notebookPanelOpen) renderNotebookPanel();
  }
}

function resetAnalysis(trackKeyValue = "") {
  state.analysis.controller?.abort();
  state.analysis.trackKey = trackKeyValue;
  state.analysis.settingsSignature = "";
  state.analysis.status = "idle";
  state.analysis.cards = new Map();
  state.analysis.message = "";
  state.analysis.controller = null;
  state.analysis.fromCache = false;
}

function renderAnalysisCard(card: AnalysisCard): string {
  const start = card.startMs;
  const time = Number.isFinite(start) && start !== null ? ` · ${formatTime(start)}` : "";
  // fromCache flips this badge to "cached" on cache-hit replays, so the
  // user can spot a hit without opening DevTools. The state is per-
  // analysis (all cards from one run share the same source), so reading
  // the global flag is correct.
  const statusBadge = state.analysis.fromCache ? "cached" : "ready";
  const badgeClass = state.analysis.fromCache
    ? "analysis-status is-cached"
    : "analysis-status";
  const isStarred = !!findEntryForLine(card.lineIndex);
  const isBusy = state.starBusy.has(card.lineIndex);
  // SVG: outlined star at rest, filled when on. CSS swaps fill via the
  // `.is-on` class so we only ship one path.
  const starBtn = `<button type="button" class="star-btn${isStarred ? " is-on" : ""}"
      data-star-line="${card.lineIndex}"
      aria-pressed="${isStarred ? "true" : "false"}"
      aria-label="${isStarred ? "取消收藏到笔记本" : "收藏到笔记本"}"
      title="${isStarred ? "已收藏 · 点击取消" : "收藏到笔记本"}"
      ${isBusy ? "disabled" : ""}>
      <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="12 2.5 14.94 8.86 21.95 9.74 16.78 14.55 18.18 21.5 12 17.97 5.82 21.5 7.22 14.55 2.05 9.74 9.06 8.86 12 2.5"/>
      </svg>
    </button>`;
  const translation = card.translation.trim()
    ? `<div class="translation-block">
        <span class="translation-label">translation</span>
        <p class="translation-text">${escapeHtml(card.translation)}</p>
      </div>`
    : "";
  const points = card.points
    .map((point) => {
      const label = POINT_TYPE_LABELS[point.type] || POINT_TYPE_LABELS.general;
      const jlptSlot = renderJlptBadgeSlot(point);
      return `<div class="point-row">
        <span class="point-badge ${escapeHtml(point.type)}">${escapeHtml(label)}</span>
        <p class="point-text">${escapeHtml(point.text)}</p>
        ${jlptSlot}
      </div>`;
    })
    .join("");
  const note = card.note.trim()
    ? `<p class="analysis-note">note · ${escapeHtml(card.note.trim())}</p>`
    : "";

  return `<article class="analysis-card" aria-label="当前歌词学习卡片">
    <div class="analysis-head">
      <div class="analysis-kicker">
        <span class="analysis-dot" aria-hidden="true"></span>
        <span class="analysis-title">analysis${time}</span>
      </div>
      <div class="analysis-head-right">
        ${starBtn}
        <span class="${badgeClass}">${statusBadge}</span>
      </div>
    </div>
    ${translation}
    ${points ? `<div class="point-list">${points}</div>` : ""}
    ${note}
  </article>`;
}

function fmtTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mo = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}`;
}

function renderNotebookEntry(entry: NotebookEntry): string {
  const time =
    typeof entry.card.startMs === "number" && entry.card.startMs >= 0
      ? formatTime(entry.card.startMs)
      : "—";
  const selected = state.notebook.selectedIds.has(entry.id);
  const translation = entry.card.translation.trim()
    ? `<div class="notebook-entry-translation">${escapeHtml(entry.card.translation)}</div>`
    : "";
  // The card's points + LLM note are the actual study payload. Earlier
  // builds only rendered translation here, which made it look like the
  // notebook had lost the vocab/grammar — they were always in the DB,
  // just unreachable from this view.
  const points = entry.card.points
    .map((p) => {
      const label = POINT_TYPE_LABELS[p.type] || POINT_TYPE_LABELS.general;
      const jlptSlot = renderJlptBadgeSlot(p);
      return `<div class="point-row">
        <span class="point-badge ${escapeHtml(p.type)}">${escapeHtml(label)}</span>
        <p class="point-text">${escapeHtml(p.text)}</p>
        ${jlptSlot}
      </div>`;
    })
    .join("");
  const llmNote = entry.card.note.trim()
    ? `<p class="notebook-entry-analysis-note">note · ${escapeHtml(entry.card.note.trim())}</p>`
    : "";
  // userNote: hide entirely when empty so the entry doesn't pad itself
  // with a placeholder line that adds no info. The "加备注" footer
  // button (label flips from "编辑" when empty) is the obvious way in.
  const userNote = entry.userNote.trim()
    ? `<div class="notebook-entry-note">${escapeHtml(entry.userNote)}</div>`
    : "";
  return `<article class="notebook-entry${selected ? " is-selected" : ""}" data-entry-id="${escapeHtml(entry.id)}">
    <header class="notebook-entry-head">
      <label class="notebook-entry-check" title="选中">
        <input type="checkbox" data-select-entry="${escapeHtml(entry.id)}" ${selected ? "checked" : ""} aria-label="选中这条收藏" />
      </label>
      <div class="notebook-entry-meta">
        <span class="notebook-entry-song">
          <span class="title">${escapeHtml(entry.songTitle)}</span>
          <span class="sep" aria-hidden="true">·</span>
          <span class="artist">${escapeHtml(entry.songArtist)}</span>
        </span>
        <span class="notebook-entry-time mono">${time}</span>
      </div>
    </header>
    <div class="notebook-entry-body">
      <div class="notebook-entry-hero">
        <div class="notebook-entry-line">${escapeHtml(entry.lineText)}</div>
        ${translation}
      </div>
      ${points ? `<div class="point-list">${points}</div>` : ""}
      ${llmNote}
      ${userNote}
    </div>
    <footer class="notebook-entry-foot">
      <span class="notebook-entry-stamp mono">${fmtTimestamp(entry.starredAt)}</span>
      <div class="notebook-entry-actions">
        <button type="button" data-edit-entry="${escapeHtml(entry.id)}">${entry.userNote.trim() ? "编辑备注" : "加备注"}</button>
        <button type="button" class="danger" data-remove-entry="${escapeHtml(entry.id)}">删除</button>
      </div>
    </footer>
  </article>`;
}

function renderNotebookPanel(): void {
  const listEl = el.notebookList();
  const countEl = el.notebookCount();
  if (!listEl || !countEl) return;
  const total = state.notebook.entries.size;
  if (state.notebook.lastError && total === 0) {
    countEl.textContent = "加载失败";
    listEl.innerHTML = `<p class="placeholder">读取笔记本失败 · ${escapeHtml(state.notebook.lastError)}</p>`;
    renderNotebookBatchBar();
    return;
  }
  countEl.textContent = total === 0 ? "尚无收藏" : `共 ${total} 条`;
  if (total === 0) {
    listEl.innerHTML = `<p class="placeholder">在歌词卡片右上角点 ★ 收藏第一张。</p>`;
    renderNotebookBatchBar();
    return;
  }
  // Drop selection ids that no longer exist (e.g. just got removed
  // elsewhere) so the batch bar count stays honest.
  for (const id of Array.from(state.notebook.selectedIds)) {
    let stillExists = false;
    for (const entry of state.notebook.entries.values()) {
      if (entry.id === id) {
        stillExists = true;
        break;
      }
    }
    if (!stillExists) state.notebook.selectedIds.delete(id);
  }
  // Sort by starredAt desc (most recent first) — the Rust list() returns
  // them already sorted, but using the in-memory map means we have to
  // sort here regardless.
  const sorted = Array.from(state.notebook.entries.values()).sort(
    (a, b) => b.starredAt - a.starredAt,
  );
  listEl.innerHTML = sorted.map(renderNotebookEntry).join("");
  hydrateJlptBadges(listEl);
  renderNotebookBatchBar();
}

function renderNotebookBatchBar(): void {
  const bar = el.notebookBatchBar();
  if (!bar) return;
  const selectedCount = state.notebook.selectedIds.size;
  const total = state.notebook.entries.size;
  if (selectedCount === 0) {
    bar.classList.remove("is-active");
    bar.innerHTML = "";
    return;
  }
  const allSelected = selectedCount === total;
  bar.classList.add("is-active");
  bar.innerHTML = `
    <span class="notebook-batch-count">已选 ${selectedCount} / ${total}</span>
    <div class="notebook-batch-actions">
      <button type="button" id="btn-notebook-toggle-all">${allSelected ? "取消全选" : "全选"}</button>
      <button type="button" class="danger" id="btn-notebook-delete-selected">删除选中</button>
    </div>
  `;
}

function toggleNotebookSelection(id: string): void {
  if (state.notebook.selectedIds.has(id)) {
    state.notebook.selectedIds.delete(id);
  } else {
    state.notebook.selectedIds.add(id);
  }
  renderNotebookPanel();
}

function toggleNotebookSelectAll(): void {
  const total = state.notebook.entries.size;
  if (state.notebook.selectedIds.size === total) {
    state.notebook.selectedIds.clear();
  } else {
    state.notebook.selectedIds.clear();
    for (const entry of state.notebook.entries.values()) {
      state.notebook.selectedIds.add(entry.id);
    }
  }
  renderNotebookPanel();
}

async function deleteSelectedNotebookEntries(): Promise<void> {
  const ids = Array.from(state.notebook.selectedIds);
  if (ids.length === 0) return;
  const ok = window.confirm(
    `确认删除 ${ids.length} 条收藏？此操作不可撤销。`,
  );
  if (!ok) return;
  // Parallel removeEntry calls — each one hits a single SQLite DELETE
  // so contention is negligible and the user-facing wait is the slowest
  // round-trip, not the sum.
  const results = await Promise.allSettled(ids.map((id) => removeEntry(id)));
  let removedCount = 0;
  for (let i = 0; i < ids.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      removedCount++;
      // Drop the entry from the in-memory map so the rerender is correct
      // without waiting on a full reload round-trip.
      for (const [key, entry] of state.notebook.entries.entries()) {
        if (entry.id === ids[i]) {
          state.notebook.entries.delete(key);
          break;
        }
      }
    }
  }
  state.notebook.selectedIds.clear();
  // Lyric view reads from the same map, so refresh it too in case any
  // of the deleted entries was on the currently-playing song.
  state.lastLyricsHtml = "";
  renderLyrics();
  renderNotebookPanel();
  if (removedCount < ids.length) {
    console.warn(`notebook batch delete: removed ${removedCount}/${ids.length}`);
  }
}

type ExportFormat = "json" | "anki";

const EXPORT_FORMATS: Record<
  ExportFormat,
  {
    title: string;
    ext: string;
    filterName: string;
    invoke: (path: string) => Promise<number>;
  }
> = {
  json: {
    title: "导出笔记本 JSON",
    ext: "json",
    filterName: "JSON",
    invoke: exportEntriesJsonToPath,
  },
  anki: {
    // .tsv is the right extension for tab-separated; Anki's importer
    // accepts both .txt and .tsv but .tsv tells Yoru at a glance what
    // it is when she looks at her downloads folder.
    title: "导出笔记本 Anki TSV",
    ext: "tsv",
    filterName: "Anki TSV",
    invoke: exportEntriesAnkiToPath,
  },
};

async function exportNotebookAs(format: ExportFormat): Promise<void> {
  const cfg = EXPORT_FORMATS[format];
  // YYYY-MM-DD in local time — matches what Yoru sees on the system
  // clock when she's looking at the file picker. For JSON the schema's
  // exportedAt field carries the precise UTC timestamp anyway, so this
  // is purely a usability nudge.
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  const defaultName = `lyriclens-notebook-${yyyy}-${mm}-${dd}.${cfg.ext}`;

  let path: string | null;
  try {
    path = await saveDialog({
      title: cfg.title,
      defaultPath: defaultName,
      filters: [{ name: cfg.filterName, extensions: [cfg.ext] }],
    });
  } catch (err) {
    console.warn(`notebook export (${format}) · save dialog failed`, err);
    showToast("打开保存对话框失败");
    return;
  }
  if (!path) return; // user cancelled

  try {
    const count = await cfg.invoke(path);
    const basename = path.split(/[\\/]/).pop() ?? path;
    showToast(`已导出 ${count} 条 · ${basename}`);
  } catch (err) {
    const msg =
      typeof err === "object" && err && "message" in err
        ? (err as { message?: string }).message ?? String(err)
        : String(err);
    console.warn(`notebook export (${format}) failed`, err);
    showToast(`导出失败 · ${msg}`);
  }
}

async function importNotebookJson(): Promise<void> {
  let path: string | string[] | null;
  try {
    path = await openDialog({
      title: "导入笔记本 JSON",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) {
    console.warn("notebook import · open dialog failed", err);
    showToast("打开文件对话框失败");
    return;
  }
  if (!path || Array.isArray(path)) return; // cancelled or unexpected shape

  try {
    const summary = await importEntriesFromPath(path);
    // Refresh both the in-memory map (lyric view reads from it) and the
    // notebook panel; import may have changed any entry's userNote /
    // card snapshot so a render with stale data would mislead.
    await loadNotebookEntries();
    state.lastLyricsHtml = "";
    renderLyrics();
    if (state.notebookPanelOpen) renderNotebookPanel();
    showToast(
      `导入完成 · 新 ${summary.imported} · 合并 ${summary.merged} · 跳过 ${summary.skipped}`,
    );
    if (summary.errors.length > 0) {
      // Detail messages get logged for the user to inspect via
      // DevTools; the toast itself stays terse so it doesn't overflow.
      console.warn(`notebook import: ${summary.errors.length} entries had errors`, summary.errors);
    }
  } catch (err) {
    const msg =
      typeof err === "object" && err && "message" in err
        ? (err as { message?: string }).message ?? String(err)
        : String(err);
    console.warn("notebook import failed", err);
    showToast(`导入失败 · ${msg}`);
  }
}

function updateCacheStats(): void {
  const stats = el.cacheStats();
  if (!stats) return;
  const count = countAnalysisCacheEntries();
  stats.textContent = count === 0 ? "尚无缓存" : `${count} 首歌`;
}

function openNoteSheet(entryId: string): void {
  const entry = Array.from(state.notebook.entries.values()).find(
    (e) => e.id === entryId,
  );
  if (!entry) return;
  state.noteSheet.open = true;
  state.noteSheet.entryId = entryId;
  const sheet = el.noteSheet();
  if (!sheet) return;
  sheet.setAttribute("aria-hidden", "false");
  sheet.classList.add("open");
  el.noteSheetSub().textContent = `${entry.songTitle} · ${entry.songArtist}`;
  el.noteSheetLine().textContent = entry.lineText;
  const ta = el.noteSheetTextarea();
  ta.value = entry.userNote;
  el.noteSheetCount().textContent = String(entry.userNote.length);
  el.noteSheetStatus().textContent = "未保存";
  el.noteSheetStatus().className = "test-status pending";
  // Focus after the next frame so the sheet's transition lands first.
  requestAnimationFrame(() => ta.focus());
}

function closeNoteSheet(): void {
  state.noteSheet.open = false;
  state.noteSheet.entryId = "";
  const sheet = el.noteSheet();
  if (!sheet) return;
  sheet.setAttribute("aria-hidden", "true");
  sheet.classList.remove("open");
}

async function saveNoteSheet(): Promise<void> {
  const entryId = state.noteSheet.entryId;
  if (!entryId) return;
  const entry = Array.from(state.notebook.entries.values()).find(
    (e) => e.id === entryId,
  );
  if (!entry) return;
  const ta = el.noteSheetTextarea();
  const nextNote = ta.value;
  const now = Date.now();
  const updated: NotebookEntry = {
    ...entry,
    userNote: nextNote,
    updatedAt: now,
  };
  const status = el.noteSheetStatus();
  const saveBtn = el.noteSheetSave();
  saveBtn.disabled = true;
  status.textContent = "保存中…";
  status.className = "test-status pending";
  try {
    const stored = await saveEntry(updated);
    state.notebook.entries.set(
      notebookKey(stored.songKey, stored.lineIndex),
      stored,
    );
    if (state.notebookPanelOpen) renderNotebookPanel();
    status.textContent = "已保存";
    status.className = "test-status ok";
    // Auto-dismiss the sheet after a beat so the success is visible.
    setTimeout(closeNoteSheet, 350);
  } catch (err) {
    const msg = (err as { message?: string })?.message || String(err);
    status.textContent = `失败 · ${msg}`;
    status.className = "test-status err";
  } finally {
    saveBtn.disabled = false;
  }
}

async function removeNotebookEntry(entryId: string): Promise<void> {
  const entry = Array.from(state.notebook.entries.values()).find(
    (e) => e.id === entryId,
  );
  if (!entry) return;
  const ok = window.confirm(
    `删除「${entry.songTitle} · ${entry.songArtist}」的这条收藏？`,
  );
  if (!ok) return;
  try {
    const removed = await removeEntry(entryId);
    if (removed) {
      state.notebook.entries.delete(
        notebookKey(entry.songKey, entry.lineIndex),
      );
      renderNotebookPanel();
      // The lyric view shows star state from the same map — re-render
      // so the previously-starred line goes back to a hollow icon.
      state.lastLyricsHtml = "";
      renderLyrics();
    }
  } catch (err) {
    console.warn("notebook remove failed", err);
  }
}

function renderAnalysisSlot(lineIndex: number): string {
  // Inline slot is now reserved for the ready state — loading / error /
  // missing-config show up in the top status line so the user still sees
  // them when SMTC doesn't report timeline (no active line).
  const analysis = state.analysis;
  if (!state.trackKey || analysis.trackKey !== state.trackKey) return "";
  if (analysis.status !== "ready") return "";
  const card = analysis.cards.get(lineIndex);
  return card ? renderAnalysisCard(card) : "";
}

function renderAnalysisStatusLine(activeIdx: number, expandAll: boolean): string {
  const analysis = state.analysis;
  if (!state.trackKey || analysis.trackKey !== state.trackKey) return "";
  // Paused-follow takes precedence — the user explicitly froze the view
  // and needs to know that's why playback isn't advancing the highlight.
  if (state.followPaused) {
    return `<div class="analysis-status-line setup" role="status">
      <span class="analysis-dot" aria-hidden="true"></span>
      <span>已暂停跟随 · 点底部"恢复跟随"回到当前播放位置</span>
    </div>`;
  }
  if (analysis.status === "loading") {
    const text = analysis.message
      ? escapeHtml(analysis.message)
      : "正在生成学习卡片…";
    return `<div class="analysis-status-line loading" role="status">
      <span class="analysis-dot" aria-hidden="true"></span>
      <span>${text}</span>
    </div>`;
  }
  if (analysis.status === "missing-config") {
    return `<div class="analysis-status-line setup" role="status">
      <span class="analysis-dot" aria-hidden="true"></span>
      <span>${escapeHtml(analysis.message)}</span>
    </div>`;
  }
  if (analysis.status === "error") {
    return `<div class="analysis-status-line error" role="status">
      <span class="analysis-dot" aria-hidden="true"></span>
      <span>分析失败 · ${escapeHtml(analysis.message)}</span>
    </div>`;
  }
  if (analysis.status === "ready") {
    const total = analysis.cards.size;
    if (total === 0) {
      return `<div class="analysis-status-line setup" role="status">
        <span class="analysis-dot" aria-hidden="true"></span>
        <span>模型返回为空，没生成卡片</span>
      </div>`;
    }
    if (expandAll) {
      // Different reasons end up in the same expand-all rendering — be
      // specific so the user knows whether to switch player vs wait.
      const reason =
        state.timelineHealth === "timeline_dead"
          ? "播放器停止上报 timeline"
          : state.timelineHealth === "metadata_only"
            ? "播放器只暴露歌曲信息，timeline 不可用"
            : "未拿到可用的 timeline";
      return `<div class="analysis-status-line ready" role="status">
        <span class="analysis-dot" aria-hidden="true"></span>
        <span>${reason} · 已铺开全部 ${total} 张精选卡片</span>
      </div>`;
    }
    if (state.timelineHealth === "timeline_unstable") {
      return `<div class="analysis-status-line setup" role="status">
        <span class="analysis-dot" aria-hidden="true"></span>
        <span>timeline 不稳定 · 卡片同步可能有偏移（${total} 张已就绪）</span>
      </div>`;
    }
    if (activeIdx < 0 || !analysis.cards.has(activeIdx)) {
      return `<div class="analysis-status-line ready" role="status">
        <span class="analysis-dot" aria-hidden="true"></span>
        <span>${total} 张卡片已就绪 · 等待播放位置</span>
      </div>`;
    }
    return "";
  }
  return "";
}

function isFallbackEligibleError(err: unknown): boolean {
  // Anything that's "we got something back but it was unusable" is worth
  // a fallback retry: timeout, truncated JSON, empty content, etc. We
  // deliberately do NOT fall back on auth/endpoint errors (HTTP 401/403/
  // 404) — those would just fail the second time too.
  const msg = (err as Error)?.message || String(err);
  if (/HTTP 40[134]/.test(msg)) return false;
  return (
    msg.includes("超时") ||
    msg.includes("不是 JSON") ||
    msg.includes("不是可解析的 JSON") ||
    msg.includes("内容为空") ||
    msg.includes("不是合法 JSON") ||
    /timeout|aborted/i.test(msg)
  );
}

async function startAnalysisForTrack(trackKeyValue: string, lines: LyricLine[]) {
  // Settings must not be read before disk credentials have hydrated
  // (see credentialsReady) — resolved long before any non-startup call.
  await credentialsReady;
  const inputLines = toAnalysisInputLines(lines, state.settings.maxAnalysisLines);
  resetAnalysis(trackKeyValue);
  // Capture once: state.analysis.settingsSignature can be reset out from
  // under us if the user saves settings mid-flight (which triggers a new
  // startAnalysisForTrack via the save handler), and we still need the
  // original key to write cache against.
  const signature = analysisSettingsSignature(state.settings);
  state.analysis.settingsSignature = signature;

  if (!inputLines.length) {
    renderLyrics();
    return;
  }

  const missing = missingAnalysisConfig(state.settings);
  if (missing) {
    state.analysis.status = "missing-config";
    state.analysis.message = missing;
    renderLyrics();
    return;
  }

  // Cache hit means same (track, signature) was successfully analyzed
  // before — replay cards instantly without burning tokens. Signature
  // includes prompt / model / mode / temperature etc., so changing any
  // of those falls through to a real request.
  const cached = readAnalysisCache(trackKeyValue, signature);
  if (cached) {
    state.analysis.status = "ready";
    state.analysis.cards = new Map(cached.map((card) => [card.lineIndex, card]));
    state.analysis.message = "";
    state.analysis.fromCache = true;
    renderLyrics();
    return;
  }

  const controller = new AbortController();
  state.analysis.status = "loading";
  state.analysis.message = "";
  state.analysis.controller = controller;
  renderLyrics();

  const stillCurrent = () =>
    !controller.signal.aborted && state.trackKey === trackKeyValue;

  try {
    const cards = await requestAnalysis(state.settings, inputLines, controller.signal);
    // Cache before the stillCurrent gate — the cards ARE correct for
    // this (track, signature) pair regardless of whether the user has
    // since moved to another song, and stashing them now means a
    // back-and-forth flick will hit cache instead of re-calling the LLM.
    writeAnalysisCache(trackKeyValue, signature, cards);
    if (!stillCurrent()) return;
    state.analysis.status = "ready";
    state.analysis.cards = new Map(cards.map((card) => [card.lineIndex, card]));
    state.analysis.message = "";
    state.analysis.fromCache = false;
  } catch (err) {
    if (!stillCurrent()) return;

    // Fallback retry: per-line mode against a long lyric easily blows
    // past max_tokens (truncated JSON) or the 60s budget (reasoning
    // models like DeepSeek V4/R1). Switch to "selected" mode + smaller
    // budgets — 6-8 lines fits comfortably in 2048 tokens.
    const canFallback =
      isFallbackEligibleError(err) && state.settings.fallbackOnTimeout;

    if (!canFallback) {
      state.analysis.status = "error";
      state.analysis.message = (err as Error)?.message || String(err);
      state.analysis.cards = new Map();
      return;
    }

    const fallbackSettings: AnalysisSettings = {
      ...state.settings,
      analyzeTimeoutSecs: state.settings.fallbackTimeoutSecs,
      analyzeMaxTokens: state.settings.fallbackMaxTokens,
      maxAnalysisLines: state.settings.fallbackMaxLines,
      cardGenerationMode: "selected",
    };
    const fallbackInputLines = toAnalysisInputLines(
      lines,
      fallbackSettings.maxAnalysisLines,
    );
    const primaryReason = ((err as Error)?.message || "").includes("超时")
      ? "超时"
      : "输出截断 / 解析失败";
    state.analysis.message = `首次请求${primaryReason} · 切换 selected 模式（${fallbackSettings.maxAnalysisLines} 行 / ${fallbackSettings.analyzeMaxTokens} tokens）重试…`;
    renderLyrics();

    try {
      const cards = await requestAnalysis(
        fallbackSettings,
        fallbackInputLines,
        controller.signal,
      );
      // Cache under the ORIGINAL signature, not the fallback's. If the
      // user revisits this song with the same primary settings, we want
      // the cards to come back instantly — re-running primary just to
      // fail and fall back again would defeat the cache's purpose.
      writeAnalysisCache(trackKeyValue, signature, cards);
      if (!stillCurrent()) return;
      state.analysis.status = "ready";
      state.analysis.cards = new Map(cards.map((card) => [card.lineIndex, card]));
      state.analysis.message = "";
      state.analysis.fromCache = false;
    } catch (err2) {
      if (!stillCurrent()) return;
      state.analysis.status = "error";
      const m2 = (err2 as Error)?.message || String(err2);
      state.analysis.message = `首次 + 精简重试均失败 · ${m2}`;
      state.analysis.cards = new Map();
    }
  } finally {
    if (state.analysis.controller === controller) {
      state.analysis.controller = null;
      renderLyrics();
    }
  }
}

function computeActiveIdx(pos: number): number {
  let idx = -1;
  for (let i = 0; i < state.lines.length; i++) {
    if (state.lines[i].timeMs <= pos) idx = i;
    else break;
  }
  return idx;
}

function renderLyrics() {
  const container = el.lyrics();
  const pos = extrapolatedPositionMs(state.np);
  // While follow is paused, the active line stays where the user froze
  // it. We still compute the *real* idx for now-playing-strip purposes,
  // but the rendered view is locked.
  const liveIdx = computeActiveIdx(pos);
  // Detect "lyrics have no usable timeline" — happens when LRCLIB only
  // had plainLyrics and we fell back to text-with-timeMs=0. Without
  // this guard computeActiveIdx returns the LAST line forever (every
  // 0 <= pos), pinning the card view to whatever the last plain line
  // says — for ninelie that was the literal "(End)" marker at the
  // bottom of a romaji transliteration.
  const lyricsHaveTimeline = state.lines.some((line) => line.timeMs > 0);
  const activeIdx = state.followPaused
    ? state.frozenActiveIdx
    : lyricsHaveTimeline
      ? liveIdx
      : -1;
  container.classList.toggle("is-paused", state.followPaused);
  // Timeline health drives the layout: when SMTC isn't giving us a
  // usable position (NetEase/QQ Win32 = `metadata_only`, sources that
  // stopped reporting = `timeline_dead`), there's no active line to
  // anchor cards to, so we fan all of them out. `timeline_unstable`
  // still has a position, just jittery — we keep per-line sync and let
  // the status line warn the user. `timeline_candidate` is good enough
  // for per-line; we only fail closed on metadata_only/dead.
  //
  // The lyric-side fallback (`!lyricsHaveTimeline`) joins the same
  // bucket because the symptom is identical: no anchor for a single
  // card, but a complete set of LLM cards that should still be shown.
  const noTimeline =
    !lyricsHaveTimeline ||
    state.timelineHealth === "metadata_only" ||
    state.timelineHealth === "timeline_dead";
  const expandAll =
    noTimeline &&
    state.analysis.status === "ready" &&
    state.analysis.cards.size > 0;
  const statusLine = renderAnalysisStatusLine(activeIdx, expandAll);
  let nextHtml: string;
  if (state.lyricsMessage && state.lines.length === 0) {
    nextHtml = `${statusLine}<p class="placeholder">${escapeHtml(state.lyricsMessage)}</p>`;
  } else if (state.lines.length === 0) {
    nextHtml = `${statusLine}<p class="placeholder">播放任意歌曲，SMTC 会自动识别。</p>`;
  } else {
    const html = state.lines
      .map((line, i) => {
        const classes = ["line"];
        if (i === activeIdx) classes.push("active");
        else if (i < activeIdx) classes.push("past");
        else classes.push("future");
        const text = line.text || "♪";
        const showCard =
          i === activeIdx || (expandAll && state.analysis.cards.has(i));
        const card = showCard ? renderAnalysisSlot(i) : "";
        return `<div class="${classes.join(" ")}" data-i="${i}">${escapeHtml(text)}</div>${card}`;
      })
      .join("");
    nextHtml = `${statusLine}${html}`;
  }
  if (nextHtml === state.lastLyricsHtml) return;
  state.lastLyricsHtml = nextHtml;
  container.innerHTML = nextHtml;
  // JLPT badge slots need a post-render pass: cache-hit slots fill in
  // the same tick, cache-miss slots kick off an invoke and fill when it
  // resolves. Idempotent — subsequent renderLyrics calls that hit the
  // lastLyricsHtml early-exit above don't re-scan.
  hydrateJlptBadges(container);
  // Never auto-scroll while follow is paused — the whole point is to
  // let the user dwell on a card without the view dragging away.
  if (state.followPaused) return;
  const active = container.querySelector<HTMLElement>(".line.active");
  if (active) {
    // The inline card renders right after the active line; if we centre
    // the *line*, the card sits in the bottom half of the viewport and
    // the user has to scroll. Centre the card instead when it exists —
    // the active line lands just above, both stay visible together.
    const sibling = active.nextElementSibling as HTMLElement | null;
    const target = sibling?.classList.contains("analysis-card") ? sibling : active;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// Translate the typed CmdError from the Rust side into a single-line
// status the user can actually act on. "error sending request for url
// ..." used to leak straight through from reqwest; that read like a bug
// rather than a connectivity hiccup. Each transport kind now gets its
// own plain-Chinese phrasing.
function describeLyricFetchError(err: unknown): string {
  const e = err as CmdError | { message?: string };
  const kind = (e as CmdError)?.kind;
  switch (kind) {
    case "not_found":
      return "LRCLIB 没找到这首歌。";
    case "timeout":
      return "查询超时 · LRCLIB 一直没回应（重试过一次仍失败）";
    case "connect":
      return "连不上 LRCLIB · 网络可能被拦截，稍后再试";
    case "http_status": {
      const { status } = e as Extract<CmdError, { kind: "http_status" }>;
      return status >= 500
        ? `LRCLIB 服务暂时不可用 · HTTP ${status}`
        : `LRCLIB 拒绝请求 · HTTP ${status}`;
    }
    case "error":
    default: {
      const msg = (e as { message?: string })?.message ?? String(err);
      return `查询出错 · ${msg}`;
    }
  }
}

async function fetchLyricsFor(np: NowPlaying) {
  const key = trackKey(np);
  if (state.fetchingLyricsKey === key) return;
  if (!np.title || !np.artist) {
    state.lines = [];
    state.lyricsMessage = "缺少歌曲标题或艺人，无法查询。";
    resetAnalysis(key);
    renderLyrics();
    return;
  }
  state.fetchingLyrics = true;
  state.fetchingLyricsKey = key;
  state.lyricsMessage = "正在 LRCLIB 查询…";
  state.lines = [];
  resetAnalysis(key);
  renderLyrics();
  let canAnalyze = false;
  try {
    const result = await invoke<LyricResult>("lrclib_find", {
      trackName: np.title,
      artistName: np.artist,
      albumName: np.album || null,
      durationSecs: np.durationMs > 0 ? np.durationMs / 1000 : null,
    });
    if (state.trackKey !== key) return;
    if (result.instrumental) {
      state.lines = [];
      state.lyricsMessage = "纯音乐 · LRCLIB 未标注歌词。";
    } else if (result.syncedLyrics) {
      const lines = await invoke<LyricLine[]>("lrclib_parse_synced", {
        synced: result.syncedLyrics,
      });
      state.lines = lines;
      state.lyricsMessage = "";
      canAnalyze = lines.length > 0;
    } else if (result.plainLyrics) {
      state.lines = result.plainLyrics
        .split(/\r?\n/)
        .filter((s) => s.length > 0)
        .map((text) => ({ timeMs: 0, text }));
      state.lyricsMessage = "仅纯文本歌词，无时间轴。";
      canAnalyze = state.lines.length > 0;
    } else {
      state.lines = [];
      state.lyricsMessage = "LRCLIB 命中但歌词为空。";
    }
  } catch (err) {
    state.lyricsMessage = describeLyricFetchError(err);
    state.lines = [];
  } finally {
    if (state.fetchingLyricsKey === key) {
      state.fetchingLyrics = false;
      state.fetchingLyricsKey = "";
    }
    renderLyrics();
    if (canAnalyze && state.trackKey === key && state.settings.autoAnalyze) {
      void startAnalysisForTrack(key, state.lines);
    }
  }
}

// Per-session snapshot windows for the debug panel. Each row in
// "全部 SMTC 会话" needs its own classification, so we key on
// SourceAppUserModelId. Cleared whenever debug panel closes to keep this
// from leaking memory across long sessions.
const allSessionSnapshots = new Map<string, NowPlaying[]>();

function fmtUnixMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const mmm = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function fmtRate(rate: number | null): string {
  if (rate === null || rate === undefined) return "null";
  return rate.toFixed(2) + "×";
}

function renderSessionCard(np: NowPlaying, health: TimelineHealth): string {
  const healthClass = `health-${health.replace(/_/g, "-")}`;
  const healthLabel = timelineHealthLabel(health);
  const source = np.sourceAppUserModelId || "(未上报)";
  const trackLabel = np.title
    ? `${np.title}${np.artist ? " · " + np.artist : ""}`
    : "(无元数据)";
  return `<article class="debug-card">
    <header class="debug-card-head">
      <div class="debug-card-title">
        <span class="debug-source mono">${escapeHtml(source)}</span>
        <span class="debug-track">${escapeHtml(trackLabel)}</span>
      </div>
      <span class="health-badge ${healthClass}" title="timeline health">${escapeHtml(healthLabel)}</span>
    </header>
    <div class="debug-grid">
      <div class="kv-row"><span class="kv-key">status</span><span class="kv-val mono">${escapeHtml(np.status)}</span></div>
      <div class="kv-row"><span class="kv-key">position / duration</span><span class="kv-val mono">${formatTime(np.positionMs)} / ${formatTime(np.durationMs)}</span></div>
      <div class="kv-row"><span class="kv-key">positionMs</span><span class="kv-val mono">${np.positionMs}</span></div>
      <div class="kv-row"><span class="kv-key">durationMs</span><span class="kv-val mono">${np.durationMs}</span></div>
      <div class="kv-row"><span class="kv-key">lastUpdated</span><span class="kv-val mono">${fmtUnixMs(np.lastUpdatedRawMs)}</span></div>
      <div class="kv-row"><span class="kv-key">capturedAt</span><span class="kv-val mono">${fmtUnixMs(np.capturedAtMs)}</span></div>
      <div class="kv-row"><span class="kv-key">playbackRate</span><span class="kv-val mono">${fmtRate(np.playbackRate)}</span></div>
    </div>
  </article>`;
}

function renderDebugPanel() {
  const current = el.debugCurrent();
  if (current) {
    if (state.np) {
      current.innerHTML = renderSessionCard(state.np, state.timelineHealth);
    } else {
      current.innerHTML = `<p class="placeholder">没有当前会话（SMTC 没暴露 current session）。</p>`;
    }
  }

  const all = el.debugAllSessions();
  if (all) {
    if (state.allSessions.length === 0) {
      all.innerHTML = `<p class="placeholder">没有任何 SMTC 会话。</p>`;
    } else {
      all.innerHTML = state.allSessions
        .map((s) => {
          const id = s.sourceAppUserModelId || `${s.title}|${s.artist}`;
          const buf = allSessionSnapshots.get(id) ?? [s];
          return renderSessionCard(s, classifyTimeline(buf));
        })
        .join("");
    }
  }
}

async function pollSmtc() {
  try {
    const np = await invoke<NowPlaying>("smtc_now_playing");
    state.np = np;
    const key = trackKey(np);
    if (key && key !== state.trackKey) {
      state.trackKey = key;
      // New song → reset the classification window. Otherwise a healthy
      // previous track's snapshots would mask a broken new track for ~5s.
      state.snapshots = [];
      state.timelineHealth = "unknown";
      // New song = new context; carrying a freeze from the previous
      // track would leave the user staring at a card that no longer
      // matches the song playing.
      if (state.followPaused) setFollowPaused(false);
      if (state.settings.autoAnalyze) fetchLyricsFor(np);
    }
    pushSnapshot(np);
    state.timelineHealth = classifyTimeline(state.snapshots);
  } catch (err) {
    const e = err as CmdError;
    if (e?.kind === "no_session") {
      state.np = null;
      state.trackKey = "";
      state.lines = [];
      state.snapshots = [];
      state.timelineHealth = "unknown";
      // No song = no card to dwell on. Release the freeze so the user
      // doesn't have to think about it when they restart playback.
      if (state.followPaused) setFollowPaused(false);
      state.lyricsMessage = "没有活跃的 SMTC 会话。播放一首歌就行。";
      resetAnalysis();
    } else {
      state.np = null;
      state.snapshots = [];
      state.timelineHealth = "unknown";
      state.lyricsMessage = `SMTC 出错 · ${(e as { message?: string })?.message ?? String(err)}`;
      resetAnalysis();
    }
  }
  renderNowPlaying();
  renderLyrics();
  if (state.debugPanelOpen) {
    // Fetch the full session list only while the user is looking at the
    // debug tab. Failures here are silently ignored — the panel will
    // simply show the last known list.
    try {
      const sessions = await invoke<NowPlaying[]>("smtc_all_sessions");
      state.allSessions = sessions;
      for (const s of sessions) {
        const id = s.sourceAppUserModelId || `${s.title}|${s.artist}`;
        const buf = allSessionSnapshots.get(id) ?? [];
        buf.push(s);
        if (buf.length > SNAPSHOT_WINDOW) {
          buf.splice(0, buf.length - SNAPSHOT_WINDOW);
        }
        allSessionSnapshots.set(id, buf);
      }
    } catch {
      // ignored
    }
    renderDebugPanel();
  }
}

// ─── settings overlay ────────────────────────────────────────

function openSettings() {
  const overlay = el.overlay();
  overlay.setAttribute("aria-hidden", "false");
  overlay.classList.add("open");
  populateForm();
  setDirty(false);
  switchTab("general");
}

function closeSettings() {
  const overlay = el.overlay();
  overlay.setAttribute("aria-hidden", "true");
  overlay.classList.remove("open");
  // Discard any preview-only theme / font-size / opacity if not saved.
  applyTheme(state.settings.theme);
  applyFontSize(state.settings.fontSize);
  applyOpacity(state.settings.panelOpacity);
  // Stop paying for smtc_all_sessions when nobody's looking, and drop
  // the per-session snapshot buffers so they don't grow unbounded.
  state.debugPanelOpen = false;
  allSessionSnapshots.clear();
}

function openNotebook() {
  const overlay = el.notebookOverlay();
  overlay.setAttribute("aria-hidden", "false");
  overlay.classList.add("open");
  state.notebookPanelOpen = true;
  // Refetch every open — entries can change from any star click on
  // the lyric side. Cost is one SQLite query so the refresh is cheap
  // and we never serve a stale list.
  void (async () => {
    await loadNotebookEntries();
    renderNotebookPanel();
  })();
}

function closeNotebook() {
  const overlay = el.notebookOverlay();
  overlay.setAttribute("aria-hidden", "true");
  overlay.classList.remove("open");
  state.notebookPanelOpen = false;
  // Batch selection is transient — closing the overlay abandons it
  // so a reopen starts fresh instead of with stale checkboxes.
  state.notebook.selectedIds.clear();
  // The note-edit sheet floats above this overlay; closing the
  // notebook should dismiss it too so reopening doesn't surface a
  // stale entry.
  closeNoteSheet();
}

function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.tab === name),
  );
  document.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) =>
    p.classList.toggle("is-active", p.dataset.tab === name),
  );
  const isDebug = name === "debug";
  if (isDebug !== state.debugPanelOpen) {
    state.debugPanelOpen = isDebug;
    if (!isDebug) allSessionSnapshots.clear();
  }
  if (isDebug) {
    // Trigger an immediate fetch so the panel doesn't sit empty for up
    // to a second waiting for the next pollSmtc tick.
    void pollSmtc();
  }
  if (name === "advanced") {
    // Refresh the cache stats line every time the user comes back to
    // this tab — values change whenever a song finishes analyzing.
    updateCacheStats();
  }
}

function setDirty(dirty: boolean) {
  state.dirty = dirty;
  const status = el.footerStatus();
  if (dirty) {
    status.classList.add("dirty");
    status.textContent = "更改尚未保存";
  } else {
    status.classList.remove("dirty");
    status.textContent = "已应用";
  }
}

function setSegActive(group: string, value: string) {
  document
    .querySelectorAll<HTMLButtonElement>(`[data-seg="${group}"] .seg`)
    .forEach((b) => b.classList.toggle("is-active", b.dataset.value === value));
}

function setChipsActive(points: KnowledgePoint[]) {
  // .kp-option visual state is driven entirely by `input:checked` in
  // CSS, so we just sync the checked attribute and the browser handles
  // the box-and-tick rendering.
  document
    .querySelectorAll<HTMLLabelElement>("#cfg-points .kp-option")
    .forEach((opt) => {
      const p = opt.dataset.point as KnowledgePoint | undefined;
      const on = !!p && points.includes(p);
      const input = opt.querySelector<HTMLInputElement>("input");
      if (input) input.checked = on;
    });
}

function readKnowledgePointsFromForm(): KnowledgePoint[] {
  const points: KnowledgePoint[] = [];
  document
    .querySelectorAll<HTMLLabelElement>("#cfg-points .kp-option")
    .forEach((opt) => {
      const input = opt.querySelector<HTMLInputElement>("input");
      const point = opt.dataset.point as KnowledgePoint | undefined;
      if (input?.checked && point && VALID_POINTS.includes(point)) {
        points.push(point);
      }
    });
  return points;
}

function currentCardModeFromForm(): CardMode {
  return el.fCardMode().value === "selected" ? "selected" : "per-line";
}

// Regenerate the default focus block from the *form's current state*,
// not from saved settings, so the preview reflects unsaved edits.
function syncDefaultPrompt() {
  const target = el.fTarget().value.trim() || DEFAULT_SETTINGS.targetLanguage;
  const points = readKnowledgePointsFromForm();
  const isSelected = currentCardModeFromForm() === "selected";
  const next = buildDefaultFocus(target, points, isSelected);
  const ta = el.fPrompt();
  // Only auto-update if the user hasn't diverged from the previous
  // default. If they typed anything custom, leave it alone.
  if (ta.value === state.lastDefaultPrompt || ta.value === "") {
    ta.value = next;
  }
  state.lastDefaultPrompt = next;
}

function resetPromptToDefault() {
  const target = el.fTarget().value.trim() || DEFAULT_SETTINGS.targetLanguage;
  const points = readKnowledgePointsFromForm();
  const isSelected = currentCardModeFromForm() === "selected";
  const next = buildDefaultFocus(target, points, isSelected);
  el.fPrompt().value = next;
  state.lastDefaultPrompt = next;
  setDirty(true);
}

function setToggle(label: HTMLLabelElement, on: boolean) {
  label.classList.toggle("is-on", on);
  const input = label.querySelector<HTMLInputElement>("input");
  if (input) input.checked = on;
}

function populateForm() {
  const s = state.settings;

  // 常规
  setToggle(el.tglAuto(), s.autoAnalyze);
  setSegActive("theme", s.theme);
  setSegActive("fontSize", s.fontSize);
  el.sldOpacity().value = String(s.panelOpacity);
  el.sldOpacityVal().textContent = `${s.panelOpacity}%`;

  // AI
  el.fEndpoint().value = s.apiEndpoint;
  el.fKey().value = s.apiKey;
  el.fModel().value = s.modelName;
  el.fTarget().value = s.targetLanguage;
  setChipsActive(s.knowledgePoints);
  el.testStatus().textContent = "未测试";
  el.testStatus().className = "test-status pending";

  // 高级 — populate before prompt so syncDefaultPrompt sees the right
  // card-generation mode.
  el.fCardMode().value = s.cardGenerationMode;
  el.fTimeout().value = String(s.analyzeTimeoutSecs);
  el.fMaxLines().value = String(s.maxAnalysisLines);
  el.fMaxTokens().value = String(s.analyzeMaxTokens);
  el.fTemp().value = String(s.analyzeTemperature);
  el.fThinking().value = s.thinkingMode;
  el.fRf().value = s.responseFormatMode;
  setToggle(el.tglFb(), s.fallbackOnTimeout);
  el.fFbTimeout().value = String(s.fallbackTimeoutSecs);
  el.fFbLines().value = String(s.fallbackMaxLines);
  el.fFbTokens().value = String(s.fallbackMaxTokens);

  // Custom prompt: blank settings.customPrompt means "use the default
  // focus block", so we show the generated default in the textarea.
  // The plugin works the same way — what the user sees in the editor
  // is what the model will actually receive, regardless of whether
  // it's the auto-generated default or a hand-edited override.
  const defaultFocus = buildDefaultFocus(
    s.targetLanguage,
    s.knowledgePoints,
    s.cardGenerationMode === "selected",
  );
  el.fPrompt().value = s.customPrompt.trim() || defaultFocus;
  state.lastDefaultPrompt = defaultFocus;

  // 关于
  el.aboutVersion().textContent = `v${APP_VERSION}`;
  el.updSub().textContent = `v${APP_VERSION} · 未启用更新检查`;
}

function readForm(): Settings {
  const points = readKnowledgePointsFromForm();

  const themeSeg = document.querySelector<HTMLButtonElement>(
    '[data-seg="theme"] .seg.is-active',
  );
  const fontSeg = document.querySelector<HTMLButtonElement>(
    '[data-seg="fontSize"] .seg.is-active',
  );
  const theme: Theme = themeSeg?.dataset.value === "akari" ? "akari" : "yoru";
  const fontSize: FontSize =
    (fontSeg?.dataset.value as FontSize | undefined) || "standard";

  const autoOn = el.tglAuto().classList.contains("is-on");
  const fbOn = el.tglFb().classList.contains("is-on");
  const cardMode = currentCardModeFromForm();
  const targetLanguage =
    el.fTarget().value.trim() || DEFAULT_SETTINGS.targetLanguage;

  // If the textarea still matches the live default focus, persist
  // customPrompt as "" — that way the plugin-style "live default"
  // behavior carries through restarts: changing target language or
  // points later will still rewrite the preview instead of being
  // pinned to a stale snapshot.
  const currentDefault = buildDefaultFocus(
    targetLanguage,
    points,
    cardMode === "selected",
  );
  const promptValue = el.fPrompt().value;
  const customPrompt =
    promptValue.trim() === currentDefault.trim() ? "" : promptValue;

  return {
    autoAnalyze: autoOn,
    theme,
    fontSize,
    panelOpacity: clamp(Number(el.sldOpacity().value) || 100, 40, 100),
    apiEndpoint: el.fEndpoint().value.trim(),
    apiKey: el.fKey().value.trim(),
    modelName: el.fModel().value.trim(),
    targetLanguage,
    knowledgePoints: points,
    customPrompt,
    cardGenerationMode: cardMode,
    analyzeTimeoutSecs: clamp(Number(el.fTimeout().value) || 60, 15, 180),
    maxAnalysisLines: clamp(
      Math.round(Number(el.fMaxLines().value) || 80),
      5,
      80,
    ),
    analyzeMaxTokens: clamp(
      Math.round(Number(el.fMaxTokens().value) || 4096),
      256,
      16000,
    ),
    analyzeTemperature: clamp(Number(el.fTemp().value) || 0.2, 0, 1),
    thinkingMode: (el.fThinking().value as ThinkingMode) || "off",
    responseFormatMode: (el.fRf().value as ResponseFormatMode) || "auto",
    fallbackOnTimeout: fbOn,
    fallbackTimeoutSecs: clamp(Number(el.fFbTimeout().value) || 25, 15, 180),
    fallbackMaxLines: clamp(
      Math.round(Number(el.fFbLines().value) || 12),
      5,
      80,
    ),
    fallbackMaxTokens: clamp(
      Math.round(Number(el.fFbTokens().value) || 2048),
      256,
      16000,
    ),
  };
}

function showSavedToast() {
  const now = new Date();
  const hh = now.getHours().toString().padStart(2, "0");
  const mm = now.getMinutes().toString().padStart(2, "0");
  showToast(`已保存 · ${hh}:${mm}`);
}

// Generic toast for one-shot notifications. Reuses the .save-toast
// surface so it stays at the same spot Yoru already expects feedback
// to appear; the text is rewritten on every call so consecutive
// toasts (e.g. save → export) just overwrite each other cleanly.
function showToast(message: string) {
  const toast = el.saveToast();
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1800);
}

// ─── test connection ─────────────────────────────────────────

async function testConnection() {
  const status = el.testStatus();
  const btn = el.testBtn();
  const form = readForm();

  if (!form.apiEndpoint) {
    status.textContent = "请填 endpoint";
    status.className = "test-status err";
    return;
  }
  if (!form.apiKey) {
    status.textContent = "请填 API Key";
    status.className = "test-status err";
    return;
  }
  if (!form.modelName) {
    status.textContent = "请填模型名";
    status.className = "test-status err";
    return;
  }

  btn.disabled = true;
  status.textContent = "测试中…";
  status.className = "test-status pending";

  const url = normalizeEndpoint(form.apiEndpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const t0 = Date.now();

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${form.apiKey}`,
      },
      body: JSON.stringify({
        model: form.modelName,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (resp.ok) {
      status.textContent = `连接成功 · HTTP ${resp.status} · ${ms}ms`;
      status.className = "test-status ok";
    } else {
      const reason =
        resp.status === 401 || resp.status === 403
          ? "key/权限问题"
          : resp.status === 404
            ? "endpoint 或 model 不存在"
            : resp.status === 429
              ? "限流"
              : resp.status >= 500
                ? "服务端错误"
                : "";
      status.textContent =
        `失败 · HTTP ${resp.status}` + (reason ? ` · ${reason}` : "");
      status.className = "test-status err";
    }
  } catch (err) {
    clearTimeout(timer);
    const msg = (err as Error)?.message || String(err);
    status.textContent = msg.includes("abort")
      ? "失败 · 超时"
      : `失败 · ${msg.slice(0, 80)}`;
    status.className = "test-status err";
  } finally {
    btn.disabled = false;
  }
}

// ─── feedback ────────────────────────────────────────────────

async function sendFeedback() {
  const status = el.fbStatus();
  const btn = el.fbSend();
  const email = el.fbEmail().value.trim();
  const body = el.fbBody().value.trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    status.textContent = "请填合法邮箱";
    status.className = "test-status err";
    return;
  }
  if (!body) {
    status.textContent = "请填反馈内容";
    status.className = "test-status err";
    return;
  }

  btn.disabled = true;
  status.textContent = "发送中…";
  status.className = "test-status pending";

  try {
    const resp = await fetch(FEEDBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        body,
        app: "lyriclens-desktop",
        version: APP_VERSION,
        ua: navigator.userAgent,
      }),
    });
    if (resp.ok) {
      status.textContent = "已发送 · 感谢";
      status.className = "test-status ok";
      el.fbBody().value = "";
      el.fbCount().textContent = "0";
    } else if (resp.status === 429) {
      status.textContent = "失败 · 已达每日上限";
      status.className = "test-status err";
    } else {
      status.textContent = `失败 · HTTP ${resp.status}`;
      status.className = "test-status err";
    }
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    status.textContent = `失败 · ${msg.slice(0, 80)}`;
    status.className = "test-status err";
  } finally {
    btn.disabled = false;
  }
}

// ─── bindings ────────────────────────────────────────────────

function bindSettingsForm() {
  // Tabs
  document.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab) switchTab(tab);
    });
  });

  // Segmented (theme + fontSize), with live preview
  document
    .querySelectorAll<HTMLButtonElement>('[data-seg] .seg')
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = btn.closest("[data-seg]") as HTMLElement | null;
        const value = btn.dataset.value;
        if (!group || !value) return;
        const name = group.dataset.seg;
        if (!name) return;
        setSegActive(name, value);
        if (name === "theme") applyTheme(value as Theme);
        else if (name === "fontSize") applyFontSize(value as FontSize);
        setDirty(true);
      });
    });

  // Opacity slider — live preview
  el.sldOpacity().addEventListener("input", () => {
    const v = Number(el.sldOpacity().value) || 100;
    el.sldOpacityVal().textContent = `${v}%`;
    applyOpacity(v);
    setDirty(true);
  });

  // Toggles (auto-analyze, fallback-on-timeout)
  [el.tglAuto(), el.tglFb()].forEach((label) => {
    label.addEventListener("click", (e) => {
      e.preventDefault();
      const next = !label.classList.contains("is-on");
      setToggle(label, next);
      setDirty(true);
    });
  });

  // Knowledge-point checkboxes — the <label> wraps the <input>, so the
  // browser handles the .checked toggle natively. We just listen for
  // `change` to mark dirty and refresh the default-prompt preview if
  // the textarea still equals the previous default.
  document
    .querySelectorAll<HTMLInputElement>("#cfg-points input[type='checkbox']")
    .forEach((input) => {
      input.addEventListener("change", () => {
        syncDefaultPrompt();
        setDirty(true);
      });
    });

  // Target language and card-generation mode also feed into the default
  // prompt — refresh on every keystroke / change.
  el.fTarget().addEventListener("input", () => {
    syncDefaultPrompt();
    setDirty(true);
  });
  el.fCardMode().addEventListener("change", () => {
    syncDefaultPrompt();
    setDirty(true);
  });

  // Restore-default button: regenerate the focus block from current
  // form state and overwrite whatever's in the textarea.
  $<HTMLButtonElement>("#btn-prompt-reset").addEventListener("click", () => {
    resetPromptToDefault();
  });

  // Generic input listeners → mark dirty. (cfg-target and cfg-card-mode
  // are handled above with extra logic; the rest just need dirty.)
  const dirtyInputs = [
    "cfg-endpoint", "cfg-key", "cfg-model", "cfg-prompt",
    "cfg-timeout", "cfg-max-lines", "cfg-max-tokens",
    "cfg-temp", "cfg-thinking", "cfg-rf",
    "cfg-fb-timeout", "cfg-fb-lines", "cfg-fb-tokens",
  ];
  dirtyInputs.forEach((id) => {
    const node = document.getElementById(id);
    node?.addEventListener("input", () => setDirty(true));
    node?.addEventListener("change", () => setDirty(true));
  });

  // Feedback char counter
  el.fbBody().addEventListener("input", () => {
    el.fbCount().textContent = String(el.fbBody().value.length);
  });

  // External links via tauri-plugin-opener
  document.querySelectorAll<HTMLAnchorElement>("a[data-external]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(a.href).catch((err) => console.warn("openUrl failed", err));
    });
  });

  el.closeBtn().addEventListener("click", closeSettings);
  el.cancelBtn().addEventListener("click", closeSettings);
  el.saveBtn().addEventListener("click", () => {
    const next = readForm();
    const nextAnalysisSignature = analysisSettingsSignature(next);
    state.settings = next;
    saveSettings(next);
    void persistCredentials(next).catch(() => {
      // Failed disk write means the key only lives in memory now and
      // will be gone after restart — surface that instead of letting
      // the earlier "已保存" toast stand unchallenged.
      showToast("凭证写入磁盘失败 · 重启后可能需要重填 API Key");
    });
    applyTheme(next.theme);
    applyFontSize(next.fontSize);
    applyOpacity(next.panelOpacity);
    setDirty(false);
    showSavedToast();
    if (!next.autoAnalyze) {
      resetAnalysis(state.trackKey);
      renderLyrics();
    } else if (
      state.trackKey &&
      state.lines.length > 0 &&
      (nextAnalysisSignature !== state.analysis.settingsSignature ||
        state.analysis.status === "missing-config" ||
        state.analysis.status === "error")
    ) {
      void startAnalysisForTrack(state.trackKey, state.lines);
    }
  });
  el.testBtn().addEventListener("click", testConnection);
  el.fbSend().addEventListener("click", sendFeedback);

  // Cache clear button — confirmation lives in window.confirm so we
  // don't need a custom modal for what is a rare, irreversible action.
  el.cacheClear().addEventListener("click", () => {
    const count = countAnalysisCacheEntries();
    if (count === 0) return;
    if (!window.confirm(`确认清空 ${count} 首歌的分析缓存？下次播放需要重新调用 LLM。`)) {
      return;
    }
    clearAnalysisCache();
    updateCacheStats();
  });

  // Notebook tab — refresh on demand; the entry list also delegates
  // clicks for the edit / remove buttons each entry exposes.
  el.notebookRefresh().addEventListener("click", () => {
    void (async () => {
      await loadNotebookEntries();
      renderNotebookPanel();
    })();
  });
  el.notebookImportJson().addEventListener("click", () => {
    void importNotebookJson();
  });
  el.notebookExportJson().addEventListener("click", () => {
    void exportNotebookAs("json");
  });
  el.notebookExportAnki().addEventListener("click", () => {
    void exportNotebookAs("anki");
  });
  // Checkbox change → toggle the entry's id in selectedIds. Bound on
  // the input "change" event rather than "click" so keyboard space
  // also flips it.
  el.notebookList().addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input || input.type !== "checkbox") return;
    const id = input.dataset.selectEntry;
    if (id) toggleNotebookSelection(id);
  });
  el.notebookList().addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // Click on the checkbox itself goes through the change handler;
    // skip the action delegation so the box doesn't double-fire.
    if ((target as HTMLInputElement).type === "checkbox") return;
    const editId = target
      .closest<HTMLElement>("[data-edit-entry]")
      ?.dataset.editEntry;
    if (editId) {
      openNoteSheet(editId);
      return;
    }
    const removeId = target
      .closest<HTMLElement>("[data-remove-entry]")
      ?.dataset.removeEntry;
    if (removeId) {
      void removeNotebookEntry(removeId);
    }
  });

  // Batch bar buttons are re-rendered every time the selection
  // changes, so a delegated handler on the bar container survives
  // those rewrites. Only two ids land here.
  el.notebookBatchBar().addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("#btn-notebook-toggle-all")) {
      toggleNotebookSelectAll();
    } else if (target.closest("#btn-notebook-delete-selected")) {
      void deleteSelectedNotebookEntries();
    }
  });

  // Note-edit sheet bindings — every dismiss path (×, cancel, backdrop)
  // shares the same close handler via data-note-sheet-close.
  document
    .querySelectorAll<HTMLElement>("[data-note-sheet-close]")
    .forEach((node) => node.addEventListener("click", closeNoteSheet));
  el.noteSheetTextarea().addEventListener("input", () => {
    const v = el.noteSheetTextarea().value;
    el.noteSheetCount().textContent = String(v.length);
    el.noteSheetStatus().textContent = "未保存";
    el.noteSheetStatus().className = "test-status pending";
  });
  el.noteSheetSave().addEventListener("click", () => void saveNoteSheet());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.noteSheet.open) {
      closeNoteSheet();
    }
  });
}

// ─── boot ────────────────────────────────────────────────────

function setFollowPaused(paused: boolean) {
  if (state.followPaused === paused) return;
  state.followPaused = paused;
  if (paused) {
    // Capture where we are *right now* so future render passes pin to
    // this line instead of computing fresh each tick.
    const pos = extrapolatedPositionMs(state.np);
    state.frozenActiveIdx = computeActiveIdx(pos);
  } else {
    state.frozenActiveIdx = -1;
  }
  const btn = el.pauseFollowBtn();
  if (btn) {
    btn.setAttribute("aria-pressed", paused ? "true" : "false");
    btn.title = paused
      ? "恢复跟随当前播放位置"
      : "冻结当前画面，方便慢慢学";
  }
  const label = el.pauseFollowLabel();
  if (label) label.textContent = paused ? "恢复跟随" : "暂停跟随";
  // Force a re-render so the status line + scroll behaviour update
  // immediately instead of waiting for the next poll tick.
  state.lastLyricsHtml = "";
  renderLyrics();
}

function startLoops() {
  pollSmtc();
  setInterval(pollSmtc, 1_000);

  // High-frequency render so the extrapolated position + active line
  // stay smooth. Cheap because we only re-render when the active index
  // actually changes.
  let lastActive = -1;
  setInterval(() => {
    const pos = extrapolatedPositionMs(state.np);
    // While follow is paused, the rendered active line never moves —
    // skip the change-detect path so we don't trigger a wasted render.
    if (!state.followPaused) {
      const idx = computeActiveIdx(pos);
      if (idx !== lastActive) {
        lastActive = idx;
        renderLyrics();
      }
    }
    if (el.timing()) {
      el.timing().textContent = `${formatTime(pos)} / ${formatTime(
        state.np?.durationMs ?? 0,
      )}`;
    }
  }, 200);
}

window.addEventListener("DOMContentLoaded", () => {
  applyTheme(state.settings.theme);
  applyFontSize(state.settings.fontSize);
  applyOpacity(state.settings.panelOpacity);

  el.refresh().addEventListener("click", () => {
    state.trackKey = "";
    pollSmtc();
  });
  el.pauseFollowBtn().addEventListener("click", () => {
    setFollowPaused(!state.followPaused);
  });
  el.themeBtn().addEventListener("click", () => {
    const next: Theme = state.settings.theme === "yoru" ? "akari" : "yoru";
    state.settings.theme = next;
    saveSettings(state.settings);
    applyTheme(next);
  });
  el.settingsBtn().addEventListener("click", openSettings);
  el.notebookBtn().addEventListener("click", openNotebook);
  el.notebookCloseBtn().addEventListener("click", closeNotebook);

  // Single delegated handler for every star button in the lyric list.
  // Re-renders bin the buttons every tick, so per-button addEventListener
  // would leak handlers; one listener on the container survives forever.
  el.lyrics().addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-star-line]",
    );
    if (!target) return;
    const lineIndex = Number(target.dataset.starLine);
    if (!Number.isFinite(lineIndex)) return;
    void toggleStarForLine(lineIndex);
  });

  bindSettingsForm();
  startLoops();
  // Notebook entries hydrate asynchronously — the lyric view will
  // re-render once the first star event fires, and renderNotebookPanel
  // pulls from the live state.notebook.entries map.
  void loadNotebookEntries();
});
