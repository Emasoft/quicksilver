# Installs Quicksilver as a personal Claude Code skill, then detects an exported key (or asks for one once).
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Quicksilver needs Node 18+ (https://nodejs.org)'; exit 1 }
$base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$dest = Join-Path $base 'skills\quicksilver'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'skills\quicksilver\*') $dest
Write-Host "Installed to $dest"
$qs = Join-Path $dest 'scripts\qs.mjs'
node $qs status *> $null
if ($LASTEXITCODE -ne 0) { node $qs setup }
node $qs status
