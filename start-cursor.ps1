# Relaunch Cursor with the Chrome DevTools Protocol enabled (required for remote control). Windows version of start-cursor.sh.
# WARNING: this quits the running Cursor first; unsaved editors will prompt.
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File .\start-cursor.ps1
param([switch]$Worker)
$ErrorActionPreference = 'Stop'

$Port = if ($env:CDP_PORT) { $env:CDP_PORT } else { 9222 }
$DataDir = Join-Path $HOME '.cursor-remote-lite'
$Log = Join-Path $DataDir 'start-cursor.log'

function Test-Cdp {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1 | Out-Null; $true } catch { $false }
}

function Find-Cursor {
  $running = Get-Process -Name Cursor -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  if ($running) { return $running.Path }
  foreach ($p in @("$env:LOCALAPPDATA\Programs\cursor\Cursor.exe", "$env:ProgramFiles\Cursor\Cursor.exe")) {
    if (Test-Path $p) { return $p }
  }
  $null
}

if (-not $Worker) {
  if (Test-Cdp) {
    Write-Host "Port $Port already has a CDP endpoint. If that is not your main Cursor, quit it first (or set `$env:CDP_PORT to another port)."
    exit 1
  }
  $exe = Find-Cursor
  if (-not $exe) { Write-Host 'Cursor.exe not found. Run it yourself: <Cursor install dir>\Cursor.exe --remote-debugging-port=9222'; exit 1 }
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  # Detached so it survives when launched from Cursor's own terminal, which dies with Cursor.
  Set-Content -Path $Log -Value ''
  Start-Process powershell -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Worker')
  Write-Host "Cursor will quit and reopen with the debugging port (see $Log)"
  exit 0
}

function Say($msg) { Add-Content -Path $Log -Value "$(Get-Date) $msg" }

$exe = Find-Cursor
$procs = Get-Process -Name Cursor -ErrorAction SilentlyContinue
if ($procs) {
  Say 'asking Cursor to quit'
  $procs | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  for ($i = 0; $i -lt 30 -and (Get-Process -Name Cursor -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Name Cursor -ErrorAction SilentlyContinue) {
    Say "quit was blocked (probably a confirm dialog or tray icon); force-closing"
    Stop-Process -Name Cursor -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 60 -and (Get-Process -Name Cursor -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
  }
  if (Get-Process -Name Cursor -ErrorAction SilentlyContinue) { Say "Cursor did not quit; aborted"; exit 1 }
  Start-Sleep -Seconds 1
}

Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Cdp) { Say "Cursor up with CDP on $Port"; exit 0 }
  Start-Sleep -Seconds 1
}
Say "Cursor started but CDP port $Port is not responding"
