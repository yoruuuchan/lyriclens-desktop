export type KnowledgePoint =
  | "vocabulary"
  | "grammar"
  | "culture"
  | "pronunciation"
  | "tone";

export type CardMode = "per-line" | "selected";
export type ThinkingMode = "off" | "auto" | "high" | "max";
export type ResponseFormatMode = "auto" | "json_object" | "off";

export type AnalysisSettings = {
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
};

export type AnalysisInputLine = {
  index: number;
  text: string;
  startMs: number | null;
  endMs: number | null;
};

export type AnalysisPoint = {
  type: "vocabulary" | "grammar" | "culture" | "pronunciation" | "tone" | "general";
  text: string;
};

export type AnalysisCard = {
  index: number;
  lineIndex: number;
  original: string;
  translation: string;
  points: AnalysisPoint[];
  note: string;
  startMs: number | null;
  endMs: number | null;
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  es: "Spanish",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
  th: "Thai",
  vi: "Vietnamese",
  ar: "Arabic",
  zh: "Chinese",
  other: "foreign-language",
};

const KNOWLEDGE_POINT_SNIPPETS: Record<KnowledgePoint, string> = {
  vocabulary:
    "Vocabulary: highlight important words, phrases, and collocations; explain meaning and usage.",
  grammar:
    "Grammar: explain sentence structures, verb conjugations, tense, and grammatical patterns.",
  culture:
    "Cultural context: explain idioms, cultural references, allusions, and background.",
  pronunciation:
    "Pronunciation: note phonetic features, stress, liaison, pitch accent, or common pitfalls.",
  tone: "Tone & feeling: describe emotional nuance, register, and rhetorical effect.",
};

const VALID_POINT_TYPES = [
  "vocabulary",
  "grammar",
  "culture",
  "pronunciation",
  "tone",
  "general",
] as const;

function normalizeEndpoint(endpoint: string): string {
  const raw = endpoint.trim();
  if (!raw) return "";
  const stripped = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(stripped)) return stripped;
  if (/\/v1$/i.test(stripped)) return `${stripped}/chat/completions`;
  return stripped;
}

function languageDisplayName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}

function buildFramePrefix(language: string, isSelected: boolean): string {
  const langName = languageDisplayName(language);
  if (isSelected) {
    return `You are a ${langName} learning assistant. The user provides song lyrics with line numbers in [index] text format.

Pick 6-8 most valuable lines to learn from. Return ONLY a JSON object — no markdown, no code fences, no explanations.

Shape: {"cards":[{"lineIndex":0,"original":"...","translation":"...","points":[{"type":"vocabulary","text":"..."}],"note":"..."}]}

Structural rules:
- lineIndex: the original line number.
- original: exact lyric line, don't rewrite.
- startMs/endMs should be copied from input when present.
- Each point MUST be an object with "type" and "text" fields. Valid types: vocabulary, grammar, culture, pronunciation, tone.
- If fewer than 6 lines have learning value, return fewer cards — never pad.`;
  }
  return `You are a ${langName} learning assistant. The user provides timed song lyrics. Generate one learning card for every input lyric line.

Return ONLY a JSON object — no markdown, no code fences, no explanations.

Required shape:
{"cards":[{"lineIndex":0,"startMs":1234,"endMs":5678,"original":"...","translation":"...","points":[{"type":"vocabulary","text":"..."}],"note":"..."}]}

Structural rules:
- cards.length must equal input lines.length.
- Each point MUST be an object with "type" and "text" fields. Valid types: vocabulary, grammar, culture, pronunciation, tone.
- Do not skip simple lines. If there is nothing worth teaching, points can be [] and note should briefly explain tone or meaning.
- lineIndex must exactly match the input line index.
- startMs/endMs should be copied from input when present.
- original must be the exact original lyric, do not rewrite.`;
}

export function buildDefaultFocus(
  targetLanguage: string,
  points: KnowledgePoint[],
  isSelected: boolean,
): string {
  const validPoints = points.filter((p) => KNOWLEDGE_POINT_SNIPPETS[p]);
  const focusLines = validPoints.map(
    (k) => `- type "${k}" — ${KNOWLEDGE_POINT_SNIPPETS[k]}`,
  );
  const allowedTypes =
    validPoints.length > 0
      ? validPoints.join(", ")
      : "vocabulary, grammar, culture, pronunciation, tone";
  const focusBlock =
    focusLines.length > 0
      ? `Focus areas (produce AT MOST one point per area, skip the area entirely if there is nothing valuable to say about it for that line):\n${focusLines.join(
          "\n",
        )}`
      : "";
  if (isSelected) {
    return `Content rules:
- translation: short ${targetLanguage} translation, one sentence.
- points: array of {"type", "text"} objects. Only use these types: ${allowedTypes}.
- text: ≤24 ${targetLanguage} characters. Avoid filler.
- note: cultural or usage note, ≤60 ${targetLanguage} characters. Can be empty string.
- If referenceTranslation or romanLyric is provided, use it only as reference.
${focusBlock}`;
  }
  return `Content rules:
- translation must be natural ${targetLanguage}.
- points: array of {"type", "text"} objects. Only use these types: ${allowedTypes}.
- text: ≤50 ${targetLanguage} characters per point. Avoid filler.
- note: ≤100 ${targetLanguage} characters. Use for general feeling/meaning that doesn't fit a specific type.
- If referenceTranslation or romanLyric is provided, use it only as reference.
${focusBlock}`;
}

