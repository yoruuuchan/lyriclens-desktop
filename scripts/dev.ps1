# Launch LyricLens Desktop in dev mode.
#
# Wraps the dev-time recovery dance that's described in the bootstrap
# handoff: kill anything still camping vite's port (1420), kill any
# stale app instance, then start fresh. The desktop shortcut at
# `LyricLens Dev.lnk` points at this script.
#
# If you ever need to invoke it from a terminal directly:
#   pwsh -NoExit -ExecutionPolicy Bypass -File scripts\dev.ps1

$ErrorActionPreference = "Stop"

# Console codepage defaults to cp936 on zh-CN Windows, which mangles the
# Unicode glyphs below (▸, dashes) into "鈻?"-style mojibake. Force the
# session to UTF-8 so the step headers render. `chcp 65001` is the
# console-host side; OutputEncoding is the .NET-side counterpart that
# PowerShell uses when piping to native exes (npm, cargo).
$null = & chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectRoot = "D:\lyriclens-desktop"

function Write-Step($message) {
  Write-Host "▸ $message" -ForegroundColor Cyan
}

function Write-Ok($message) {
  Write-Host "  $message" -ForegroundColor DarkGray
}

function Write-Warn($message) {
  Write-Host "! $message" -ForegroundColor Yellow
}

# ─── 0. Sanity checks ───────────────────────────────────────────
if (-not (Test-Path $ProjectRoot)) {
  Write-Host "Project root not found: $ProjectRoot" -ForegroundColor Red
  Write-Host "Edit scripts\dev.ps1 if you moved the repo." -ForegroundColor Red
  exit 1
}

# ─── 1. Free port 1420 ──────────────────────────────────────────
Write-Step "Releasing port 1420 (vite)"
$portPids = Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue |
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
