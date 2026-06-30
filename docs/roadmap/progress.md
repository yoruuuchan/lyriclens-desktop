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

## 2026-06-30 [probe] JLPT 词表调研落地 — Bluskyo + Tanos CC BY

JLPT 词表 license 调研报告回来（GPT 产出，`C:\Users\15877\Downloads\lyriclens_jlpt_vocab_research.md`）。决策落定在插件版 roadmap，桌面版按 schema 实现。

关键决策（详见 [插件版 progress 同条](../../../LyricLens/docs/roadmap/progress.md) 和 [`jlpt-vocab.md` schema](../../../LyricLens/docs/schema/jlpt-vocab.md)）：
- 数据源 = `Bluskyo/JLPT_Vocabulary`（MIT 仓库 + Tanos CC BY 上游）。报告原推荐 yomitan-jlpt-vocab (CC BY-SA)，但 Yoru 想保留商业化选项，选 Bluskyo 避开 ShareAlike。
- 分发走 Cloudflare KV，跟 CEFR-J 同套基建
- 客户端走 Tauri Rust 侧 HashMap，**不进 SQLite**（SQLite 只给 NotebookEntry）
- MVP 不做日语分词，直接用 LLM `highlight.text` 做 surface lookup
- UI 文案严格"参考等级"，同词多 level 显示 "JLPT N3 / N4"
- feature flag `JLPT_DATA_SOURCE=bluskyo | yomitan | off` 留切换余地

下一步桌面版词库相关任务（按这个 schema 实现）：
- Tauri command `jlpt_lookup(surface, reading?) → JlptLookupResult`
- About 页面 attribution
- badge 渲染 + tooltip
- 跟 CEFR-J lookup 走同一套 manifest 拉取 / 校验 / 缓存

实际开干在 timeline health probe + NotebookEntry SQLite 落地之后。

## 2026-06-30 [plan] 长期方向决策日 + 桌面版 inline 修复一批

承接前一条 (LLM inline cards 接入) 的真机验收。Yoru + Claude 在 SMTC timeline 调研报告 (GPT 产出，`C:\Users\15877\Downloads\lyriclens_smtc_timeline_research.md`) 的基础上把整张产品方向图过了一遍，锁了一批长期决策。

调研报告核心收获：
- SMTC 不是 yes/no 接口而是分层能力 (metadata / playback control / timeline 三条独立通道)
- 网易云 / QQ 桌面版的 timeline 缺失不是设计无解，需要 runtime probe + 5 档 health 状态机
- 浏览器扩展 bridge 是比 WASAPI 性价比高 10 倍的同步 fallback
- WASAPI loopback 拿到的是 PCM 不含 position 语义，要反推就是另起一个 Shazam 项目，**确认砍掉**

锁了 8 条长期决策 (canonical 在插件版 roadmap)：
- 平台只 Windows，阶段 4 跨平台段落作废
- 学习闭环采笔记本式 (不做 SRS、不做词频)
- 收藏粒度 = 一句歌词的整张卡片，统一 `NotebookEntry` schema
- MVP 词库扩展 CEFR-J + JLPT 双语
- 跨 host 数据合并：两边保留 + 备注拼接
- 永久砍掉列表明示 (WASAPI / NCM 插件兼容 / 苹果生态 / Spotify 深度 / 实时同步 / SRS / 词频)
- 桌面版按 timeline health 分级，不按播放器名一刀切

`NotebookEntry` schema 落到插件版 `docs/schema/notebook-entry.md`，桌面版直接 import 用。

本会话同时给桌面版加了三处 inline 修复 (都在 dev session 实测通过，未 commit)：
- 顶部状态条永远显示分析状态 (loading / error / setup / ready)，不再绑死 active 行
- 超时 / 截断 fallback 接通 (codex 留了配置但没接通 analysis.ts)；扩大触发条件包含 JSON parse 失败
- `state.lastLyricsHtml` 缓存防 pollSmtc 每秒 re-render 导致的卡片闪烁
- 无 timeline 时 (网易云 / QQ) 自动 expandAll，把全部精选卡片铺开

JLPT 词表 license 调研 prompt 已交付 Yoru，预计本周拿到推荐方案。

下一步：
- 立刻可做：timeline health 5 档状态机 + debug 面板 (替换粗糙的 `duration === 0` 判断)
- per-line 分批请求 (max_tokens 4096 不够 80 行歌词的根治方案)
- README 改 health-based 文案，明确标记哪些播放器能完整同步
- 等 JLPT 调研回来再开词库基建

