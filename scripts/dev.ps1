# Launch LyricLens Desktop in dev mode.
#
# Wraps the dev-time recovery dance that's described in the bootstrap
# handoff: kill anything still camping vite's port (5173), kill any
# stale app instance, then start fresh. The desktop shortcut at
# `LyricLens Dev.lnk` points at this script.
#
# If you ever need to invoke it from a terminal directly:
#   pwsh -NoExit -ExecutionPolicy Bypass -File scripts\dev.ps1

$ErrorActionPreference = "Stop"

# Console codepage defaults to cp936 on zh-CN Windows. `chcp 65001` +
# OutputEncoding switches this session to UTF-8, which is enough for
# console *output* (npm/cargo/etc.). But it does NOT retroactively
# reinterpret the bytes PowerShell 5.1 already read from this script
# file — pre-declared Unicode glyphs like the ▸ we used to have here
# get parsed as legacy bytes on load and print as mojibake ("鈻?").
# We just use ASCII for the step markers below to avoid depending on
# PS version or file BOM at all.
$null = & chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectRoot = "D:\lyriclens-desktop"
$VitePort = 5173

function Write-Step($message) {
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Write-Ok($message) {
  Write-Host "    $message" -ForegroundColor DarkGray
}

function Write-Warn($message) {
  Write-Host "!!! $message" -ForegroundColor Yellow
}

# ─── 0. Sanity checks ───────────────────────────────────────────
if (-not (Test-Path $ProjectRoot)) {
  Write-Host "Project root not found: $ProjectRoot" -ForegroundColor Red
  Write-Host "Edit scripts\dev.ps1 if you moved the repo." -ForegroundColor Red
  exit 1
}

# ─── 1. Free the vite port ──────────────────────────────────────
Write-Step "Releasing port $VitePort (vite)"
$portPids = Get-NetTCPConnection -LocalPort $VitePort -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
if ($portPids) {
  foreach ($processId in $portPids) {
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Write-Ok "killed pid $processId"
    } catch {
      Write-Warn "could not kill pid $processId : $($_.Exception.Message)"
    }
  }
} else {
  Write-Ok "port already free"
}

# ─── 2. Stop stale app windows ──────────────────────────────────
Write-Step "Closing stale lyriclens-desktop instances"
$stale = Get-Process -Name lyriclens-desktop -ErrorAction SilentlyContinue
if ($stale) {
  $stale | ForEach-Object {
    try {
      Stop-Process -Id $_.Id -Force -ErrorAction Stop
      Write-Ok "killed pid $($_.Id)"
    } catch {
      Write-Warn "could not kill pid $($_.Id)"
    }
  }
} else {
  Write-Ok "nothing to clean"
}

# ─── 3. Kick off Tauri dev ──────────────────────────────────────
Set-Location -Path $ProjectRoot
Write-Step "npm run tauri dev"
Write-Host ""

# Hand control over to npm. When the user kills it (Ctrl+C) the
# window stays open because the .lnk passes -NoExit — that way the
# last screen of HMR output / error stack is still readable.
npm run tauri dev
