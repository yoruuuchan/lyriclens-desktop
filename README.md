# LyricLens Desktop

[中文](README.md) · [English](README.en.md)

脱离播放器的 AI 歌词学习窗。识别 Windows SMTC 当前播放的歌曲、拉 LRCLIB 同步歌词、用 LLM 现场生成学习卡片，**按播放器实际暴露的 timeline 健康度分级**：position 真在涨的播放器（Spotify 桌面版 / Media Player / 网易云 / QQ 音乐 / Apple Music 等）走逐行同步；只给元数据不给 timeline 的（foobar2000 默认配置等）自动降级成铺开式卡片。不依赖任何特定播放器，也不依赖播放器名单——一切看真机数据。

## 当前状态

**Alpha · MVP 闭环已接通 + 真机迭代中。** SMTC 拿播放信息、LRCLIB 拉同步歌词、同步滚动歌词面板、4 tab 完整设置（跟 BetterNCM 插件一对一对齐）、OpenAI 兼容 LLM 分析和当前歌词行下方 inline 学习卡片都已经接上。Session 2 真机验收完成网络根治（自建 CF Worker 反代 LRCLIB）+ LRCLIB 候选排序修复 + 本地分析结果缓存。

## 架构

LyricLens 是「一个产品，两个 host」，本仓库是 **host 2**（桌面端）：

```
┌─ 插件版（BetterNCM） ───────┐   ┌─ 桌面版（本仓库） ────────────┐
│ 注入到网易云客户端           │   │ 独立 Tauri 应用                │
│ 歌词：NCM 内存               │   │ 歌词：LRCLIB（CF Worker 反代） │
│ 存储：IndexedDB              │   │ 存储：SQLite（待做）           │
│ UI：客户端浮层               │   │ UI：独立窗口                   │
└──────────────────────────────┘   └────────────────────────────────┘
                ↕ JSON 导出 / 导入（不做实时同步）
```

两个 host 都是独立完整产品，**BetterNCM 任何时候停更，桌面版独立运转不受影响。**

