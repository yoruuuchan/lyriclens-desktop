# LyricLens Desktop

[中文](README.md) · [English](README.en.md)

脱离播放器的 AI 歌词学习窗。Spotify / QQ 音乐 / foobar2000 / Edge 浏览器，凡是把播放信息发给 Windows SMTC 的，它都能识别歌曲、拉 LRCLIB 同步歌词、用 LLM 现场生成学习卡片——不依赖任何特定播放器。

## 当前状态

**Alpha · MVP 壳子完整，LLM 接入待办。** SMTC 拿播放信息、LRCLIB 拉同步歌词、同步滚动歌词面板、4 tab 完整设置（跟 BetterNCM 插件一对一对齐）都好了。**唯一缺的是 LLM 卡片生成**——设置项都持久化了、prompt 拼好了，但还没真发分析请求。

## 架构

LyricLens 是「一个产品，两个 host」，本仓库是 **host 2**（桌面端）：

```
┌─ 插件版（BetterNCM） ───────┐   ┌─ 桌面版（本仓库） ────────────┐
│ 注入到网易云客户端           │   │ 独立 Tauri 应用                │
│ 歌词：NCM 内存               │   │ 歌词：LRCLIB                   │
│ 存储：IndexedDB              │   │ 存储：SQLite（待做）           │
│ UI：客户端浮层               │   │ UI：独立窗口                   │
└──────────────────────────────┘   └────────────────────────────────┘
                ↕ JSON 导出 / 导入（不做实时同步）
```

两个 host 都是独立完整产品，**BetterNCM 任何时候停更，桌面版独立运转不受影响。**

插件版仓库 + 完整双 host 路线图：[`yoruuuchan/LyricLens`](https://github.com/yoruuuchan/LyricLens)

## 已经能跑的部分

- **SMTC 读取** — title / artist / album / duration / position / 播放状态，通过 `windows-rs` 的 `Media_Control` feature 拉取。每秒轮询，前端在两次轮询之间做位置外推，高亮平滑滚动
- **LRCLIB 客户端** — `/api/get` + `/api/search` fallback，时长 ±5s 容差，LRC 解析支持多时间戳行。（探针 E 在 290 首歌 8 类别上实测命中率 97.9%，详见插件仓库 roadmap）
- **同步滚动歌词面板** — 当前行 primary blue 高亮、前后行渐隐、平滑居中滚动
- **yoru-and-akari Console 设计系统** — 神经形态卡片、akari（浅）/ yoru（深）双主题、Geist + Noto Sans SC 以 woff2 形式打包进 dist（不走 Google Fonts，没有 fallback 闪烁）
- **真窗口透明** — 40–100% 可调。桌面从歌词面板后透出，但 now-playing 条 / 设置卡片 / 底栏等含文字的表面保持不透明，字永远清晰
- **设置面板 4 tab（跟插件对齐）** —
  - **常规**：自动分析新歌曲 toggle · 主题 · 字体大小 · 窗口透明度 slider
  - **AI 服务**：OpenAI 兼容 endpoint / key / model + "测试连接"按钮（POST 1-token ping，显示 HTTP 状态 + 延迟或人话错误）；学习偏好（目标语言 · 知识点 checkbox · 自定义 Prompt 折叠区——textarea 里预填基于当前规则生成的默认 focus 块，跟插件行为一致）
  - **高级**：卡片生成模式 · 超时 · 最大歌词行数 · 最大 Tokens · Temperature · Thinking · Response Format · 超时后自动重试 toggle + 三个重试参数
  - **关于**：版本号 · GitHub 链接（通过 tauri-plugin-opener 在系统浏览器打开） · 反馈表单（POST 到 `lyriclens.yoru-and-akari.dev/feedback`，body 带 `app: "lyriclens-desktop"` 区分来源）

## MVP 还差什么

- ⏳ **LLM 分析管线** — MVP 最后一块。Prompt 拼装已就绪，需要接 OpenAI 兼容请求 + JSON 解析 + 卡片渲染。卡片在 UI 中放哪儿（行内展开 / 侧栏 / 浮层 / 底部 dock）还在讨论
- ⏳ 收藏 / SQLite 存储（脚手架在但空着）
- ⏳ 跨 host JSON 导入/导出
- ⏳ 词库 CDN、JLPT 等级标签、词频统计
- ⏳ macOS（MRMediaRemote）/ Linux（MPRIS）支持——目前 Windows 优先

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
  styles.css          设计系统组件 + 窗口透明度 + 各种控件
  tokens.css          设计系统 token（从 yoru-and-akari 复制过来）
  fonts/              Geist（variable）+ Geist Mono（variable）+ Noto Sans SC
src-tauri/
  src/lib.rs          包装下方模块的 Tauri commands
  src/smtc.rs         Windows SMTC 读取器
  src/lrclib.rs       LRCLIB 客户端 + LRC 解析器
  tauri.conf.json     窗口 480×720、transparent: true、decorations: true
docs/roadmap/         README、progress 日志（HANDOFF-*.md 走 gitignore）
```

## License

待定——默认 source-available，不允许再分发，正式 license 决定之前先这样。
