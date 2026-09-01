<#
install-windows-service.ps1
Installs the factory daemon as a Windows service.

UseOptions
  -RepoPath  "C:\path\to\my-app"  (required, where the daemon was installed)
  -ServiceName "FactoryDaemon"    (optional, default: FactoryDaemon)

Requires: PowerShell 5+ and one of:
  - NSSM (https://nssm.cc) on PATH — recommended for log rotation, env-file support
  - sc.exe (built-in) — limited; uses cmd-style env var pass-through

Examples
  PS> .\install-windows-service.ps1 -RepoPath "C:\repos\my-app"
  PS> .\install-windows-service.ps1 -RepoPath "C:\repos\my-app" -ServiceName "MyFactory"
#>

param(
  [Parameter(Mandatory = $true)] [string]$RepoPath,
  [string]$ServiceName = "FactoryDaemon"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $RepoPath)) {
  Write-Error "RepoPath not found: $RepoPath"
  exit 1
}

$daemonDir = Join-Path $RepoPath ".factory-daemon"
$startCmd   = Join-Path $daemonDir "start.cmd"

if (-not (Test-Path $startCmd)) {
  Write-Error "start.cmd not found at $startCmd. Run install-factory.mjs first."
  exit 1
}

$exePath = (Get-Command "node.exe" -ErrorAction SilentlyContinue)?.Source
if (-not $exePath) {
  Write-Error "node.exe not in PATH. Install Node.js 20+ from https://nodejs.org/."
  exit 1
}

Write-Host "Installing service '$ServiceName' ..."
Write-Host "  RepoPath:   $RepoPath"
Write-Host "  DaemonDir: $daemonDir"
Write-Host "  StartCmd:   $startCmd"
Write-Host "  Node exe:   $exePath"

if (Get-Command "nssm.exe" -ErrorAction SilentlyContinue) {
  Write-Host "`nUsing NSSM (recommended)..."
  nssm.exe install $ServiceName $exePath $startCmd
  nssm.exe set $ServiceName AppDirectory $RepoPath
  nssm.exe set $ServiceName AppStdout "$daemonDir\service-stdout.log"
  nssm.exe set $ServiceName AppStderr "$daemonDir\service-stderr.log"
  nssm.exe set $ServiceName AppRotateFiles 1
  nssm.exe set $ServiceName AppRotateBytes 1048576
  nssm.exe set $ServiceName DisplayName "Software Factory Daemon"
  nssm.exe set $ServiceName Description "Polls GitHub issues and runs the multi-agent software factory locally."
  nssm.exe set $ServiceName Start SERVICE_AUTO_START
  Write-Host "`n✓ NSSM service '$ServiceName' installed."
  Write-Host "Start:   net start $ServiceName"
  Write-Host "Stop:    net stop $ServiceName"
  Write-Host "Remove:  nssm.exe remove $ServiceName confirm"
  exit 0
}

Write-Host "`nNSSM not found; falling back to sc.exe (built-in)..."
$binPath = "`"$exePath`" `"$startCmd`""

sc.exe create $ServiceName binPath= $binPath start= auto displayname= "Software Factory Daemon"
sc.exe description $ServiceName "Polls GitHub issues and runs the multi-agent software factory locally."

if ($LASTEXITCODE -ne 0) {
  Write-Error "sc.exe create failed. Try running PowerShell as Administrator."
  exit 1
}

Write-Host "`n✓ sc.exe service '$ServiceName' installed."
Write-Host "Start:   sc.exe start $ServiceName"
Write-Host "Stop:    sc.exe stop $ServiceName"
Write-Host "Remove:  sc.exe delete $ServiceName"