插件版仓库 + 完整双 host 路线图：[`yoruuuchan/LyricLens`](https://github.com/yoruuuchan/LyricLens)

## 已经能跑的部分

- **SMTC 读取** — title / artist / album / duration / position / 播放状态 / `LastUpdatedTime` / `PlaybackRate` / `SourceAppUserModelId`，通过 `windows-rs` 的 `Media_Control` feature 拉取。每秒轮询，前端在两次轮询之间做位置外推，高亮平滑滚动
- **Timeline 健康度分级** — 每个 SMTC session 跑 6 档状态机分类：`timeline_healthy` / `timeline_candidate` → 逐行同步；`timeline_unstable` → 逐行 + 警告；`metadata_only` / `timeline_dead` → 自动铺开全部学习卡片。判定基于 position 实际变化（≥3 帧窗口，看涨幅是否符合播放速率），不绑死播放器名单
- **调试面板** — 设置 → 调试 tab 显示当前会话 + 所有 SMTC sibling 会话的原始字段（position / duration / lastUpdated / capturedAt / playbackRate）+ 彩色 health 徽章。出问题截一张图就能秒判病因
- **LRCLIB 客户端 + CF Worker 反代** — `/api/get` + `/api/search` fallback，时长 ±5s 容差，LRC 解析支持多时间戳行（探针 E 在 290 首歌 8 类别上实测命中率 97.9%，详见插件仓库 roadmap）。**所有请求走自建 Cloudflare Worker 反代 `https://lrclib.yoru-and-akari.dev/api`**（HK/SG edge 节点国内可达性远好于直连 lrclib.net，6h edge cache for 200，404/5xx 不缓存）。Rust 端 transient 失败重试 1 次 + 友好错误分类（timeout / connect / 5xx / 4xx 各自人话提示）
- **候选排序优先 synced** — LRCLIB `/api/search` 一首歌可能返回 10+ 候选，质量不一致。`Aimer / ninelie` 这类 artist 拼写命不中 `/api/get` 必走 search，候选里常混 plain-only（无时间戳，最后一行字面就是 `(End)`）。Rust 端排序两层：**先看有没有非空 syncedLyrics，再看 duration 距离**，避免误选 plain-only 候选
- **同步滚动歌词面板（plain-only 自动摊开）** — 当前行 primary blue 高亮、前后行渐隐、平滑居中滚动。检测到 LRC 无时间轴（所有行 `timeMs=0`）时自动进入"全部卡片摊开"模式，不再依赖 active 锚定卡在最后一行
- **LLM 分析管线** — 复用插件端 prompt frame / typed points schema，调用 OpenAI 兼容 Chat Completions，解析 JSON 后把学习卡片显示在当前歌词行下方
- **分析结果本地缓存** — localStorage FIFO（上限 50 首），key = `${trackKey}|${analysisSignature}`。同一首歌同设置切回来秒出，卡片右上角徽章切成 `cached`（primary tint，不开 DevTools 也能视觉确认）。主路径失败后 fallback 命中也写入 cache，下次重播不会再触发"主路径失败→fallback"二次劳动。schema 变更通过 `CACHE_VERSION` bump 自动废旧
- **yoru-and-akari Console 设计系统** — 神经形态卡片、akari（浅）/ yoru（深）双主题、Geist + Noto Sans SC 以 woff2 形式打包进 dist（不走 Google Fonts，没有 fallback 闪烁）
- **真窗口透明** — 40–100% 可调。桌面从歌词面板后透出，但 now-playing 条 / 设置卡片 / 底栏等含文字的表面保持不透明，字永远清晰
- **设置面板 4 tab（跟插件对齐）** —
  - **常规**：自动分析新歌曲 toggle · 主题 · 字体大小 · 窗口透明度 slider
  - **AI 服务**：OpenAI 兼容 endpoint / key / model + "测试连接"按钮（POST 1-token ping，显示 HTTP 状态 + 延迟或人话错误）；学习偏好（目标语言 · 知识点 checkbox · 自定义 Prompt 折叠区——textarea 里预填基于当前规则生成的默认 focus 块，跟插件行为一致）
  - **高级**：卡片生成模式 · 超时 · 最大歌词行数 · 最大 Tokens · Temperature · Thinking · Response Format · 超时后自动重试 toggle + 三个重试参数
  - **关于**：版本号 · GitHub 链接（通过 tauri-plugin-opener 在系统浏览器打开） · 反馈表单（POST 到 `lyriclens.yoru-and-akari.dev/feedback`，body 带 `app: "lyriclens-desktop"` 区分来源）

## MVP 还差什么

- ⏳ 真实 provider 验收：填 endpoint / key / model，确认请求、解析、inline 卡片显示都跑通
- ⏳ 收藏 / `NotebookEntry` SQLite 存储（脚手架在但空着）
- ⏳ 跨 host JSON 导入/导出（schema 已在主仓库 [`docs/schema/notebook-entry.md`](https://github.com/yoruuuchan/LyricLens/blob/main/docs/schema/notebook-entry.md) 落定）
- ⏳ 词库 CDN、JLPT / CEFR-J 等级标签
- ⏳ per-line 卡片分批请求（避开 4096 max_tokens 截断）

> Windows-only。macOS / Linux 已经在长期方向里明示砍掉，不在 roadmap 内。

## 开发

前置：Rust 1.80+、Node 18+、Windows 10/11。

```powershell
npm install
npm run tauri dev        # dev 服务 + webview 热重载
npm run tauri build      # 生成 release .msi，路径在 src-tauri/target/release/bundle/msi/
```

应用内调试：debug build 默认开启 webview devtools，**F12** 或 **Ctrl + Shift + I** 打开。Vite dev 服务固定端口 1420——上次崩溃残留进程占着这个端口时，跑 `Get-NetTCPConnection -LocalPort 1420 | Stop-Process` 释放即可。

## 目录结构

```
src/                  vanilla TS 前端
  main.ts             SMTC 轮询、设置面板、歌词渲染
  analysis.ts         LLM 分析管线 + cache 读写入口
  analysis-cache.ts   localStorage FIFO 缓存（CACHE_VERSION 控制失效）
  styles.css          设计系统组件 + 窗口透明度 + 各种控件
  tokens.css          设计系统 token（从 yoru-and-akari 复制过来）
  fonts/              Geist（variable）+ Geist Mono（variable）+ Noto Sans SC
src-tauri/
  src/lib.rs          包装下方模块的 Tauri commands
  src/smtc.rs         Windows SMTC 读取器
  src/lrclib.rs       LRCLIB 客户端 + LRC 解析器（重试 + 候选排序）
  tauri.conf.json     窗口 480×720、transparent: true、decorations: true
cloudflare-worker/    LRCLIB 反代 Worker 源 + 部署脚本
  worker.js           /api/get、/api/search 透传 + /healthz + edge cache
  wrangler.toml       route 声明
  deploy.sh           WSL 内一键 API multipart 上传
docs/roadmap/         README、progress 日志（HANDOFF-*.md 走 gitignore）
```

## License

待定——默认 source-available，不允许再分发，正式 license 决定之前先这样。