## 2026-06-30 [ship] LLM inline learning cards 接入

承接 Yoru 确认的 inline 预览方案，把 MVP 闭环最后一块接进桌面端。现在 LRCLIB 拿到歌词后，会用 OpenAI 兼容 Chat Completions 请求生成 typed learning points，并把学习卡片显示在当前高亮歌词行下方。

做了什么：
- 新增 `src/analysis.ts`，复制插件端 prompt frame / default focus / typed points normalize 的简化版，保留 `response_format` auto fallback
- `src/main.ts` 接入 trackKey 绑定的分析状态：`thinking` / `ready` / `setup` / `error`
- 当前行下方 inline 渲染学习卡片；翻译块用 inset surface，知识点用设计系统 token 做 pill badge
- 切歌、歌词请求、分析请求都按 trackKey 防旧请求覆盖新歌状态
- 保存 AI 设置后，如果之前缺配置或分析失败，会自动用当前歌词重试
- 新增 `docs/previews/llm-inline-card-preview.html` 和截图作为设计对照
- `npm run build` 通过，`npm run tauri build` 通过并生成 `.msi` / NSIS 安装包

下一步：
- 用真实 endpoint / key / model 真机验收一次 LLM 请求、JSON 解析和 inline 卡片显示
- 验收通过后再考虑收藏 / SQLite 或跨 host JSON 数据格式

## 2026-06-30 [ship] MVP UI/数据壳子完整，差 LLM 接入

承接 scaffold 那条，一天内把 MVP 的 UI/数据壳子做齐了。**唯一缺的是 LLM 调用** —— 拉到 LRC 但没让模型生成卡片。

做了什么：
- SMTC reader（windows-rs `Media_Control`，`.get()` + `spawn_blocking`）
- LRCLIB client（`/api/get` + `/api/search` fallback，LRC parser 3 单测全过）
- 同步滚动 UI（vanilla TS + position 外推，200ms 重渲染节奏）
- 接入 `yoru-and-akari Console Design System`（tokens.css 复制 + 本地化删 Google Fonts @import）
- 字体本地化（Geist + Geist Mono variable + Noto Sans SC chinese-simplified，woff2 + inline @font-face + font-display block）
- 真窗口透明（tauri `transparent: true` + `.app` 用 `rgb(.../-window-alpha)`，卡片实色）
- 设置 4 tab parity（常规 / AI 服务 / 高级 / 关于）+ 全套控件（toggle/slider/select/checkbox grid/details）
- 测试连接 button（POST 1-token ping）
- 反馈表单 POST 到 `lyriclens.yoru-and-akari.dev/feedback`，body tag `app: "lyriclens-desktop"`
- 知识点改为 checkbox grid（不是 click chip）
- 自定义 Prompt 折叠 details，`buildDefaultFocus` 移植到 main.ts，跟插件行为对齐

真机验证轮次（Yoru 截图反馈了 5+ 轮）：
1. SMTC 拉到「One Last Kiss / 宇多田ヒカル」但 LRCLIB 报 "error decoding response body" → `LyricResult` 没标 `rename_all = "camelCase"`，加上后修复
2. 「为啥不按设计系统」→ 全量接 yoru-and-akari console design system
3. 「字体好小」→ 字号锚定到插件 standard 档 (base 15px)
4. 「字体还在 fallback」→ tokens.css 删 Google Fonts @import；inline @font-face + variable font
5. 「感觉跟插件字体不一样」→ 中文加 Noto Sans SC，跟插件字体栈一致
6. 「透明度把 UI 压灰了」→ tauri transparent + `.app` rgba 背景，不再碰 body.opacity
7. 「插件设置页 vs exe 设置页就知道差别」→ 4 tab + 完整控件类型 parity
8. 「知识点要 checkbox 不是点击 chip」、「Prompt 应该预填默认 + 折叠」→ checkbox grid + details + buildDefaultFocus 联动

5 commits 在本地，没 push（仓库 `yoruuuchan/lyriclens-desktop` 还没建）。

下一步：
- 接 LLM 分析（Task #6，MVP 闭环最后一步）—— 这之前要先和 Yoru 对齐卡片渲染在 UI 哪里
- `gh repo create` + push 到 GitHub
- `npm run tauri build` 出 .msi 装包

详细交接看 [HANDOFF-2026-06-30-bootstrap.md](HANDOFF-2026-06-30-bootstrap.md)（gitignored）。

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
