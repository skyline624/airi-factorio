<#
.SYNOPSIS
  Lance le serveur Factorio (wrapper) puis l agent learning, dans le bon ordre.

.DESCRIPTION
  Sequence : stop des process existants -> (option) reset skills+map ->
  demarrage du wrapper (serveur headless) -> attente du port RCON ->
  demarrage de l agent. Serveur et agent tournent chacun dans leur fenetre.
  L agent attend un joueur : connecte ton client Factorio (multijoueur ->
  localhost) apres le lancement pour faire apparaitre le personnage.

.PARAMETER Reset
  Vide la skill library (skills.json + code/*.js) ET regenere une map fraiche
  avant de lancer. Sans ce flag, on reprend la map + les skills existantes.

.PARAMETER ServerOnly
  Demarre uniquement le wrapper (pas l agent).

.PARAMETER RconTimeoutSec
  Delai max d attente du port RCON avant d abandonner (defaut 120 s).

.EXAMPLE
  .\run-airi.ps1 -Reset      # depart propre : 0 skill + map neuve
  .\run-airi.ps1             # reprise : garde skills + map
#>
param(
  [switch]$Reset,
  [switch]$ServerOnly,
  [int]$RconTimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $repo

# --- Lit une valeur KEY=value depuis un fichier .env (enleve les quotes) ---
function Get-EnvVal($file, $key) {
  if (-not (Test-Path $file)) { return $null }
  $line = Select-String -Path $file -Pattern "^\s*$key\s*=" | Select-Object -First 1
  if (-not $line) { return $null }
  $val = ($line.Line -replace "^\s*$key\s*=\s*", '')
  $val = $val.Trim()
  $val = $val.Trim("'").Trim('"')
  return $val
}

$wenv        = Join-Path $repo 'packages\factorio-wrapper\.env.local'
$FactorioExe = Get-EnvVal $wenv 'FACTORIO_PATH'
$SavePath    = Get-EnvVal $wenv 'FACTORIO_SAVE_PATH'
$ConfigPath  = Get-EnvVal $wenv 'FACTORIO_CONFIG_PATH'
$RconPort    = [int](Get-EnvVal $wenv 'FACTORIO_RCON_PORT')
if (-not $RconPort) { $RconPort = 27015 }
$AgentLog    = Join-Path $env:TEMP 'airi-agent.log'
$SkillsDir   = Join-Path $repo 'packages\agent\skills'

Write-Host "=== airi-factorio launcher ===" -ForegroundColor Cyan
Write-Host "  factorio : $FactorioExe"
Write-Host "  save     : $SavePath"
Write-Host "  rcon     : localhost:$RconPort"
Write-Host "  agent log: $AgentLog"

# --- 1. Stop des process existants ---
Write-Host "`n[1/4] Arret du serveur/agent en cours..." -ForegroundColor Yellow
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -match 'factorio-agent|factorio-wrapper' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='factorio.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -match 'start-server' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep -Seconds 2

# --- 1b. Reset optionnel (skills + map) ---
if ($Reset) {
  Write-Host "[reset] Purge des skills + map fraiche..." -ForegroundColor Yellow
  Get-ChildItem "$SkillsDir\code" -Filter '*.js' -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue
  if (Test-Path "$SkillsDir\skills.json") { Set-Content "$SkillsDir\skills.json" '[]' -Encoding utf8 }
  if (Test-Path $SavePath) { Remove-Item $SavePath -Force }
  & $FactorioExe --create $SavePath --config $ConfigPath | Out-Null
  Write-Host "[reset] OK : 0 skill, map neuve." -ForegroundColor Green
}

# --- 2. Demarrage du wrapper (serveur) dans une nouvelle fenetre ---
Write-Host "`n[2/4] Demarrage du serveur (wrapper)..." -ForegroundColor Yellow
$wrapperCmd = "Set-Location '$repo'; Write-Host 'SERVEUR (wrapper)' -ForegroundColor Green; corepack pnpm --filter ./packages/factorio-wrapper run dev"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $wrapperCmd

# --- 3. Attente du port RCON ---
Write-Host "[3/4] Attente du port RCON $RconPort (max $RconTimeoutSec s)..." -ForegroundColor Yellow
$deadline = (Get-Date).AddSeconds($RconTimeoutSec)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect('127.0.0.1', $RconPort)
    if ($tcp.Connected) { $tcp.Close(); $ready = $true; break }
  } catch {
    Start-Sleep -Milliseconds 1500
  }
}
if (-not $ready) {
  Write-Host "RCON pas pret apres $RconTimeoutSec s - verifie la fenetre du serveur." -ForegroundColor Red
  exit 1
}
Write-Host "RCON est up." -ForegroundColor Green

if ($ServerOnly) {
  Write-Host "`n-ServerOnly : agent non lance. Connecte ton client Factorio si besoin." -ForegroundColor Cyan
  exit 0
}

# --- 4. Demarrage de l agent dans une nouvelle fenetre (+ log tee) ---
Write-Host "`n[4/4] Demarrage agent (log -> $AgentLog)..." -ForegroundColor Yellow
# Redirige via `cmd /c ... 2>&1` (et NON `2>&1` PowerShell) : sous PS 5.1, rediriger la
# stderr d une commande native l enveloppe en ErrorRecord (NativeCommandError) et casse le
# pipeline. cmd fusionne stderr+stdout au niveau natif, Tee-Object recoit du texte propre.
$agentCmd = "Set-Location '$repo'; Write-Host 'AGENT (learning)' -ForegroundColor Green; cmd /c 'corepack pnpm --filter ./packages/agent run start 2>&1' | Tee-Object -FilePath '$AgentLog'"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $agentCmd

Write-Host "`n=== Lance ! ===" -ForegroundColor Cyan
Write-Host "-> CONNECTE ton client Factorio : Multijoueur -> se connecter a localhost" -ForegroundColor White
Write-Host "   Agent en attente : il faut un joueur connecte pour demarrer." -ForegroundColor White
