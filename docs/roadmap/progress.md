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

## 2026-07-01 [ship] 阶段 3 第 1+2 步 + 笔记本独立 overlay + 一堆 polish

桌面版第三个连续 session 收工，6 条 PR 全 merged，Yoru 真机一路验过。阶段 3 主菜推完一半（第 1+2 步），笔记本从 settings tab 提升为主页右上角独立 overlay，附带踩到 worktree+junction 把 node_modules 删空的坑（已写 memory）。

PR 列表（时间序）：

- **[#15](https://github.com/yoruuuchan/lyriclens-desktop/pull/15) feat(notebook): SQLite store + typed Rust commands** —— 阶段 3 第 1 步
  - `src-tauri/src/notebook.rs`：NotebookEntry / AnalysisCard / AnalysisPoint serde structs（camelCase 自动对齐前端），`open_db` / `ensure_schema` / `upsert` / `list` / `remove` + 5 unit tests
  - `lib.rs`：setup hook 在 `app_data_dir/notebook.sqlite` 开 DB，State 存 `tokio::Mutex<Connection>`，三条 invoke commands；`CmdError::Storage` 新 kind
  - `src/notebook.ts`：typed shim + `makeSongKey`（schema-canonical trim+lowercase）+ `newEntryId`
  - 选 rusqlite (bundled) 而非 tauri-plugin-sql：schema 文档要求 strict 校验（uuid v4 / `starredAt ≤ updatedAt` / source enum），Rust 端校验 JS 绕不过
  - SQL UNIQUE(song_key, line_index) + ON CONFLICT 保留 id / starred_at / source

- **[#18](https://github.com/yoruuuchan/lyriclens-desktop/pull/18) feat(notebook): star button + notebook tab + note sheet + cache clear** —— 阶段 3 第 2 步 UI 全套 + 备选 B
  - 卡片右上角 ★ button（ember toggle，事件代理在 lyrics container 上）
  - 笔记本 tab in settings overlay（**后被 PR #21 移出**）
  - 备注编辑 sheet（浮在 overlay 之上，ESC / cancel / backdrop 关闭）
  - 高级 tab 加"分析缓存清空"section
  - 关于 tab 加"数据来源 · 致谢"（lrclib.net + CC0 + CF Worker 镜像）
  - 教训：PR #17 是 stacked PR，merge 之后没进 main（GitHub 不会自动 rebase 到新 base），手动 rebase + 重开为 #18

- **[#19](https://github.com/yoruuuchan/lyriclens-desktop/pull/19) fix(notebook): render points + LLM note; add batch select + delete**
  - Bug：`renderNotebookEntry` 漏写 card.points + card.note；数据是好的，只是 UI 没画
  - 批量选择 + 删除：每条 checkbox，slide-in batch bar 显示"已选 N / M / 全选 / 取消全选 / 删除选中"
  - `Promise.allSettled` 跑并发删，一条失败不带垮其他
  - dev.ps1 UTF-8 fix：`chcp 65001` + `OutputEncoding` 防 zh-CN cp936 把 `▸` 乱码成 `鈻?`

- **[#20](https://github.com/yoruuuchan/lyriclens-desktop/pull/20) polish(notebook): rebuild entry layout with hero line + meta strip**
  - Yoru 真机说"没有视觉重心" → 重做成三段式（meta / body / actions），段间 hairline
  - head：`☐ Title · Artist ............. 00:30` 紧凑 meta strip
  - body hero：原文 text-lg + medium + JP 字体；翻译 italic ink-2 紧贴下方（**去掉灰底块**）
  - userNote 空时隐藏（不再"尚无备注"占位），按钮 label "加备注" / "编辑备注" 切换
  - userNote 用 primary tint 块 + 2px primary 强调条，跟 LLM material 视觉区分

- **[#21](https://github.com/yoruuuchan/lyriclens-desktop/pull/21) feat(notebook): promote from settings tab to first-class overlay**
  - Yoru 说"笔记本入口不要做在设置里" → 主页右上角加 book icon，独立 notebook overlay
  - 复用 `.settings-overlay` CSS class 只为 layout / 动画一致（DOM 上是同级 peer）
  - settings 里的笔记本 tab 整个删

- **[#22](https://github.com/yoruuuchan/lyriclens-desktop/pull/22) fix(layout): stop horizontal-scroll when window shrinks**
  - Yoru 真机拉窄窗口，长 album 名（"Aimer · 六等星の夜 / 悲しみはオーロラに / TWINKLE TWINKLE LITTLE STAR"）撑出水平滚动条
  - 根因：`.app` grid 没声明 `grid-template-columns`，隐式列默认 `max-content`，nowrap 长 child 把列锁过 viewport
  - 修：`grid-template-columns: minmax(0, 1fr)` + `html, body { overflow-x: hidden }`

附加事件：
- **另一个窗口 PR #16** 并行做了 README 更新（描述网络根治 + plain-only fallback 体验），零文件冲突
- **worktree + junction 踩坑**：`git worktree remove` 跟着 `mklink /J` 删空了 desktop 的 node_modules；`npm install` 重装 25 包修复；教训写到 [`feedback_worktree_junction.md`](../../../../.claude/projects/D--lyriclens-desktop/memory/feedback_worktree_junction.md)

真机重大发现：
- **rusqlite + bundled SQLite 工作良好**：MSVC 首次 build 几十秒，增量 build 不慢，运行时无额外依赖
- **GitHub stacked PR 不会自动 rebase** 到新 base：上游 PR merge 后，stacked PR 的 base 还是死链分支，merge 进去不会进 main
- **CSS Grid layout 经典坑**：grid container 没显式 grid-template-columns 时，隐式列是 max-content 不是 1fr，nowrap 长 child 会撑过 viewport
- **PowerShell zh-CN 默认 cp936**，box-drawing / 表情符号显示要 `chcp 65001` + `OutputEncoding = UTF8` 双管齐下

下一站：
- 阶段 3 第 3 步：**Anki CSV 导出**（半天）。schema 文档列格式已锁，要加 `tauri-plugin-dialog` + 新 Rust command 写文件
- 阶段 3 第 4 步：JSON import/export + 合并规则（半天-1 天）
- trackKey() ↔ makeSongKey() 收敛（小，会让 cache invalidate 一次）
- 词库基建（可并行）：Bluskyo JLPT KV 部署 + Rust client + badge UI

详细交接看 [HANDOFF-2026-07-01-session3.md](HANDOFF-2026-07-01-session3.md)。

## 2026-07-01 [ship] 阶段 3 第 0 步 + 国内连接根治 + ninelie 烂源修复

桌面版一夜 6 条 PR 全 merged。阶段 3 主菜的"第 0 步 cache"做完，国内连不上 lrclib.net 的老问题用 Cloudflare Worker 反代根治了，发现并修了 ninelie 那条暴露的 LRCLIB 候选排序 + plain-only 时间轴回落 bug。

PR 列表（时间序）：

- **[#8](https://github.com/yoruuuchan/lyriclens-desktop/pull/8) feat(analysis): cache LLM cards by (trackKey, signature)**
  - localStorage FIFO（上限 50），key = `${trackKey}|${analysisSignature}`，存 raw cards JSON
  - `startAnalysisForTrack` 入口先查 cache，命中跳过 LLM；primary / fallback 都写 cache（都用原 signature）
  - signature 抽到局部，防止保存设置中途 `state.analysis.settingsSignature` 被重置导致写入错位
  - 卡片右上角徽章 cache 命中时变 `cached`（primary tint），无需 DevTools 可视化验证

- **[#9](https://github.com/yoruuuchan/lyriclens-desktop/pull/9) fix(analysis): force Simplified Chinese when target is bare 中文**
  - 真机验收第一轮发现输出全是繁体（甜點 / 終點），原因是裸 "中文" 对模型歧义，日→中翻译偏繁体
  - `buildDefaultFocus` 中加 `clarifyTargetLanguage`，裸 `中文` / `chinese` → `简体中文 (Simplified Chinese)`
  - `DEFAULT_SETTINGS.targetLanguage` 改 `简体中文`；UI placeholder 同步
  - 用户显式输入 `繁体中文` 走原值，不强制

- **[#10](https://github.com/yoruuuchan/lyriclens-desktop/pull/10) fix(lrclib): retry transient errors + friendly Chinese messages**
  - reqwest transport 错误（timeout / connect）现在重试 1 次，500ms 退避
  - `LrcError` 扩 Timeout / Connect 变体；`CmdError` 跟着扩 kind=`timeout`/`connect`/`http_status`
  - frontend `describeLyricFetchError` 集中翻译错误：网络拦截、超时、5xx 各自有人话提示，不再泄露 reqwest 英文 debug

- **[#11](https://github.com/yoruuuchan/lyriclens-desktop/pull/11) feat(lrclib): route through Cloudflare Worker reverse-proxy**
  - 根治 GFW 抽 lrclib.net 的问题
  - 新 Worker `lrclib-proxy` 部署到 `lrclib.yoru-and-akari.dev`：CF edge 终止 TLS，server-to-server 从 CF backbone 走 lrclib.net；6h edge cache for 200，no-store for 404/5xx
  - `cloudflare-worker/` 加 worker.js + wrangler.toml + deploy.sh（直接 API 上传，跟插件 worker 同款）
  - 部署期间同步建好 AAAA DNS + Worker route + 冒烟测试（ninelie 通过代理可达）
  - `BASE_URL` 切换到代理域名

- **[#12](https://github.com/yoruuuchan/lyriclens-desktop/pull/12) chore(dev): add scripts/dev.ps1 + desktop shortcut**
  - 把 handoff 里的"杀 1420 端口 / kill 老进程 / npm run tauri dev"三件套打包
  - 桌面 `LyricLens Dev.lnk` 已建好，图标 src-tauri/icons/icon.ico，TargetPath powershell.exe + `-NoExit`

- **[#13](https://github.com/yoruuuchan/lyriclens-desktop/pull/13) fix(lrclib): prefer synced candidates + survive plain-only fallback**
  - ninelie 卡死在 `(End)` 卡片的真凶：Rust `search()` 按 duration 选了一个 id=7399611（dur=261 精确但 syncedLyrics 空字符串，plain 最后一行是字面 "(End)"），前端 plain-only 时所有 timeMs=0 → activeIdx 永远停最后行
  - Rust：`search()` 排序改成两层，有 synced 优先，同层按 duration 距离
  - Frontend：`renderLyrics` 加 `lyricsHaveTimeline = state.lines.some(timeMs > 0)`，没时间轴时 activeIdx=-1 + 进 expandAll 桶
  - Cache：`CACHE_VERSION` 1→2 让旧 (End) cards 不可达

真机重大发现：
- **网易云 Win32 桌面版 + Apple Music Windows = `timeline_healthy`**（前面 session5 已确认），ninelie 是 LRCLIB 端候选排序问题，不是 SMTC
- LRCLIB `/api/search` 对 "Aimer / EGOIST" 这种带 " / " 的 artist 返回大量候选，duration 排序时 plain-only 行容易压过 synced 行——这是一个一般性问题，不只 ninelie

下一站：
- 阶段 3 第 1 步：**NotebookEntry SQLite + tauri-plugin-sql**（半天到一天）。schema 已在 `D:\LyricLens\docs\schema\notebook-entry.md` 锁定。Cache（第 0 步）做完后开发体验已经不被反复 LLM 调用打断
- 第 2-4 步：star button / Anki 导出 / JSON import-export（每条半天）
- 词库基建（可并行）：Bluskyo JLPT KV 部署 + Rust client + badge UI

详细交接看 `HANDOFF-2026-06-30-session2.md`。

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
