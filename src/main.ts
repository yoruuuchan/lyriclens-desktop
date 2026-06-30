// Self-host Geist + Geist Mono + Zen Kaku Gothic New so the UI never
// falls back to system fonts. Vite bundles these so they work offline.
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/zen-kaku-gothic-new/400.css";
import "@fontsource/zen-kaku-gothic-new/500.css";

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

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
type KnowledgePoint = "vocabulary" | "grammar" | "culture" | "pronunciation" | "tone";
type CardMode = "per-line" | "selected";
type ThinkingMode = "off" | "auto" | "high" | "max";
type ResponseFormatMode = "auto" | "json_object" | "off";

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
  // CSS-only fade for now. True window transparency would need
  // transparent:true in tauri.conf.json + alpha on bg-base. MVP just
  // dims the whole UI so the setting feels live.
  document.body.style.opacity = String(clamp(pct, 40, 100) / 100);
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

const state = {
  np: null as NowPlaying | null,
  trackKey: "",
  lines: [] as LyricLine[],
  fetchingLyrics: false,
  lyricsMessage: "",
  settings: loadSettings(),
  dirty: false,
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

function renderLyrics() {
  const container = el.lyrics();
  if (state.lyricsMessage && state.lines.length === 0) {
    container.innerHTML = `<p class="placeholder">${escapeHtml(state.lyricsMessage)}</p>`;
    return;
  }
  if (state.lines.length === 0) {
    container.innerHTML = `<p class="placeholder">播放任意歌曲，SMTC 会自动识别。</p>`;
    return;
  }
  const pos = extrapolatedPositionMs(state.np);
  let activeIdx = -1;
  for (let i = 0; i < state.lines.length; i++) {
    if (state.lines[i].timeMs <= pos) activeIdx = i;
    else break;
  }
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
  if (active) active.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function fetchLyricsFor(np: NowPlaying) {
  if (state.fetchingLyrics) return;
  if (!np.title || !np.artist) {
    state.lines = [];
    state.lyricsMessage = "缺少歌曲标题或艺人，无法查询。";
    renderLyrics();
    return;
  }
  state.fetchingLyrics = true;
  state.lyricsMessage = "正在 LRCLIB 查询…";
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
      state.lyricsMessage = "纯音乐 · LRCLIB 未标注歌词。";
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
      state.lyricsMessage = "仅纯文本歌词，无时间轴。";
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
      if (state.settings.autoAnalyze) fetchLyricsFor(np);
    }
  } catch (err) {
    const e = err as CmdError;
    if (e?.kind === "no_session") {
      state.np = null;
      state.trackKey = "";
      state.lines = [];
      state.lyricsMessage = "没有活跃的 SMTC 会话。播放一首歌就行。";
    } else {
      state.np = null;
      state.lyricsMessage = `SMTC 出错 · ${(e as { message?: string })?.message ?? String(err)}`;
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
  document.querySelectorAll<HTMLLabelElement>("#cfg-points .chip").forEach((chip) => {
    const p = chip.dataset.point as KnowledgePoint | undefined;
    const on = !!p && points.includes(p);
    chip.classList.toggle("is-on", on);
    const input = chip.querySelector<HTMLInputElement>("input");
    if (input) input.checked = on;
  });
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
  el.fPrompt().value = s.customPrompt;
  setChipsActive(s.knowledgePoints);
  el.testStatus().textContent = "未测试";
  el.testStatus().className = "test-status pending";

  // 高级
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

  // 关于
  el.aboutVersion().textContent = `v${APP_VERSION}`;
  el.updSub().textContent = `v${APP_VERSION} · 未启用更新检查`;
}

function readForm(): Settings {
  const points: KnowledgePoint[] = [];
  document.querySelectorAll<HTMLLabelElement>("#cfg-points .chip").forEach((chip) => {
    const input = chip.querySelector<HTMLInputElement>("input");
    const point = chip.dataset.point as KnowledgePoint | undefined;
    if (input?.checked && point && VALID_POINTS.includes(point)) {
      points.push(point);
    }
  });

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

  return {
    autoAnalyze: autoOn,
    theme,
    fontSize,
    panelOpacity: clamp(Number(el.sldOpacity().value) || 100, 40, 100),
    apiEndpoint: el.fEndpoint().value.trim(),
    apiKey: el.fKey().value.trim(),
    modelName: el.fModel().value.trim(),
    targetLanguage:
      el.fTarget().value.trim() || DEFAULT_SETTINGS.targetLanguage,
    knowledgePoints: points,
    customPrompt: el.fPrompt().value,
    cardGenerationMode:
      (el.fCardMode().value as CardMode) === "selected" ? "selected" : "per-line",
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

  // Chips
  document.querySelectorAll<HTMLLabelElement>("#cfg-points .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const input = chip.querySelector<HTMLInputElement>("input");
      setTimeout(() => {
        if (input) chip.classList.toggle("is-on", input.checked);
        setDirty(true);
      }, 0);
    });
  });

  // Generic input listeners → mark dirty
  const dirtyInputs = [
    "cfg-endpoint", "cfg-key", "cfg-model", "cfg-target", "cfg-prompt",
    "cfg-card-mode", "cfg-timeout", "cfg-max-lines", "cfg-max-tokens",
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
    state.settings = next;
    saveSettings(next);
    applyTheme(next.theme);
    applyFontSize(next.fontSize);
    applyOpacity(next.panelOpacity);
    setDirty(false);
    showSavedToast();
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