function composeSystemPrompt(language: string, settings: AnalysisSettings): string {
  const isSelected = settings.cardGenerationMode === "selected";
  const frame = buildFramePrefix(language, isSelected);
  const focus =
    settings.customPrompt.trim() ||
    buildDefaultFocus(settings.targetLanguage, settings.knowledgePoints, isSelected);
  return `${frame}\n\n${focus}\n\nNo markdown. No code block. No text outside the JSON.`;
}

function buildChatRequestBody(
  settings: AnalysisSettings,
  language: string,
  formattedLyrics: string,
  responseFormatMode: ResponseFormatMode,
) {
  const body: Record<string, unknown> = {
    model: settings.modelName,
    messages: [
      {
        role: "system",
        content: composeSystemPrompt(language, settings),
      },
      { role: "user", content: formattedLyrics },
    ],
    max_tokens: settings.analyzeMaxTokens,
    temperature: settings.analyzeTemperature,
  };

  const isDeepSeekV4 = /deepseek.*v4/i.test(settings.modelName);
  if (isDeepSeekV4 && settings.thinkingMode === "off") {
    body.thinking = { type: "disabled" };
  } else if (
    isDeepSeekV4 &&
    (settings.thinkingMode === "high" || settings.thinkingMode === "max")
  ) {
    body.reasoning_effort = settings.thinkingMode;
  }

  if (responseFormatMode === "json_object" || responseFormatMode === "auto") {
    body.response_format = { type: "json_object" };
  }

  return body;
}

export function analysisSettingsSignature(settings: AnalysisSettings): string {
  return JSON.stringify({
    apiEndpoint: normalizeEndpoint(settings.apiEndpoint),
    modelName: settings.modelName.trim(),
    targetLanguage: settings.targetLanguage.trim(),
    knowledgePoints: settings.knowledgePoints,
    customPrompt: settings.customPrompt,
    cardGenerationMode: settings.cardGenerationMode,
    analyzeTimeoutSecs: settings.analyzeTimeoutSecs,
    maxAnalysisLines: settings.maxAnalysisLines,
    analyzeMaxTokens: settings.analyzeMaxTokens,
    analyzeTemperature: settings.analyzeTemperature,
    thinkingMode: settings.thinkingMode,
    responseFormatMode: settings.responseFormatMode,
  });
}

export function missingAnalysisConfig(settings: AnalysisSettings): string | null {
  if (!settings.apiEndpoint.trim()) return "请先在 AI 服务里填写 endpoint。";
  if (!settings.apiKey.trim()) return "请先在 AI 服务里填写 API Key。";
  if (!settings.modelName.trim()) return "请先在 AI 服务里填写模型名。";
  return null;
}

export function toAnalysisInputLines(
  lines: { timeMs: number; text: string }[],
  maxLines: number,
): AnalysisInputLine[] {
  return lines
    .map((line, index) => ({
      index,
      text: line.text || "",
      startMs: Number.isFinite(line.timeMs) ? line.timeMs : null,
      endMs:
        index + 1 < lines.length && Number.isFinite(lines[index + 1].timeMs)
          ? lines[index + 1].timeMs
          : null,
    }))
    .filter((line) => line.text.trim())
    .slice(0, maxLines);
}

export function detectLanguageFromLines(lines: AnalysisInputLine[]): string {
  const text = lines.map((line) => line.text).join("\n");
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  if (/[a-zA-Z]/.test(text)) return "en";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  return "other";
}

function formatLyricsForPrompt(lines: AnalysisInputLine[]): string {
  return lines
    .map((line) => {
      const parts = [`[${line.index}]`, line.text];
      if (line.startMs !== null) parts.push(`startMs=${line.startMs}`);
      if (line.endMs !== null) parts.push(`endMs=${line.endMs}`);
      return parts.join(" ");
    })
    .join("\n");
}

function parseCompletionJson(content: string): unknown {
  const text = content.trim();
  try {
    return JSON.parse(text);
  } catch (_) {}

  const fenceMatch = text.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (_) {}
  }

  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    try {
      return JSON.parse(text.slice(objStart, objEnd + 1));
    } catch (_) {}
  }

  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      const array = JSON.parse(text.slice(arrStart, arrEnd + 1));
      if (Array.isArray(array)) return { cards: array };
    } catch (_) {}
  }

  throw new Error("API 返回内容不是可解析的 JSON。");
}

function assistantContent(responseJson: unknown): string {
  const json = responseJson as {
    choices?: Array<{ message?: { content?: string }; text?: string }>;
  };
  return json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? "";
}

