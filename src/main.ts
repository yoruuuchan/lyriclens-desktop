// Geist + Geist Mono + Zen Kaku Gothic New are imported at the TOP of
// styles.css so they load synchronously with the rest of the
// stylesheet, before this JS module evaluates. Don't move them back
// here — it would re-introduce a one-frame Segoe UI fallback.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
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

const APP_VERSION = "0.1.0";
const FEEDBACK_URL = "https://lyriclens.yoru-and-akari.dev/feedback";

// ─── types ───────────────────────────────────────────────────

type NowPlaying = {
  title: string; artist: string; album: string;
  durationMs: number; positionMs: number; capturedAtMs: number;
  status: string;
};
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
  targetLanguage: "中文",
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

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
  settingsBtn: () => $<HTMLButtonElement>("#btn-settings"),
  themeBtn: () => $<HTMLButtonElement>("#btn-theme"),
  overlay: () => $("#settings-overlay"),
  closeBtn: () => $<HTMLButtonElement>("#btn-settings-close"),
  cancelBtn: () => $<HTMLButtonElement>("#btn-settings-cancel"),
  saveBtn: () => $<HTMLButtonElement>("#btn-settings-save"),
  footerStatus: () => $("#footer-status"),
  testStatus: () => $("#test-status"),
  testBtn: () => $<HTMLButtonElement>("#btn-test-conn"),
  saveToast: () => $("#save-toast"),
  saveToastTime: () => $("#save-toast-time"),
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
};

// ─── lyric flow ──────────────────────────────────────────────

