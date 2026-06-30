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