function normalizePoints(value: unknown): AnalysisPoint[] {
  if (!Array.isArray(value)) return [];
  const result: AnalysisPoint[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) result.push({ type: "general", text: text.slice(0, 200) });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawText = String(record.text ?? record.point ?? "").trim();
    if (!rawText) {
      const phrase = String(record.phrase ?? "").trim();
      const meaning = String(record.meaning ?? "").trim();
      if (phrase && meaning) {
        result.push({ type: "general", text: `${phrase}：${meaning}`.slice(0, 200) });
      } else if (meaning) {
        result.push({ type: "general", text: meaning.slice(0, 200) });
      }
      continue;
    }
    const rawType = String(record.type ?? "").toLowerCase();
    const type = VALID_POINT_TYPES.includes(rawType as AnalysisPoint["type"])
      ? (rawType as AnalysisPoint["type"])
      : "general";
    result.push({ type, text: rawText.slice(0, 200) });
  }
  return result;
}

function normalizeCardIndex(card: Record<string, unknown>): number | null {
  const value = card.lineIndex ?? card.index;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function normalizeTextForCompare(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function normalizeCards(parsed: unknown, lines: AnalysisInputLine[]): AnalysisCard[] {
  const parsedRecord = parsed as { cards?: unknown[] };
  const rawCards = Array.isArray(parsedRecord?.cards) ? parsedRecord.cards : [];
  const lineByIndex = new Map(lines.map((line, position) => [line.index, { line, position }]));
  const lineByNormalizedText = new Map<string, { line: AnalysisInputLine; position: number }>();

  for (let i = 0; i < lines.length; i += 1) {
    const key = normalizeTextForCompare(lines[i].text);
    if (key && !lineByNormalizedText.has(key)) {
      lineByNormalizedText.set(key, { line: lines[i], position: i });
    }
  }

  const result: AnalysisCard[] = [];
  for (const rawCard of rawCards) {
    if (!rawCard || typeof rawCard !== "object") continue;
    const card = rawCard as Record<string, unknown>;
    const cardIndex = normalizeCardIndex(card);
    if (cardIndex === null) continue;

    let match = lineByIndex.get(cardIndex);
    if (!match && cardIndex >= 0 && cardIndex < lines.length) {
      match = { line: lines[cardIndex], position: cardIndex };
    }
    if (!match) continue;

    const reportedText = card.original ?? card.line;
    if (reportedText) {
      const reportedKey = normalizeTextForCompare(reportedText);
      const currentKey = normalizeTextForCompare(match.line.text);
      if (reportedKey && currentKey && reportedKey !== currentKey) {
        const rescue = lineByNormalizedText.get(reportedKey);
        if (rescue) match = rescue;
      }
    }

    const line = match.line;
    const points = normalizePoints(card.points ?? card.highlights);
    result.push({
      index: line.index,
      lineIndex: line.index,
      original: line.text,
      translation: String(card.translation ?? ""),
      points,
      note: String(card.note ?? ""),
      startMs: line.startMs,
      endMs: line.endMs,
    });
  }
  return result;
}

function messageForHttpStatus(status: number): string {
  if (status === 401 || status === 403) return "密钥或权限问题";
  if (status === 404) return "endpoint 或 model 不存在";
  if (status === 429) return "额度或限流";
  if (status >= 500) return "服务端错误";
  return "请求失败";
}

async function postChatCompletion(
  url: string,
  settings: AnalysisSettings,
  language: string,
  formattedLyrics: string,
  rfMode: ResponseFormatMode,
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(buildChatRequestBody(settings, language, formattedLyrics, rfMode)),
    signal,
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} · ${messageForHttpStatus(response.status)}`);
    (error as Error & { status?: number; responseText?: string }).status = response.status;
    (error as Error & { status?: number; responseText?: string }).responseText = text;
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("API 响应不是合法 JSON。");
  }

  const content = assistantContent(json);
  if (!content) throw new Error("API 返回内容为空。");
  return parseCompletionJson(content);
}

export async function requestAnalysis(
  settings: AnalysisSettings,
  lines: AnalysisInputLine[],
  signal?: AbortSignal,
): Promise<AnalysisCard[]> {
  const missing = missingAnalysisConfig(settings);
  if (missing) throw new Error(missing);
  if (!lines.length) return [];

  const url = normalizeEndpoint(settings.apiEndpoint);
  const formattedLyrics = formatLyricsForPrompt(lines);
  const language = detectLanguageFromLines(lines);
  const timeoutMs = Math.max(15, settings.analyzeTimeoutSecs) * 1000;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  const relayAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", relayAbort, { once: true });
  }

  try {
    let parsed: unknown;
    try {
      parsed = await postChatCompletion(
        url,
        settings,
        language,
        formattedLyrics,
        settings.responseFormatMode,
        controller.signal,
      );
    } catch (err) {
      const e = err as Error & { status?: number; responseText?: string };
      const unsupportedResponseFormat =
        e.status === 400 &&
        settings.responseFormatMode === "auto" &&
        /response_format|response format/i.test(e.responseText ?? "");
      if (!unsupportedResponseFormat) throw err;
      parsed = await postChatCompletion(
        url,
        settings,
        language,
        formattedLyrics,
        "off",
        controller.signal,
      );
    }
    return normalizeCards(parsed, lines);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new Error("分析请求超时。");
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener?.("abort", relayAbort);
  }
}