function trackKey(np: NowPlaying | null): string {
  if (!np || !np.title) return "";
  return `${np.title.toLowerCase()}|${np.artist.toLowerCase()}|${Math.round(
    np.durationMs / 1000,
  )}`;
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

function resetAnalysis(trackKeyValue = "") {
  state.analysis.controller?.abort();
  state.analysis.trackKey = trackKeyValue;
  state.analysis.settingsSignature = "";
  state.analysis.status = "idle";
  state.analysis.cards = new Map();
  state.analysis.message = "";
  state.analysis.controller = null;
}

function renderAnalysisLoadingCard(): string {
  return `<article class="analysis-card loading" aria-label="学习卡片生成中">
    <div class="analysis-head">
      <div class="analysis-kicker">
        <span class="analysis-dot" aria-hidden="true"></span>
        <span class="analysis-title">analysis</span>
      </div>
      <span class="analysis-status">thinking</span>
    </div>
    <div class="translation-block" aria-hidden="true">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>
  </article>`;
}

function renderAnalysisMessageCard(kind: "setup" | "error", message: string): string {
  return `<article class="analysis-card message ${kind}" aria-label="学习卡片状态">
    <div class="analysis-head">
      <div class="analysis-kicker">
        <span class="analysis-dot" aria-hidden="true"></span>
        <span class="analysis-title">analysis</span>
      </div>
      <span class="analysis-status">${kind}</span>
    </div>
    <div class="translation-block">
      <p class="translation-text">${escapeHtml(message)}</p>
    </div>
  </article>`;
}

function renderAnalysisCard(card: AnalysisCard): string {
  const start = card.startMs;
  const time = Number.isFinite(start) && start !== null ? ` · ${formatTime(start)}` : "";
  const translation = card.translation.trim()
    ? `<div class="translation-block">
        <span class="translation-label">translation</span>
        <p class="translation-text">${escapeHtml(card.translation)}</p>
      </div>`
    : "";
  const points = card.points
    .map((point) => {
      const label = POINT_TYPE_LABELS[point.type] || POINT_TYPE_LABELS.general;
      return `<div class="point-row">
        <span class="point-badge ${escapeHtml(point.type)}">${escapeHtml(label)}</span>
        <p class="point-text">${escapeHtml(point.text)}</p>
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
      <span class="analysis-status">ready</span>
    </div>
    ${translation}
    ${points ? `<div class="point-list">${points}</div>` : ""}
    ${note}
  </article>`;
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
      return `<div class="analysis-status-line ready" role="status">
        <span class="analysis-dot" aria-hidden="true"></span>
        <span>播放器未提供 timeline · 已铺开全部 ${total} 张精选卡片</span>
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
  const inputLines = toAnalysisInputLines(lines, state.settings.maxAnalysisLines);
  resetAnalysis(trackKeyValue);
  state.analysis.settingsSignature = analysisSettingsSignature(state.settings);

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

  const controller = new AbortController();
  state.analysis.status = "loading";
  state.analysis.message = "";
  state.analysis.controller = controller;
  renderLyrics();

  const stillCurrent = () =>
    !controller.signal.aborted && state.trackKey === trackKeyValue;

  try {
    const cards = await requestAnalysis(state.settings, inputLines, controller.signal);
    if (!stillCurrent()) return;
    state.analysis.status = "ready";
    state.analysis.cards = new Map(cards.map((card) => [card.lineIndex, card]));
    state.analysis.message = "";
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
      if (!stillCurrent()) return;
      state.analysis.status = "ready";
      state.analysis.cards = new Map(cards.map((card) => [card.lineIndex, card]));
      state.analysis.message = "";
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

function renderLyrics() {
  const container = el.lyrics();
  const pos = extrapolatedPositionMs(state.np);
  let activeIdx = -1;
  for (let i = 0; i < state.lines.length; i++) {
    if (state.lines[i].timeMs <= pos) activeIdx = i;
    else break;
  }
  // If the player doesn't expose a timeline (NetEase / QQ desktop client
  // are the canonical culprits), there is no active line to anchor cards
  // to. Switch to "expand all" so the user can still read every card the
  // model produced. We key on durationMs because positionMs=0 alone is
  // ambiguous (could just be the intro).
  const hasTimeline = (state.np?.durationMs ?? 0) > 0;
  const expandAll =
    !hasTimeline &&
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
  const active = container.querySelector<HTMLElement>(".line.active");
  if (active) active.scrollIntoView({ block: "center", behavior: "smooth" });
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
    const e = err as CmdError;
    if (e?.kind === "not_found") {
      state.lyricsMessage = "LRCLIB 没找到这首歌。";
    } else {
      state.lyricsMessage = `查询出错 · ${(e as { message?: string })?.message ?? String(err)}`;
    }
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

async function pollSmtc() {
  try {
    const np = await invoke<NowPlaying>("smtc_now_playing");
    state.np = np;
    const key = trackKey(np);
    if (key && key !== state.trackKey) {
      state.trackKey = key;
      if (state.settings.autoAnalyze) fetchLyricsFor(np);
    }
  } catch (err) {
    const e = err as CmdError;
    if (e?.kind === "no_session") {
      state.np = null;
      state.trackKey = "";
      state.lines = [];
      state.lyricsMessage = "没有活跃的 SMTC 会话。播放一首歌就行。";
      resetAnalysis();
    } else {
      state.np = null;
      state.lyricsMessage = `SMTC 出错 · ${(e as { message?: string })?.message ?? String(err)}`;
      resetAnalysis();
    }
  }
  renderNowPlaying();
  renderLyrics();
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
}

function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.tab === name),
  );
  document.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) =>
    p.classList.toggle("is-active", p.dataset.tab === name),
  );
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
  const toast = el.saveToast();
  const now = new Date();
  el.saveToastTime().textContent = `${now.getHours().toString().padStart(2, "0")}:${now
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
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
}

// ─── boot ────────────────────────────────────────────────────

function startLoops() {
  pollSmtc();
  setInterval(pollSmtc, 1_000);

  // High-frequency render so the extrapolated position + active line
  // stay smooth. Cheap because we only re-render when the active index
  // actually changes.
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
  el.themeBtn().addEventListener("click", () => {
    const next: Theme = state.settings.theme === "yoru" ? "akari" : "yoru";
    state.settings.theme = next;
    saveSettings(state.settings);
    applyTheme(next);
  });
  el.settingsBtn().addEventListener("click", openSettings);

  bindSettingsForm();
  startLoops();
});
