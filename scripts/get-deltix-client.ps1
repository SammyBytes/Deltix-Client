<#
.SYNOPSIS
    Deltix-Client one-line installer (Windows / PowerShell).

.DESCRIPTION
    Downloads the prebuilt Deltix-Client binary for Windows from GitHub
    Releases, verifies its SHA-256 against the value GitHub publishes for
    the release asset, and installs it to $HOME\.local\bin (no admin
    required).

    The Linux/macOS equivalent is scripts/get-deltix-client.sh.

.EXAMPLE
    # Default: latest release, install to ~\AppData\Local\Microsoft\WindowsApps
    # (see INSTALL_DIR env var below — default is actually $HOME\.local\bin)
    iex "& { $(irm https://raw.githubusercontent.com/SammyBytes/Deltix-Client/main/scripts/get-deltix-client.ps1) }"

.EXAMPLE
    # Pin a version
    $env:VERSION = '0.7.16'
    iex "& { $(irm https://raw.githubusercontent.com/SammyBytes/Deltix-Client/main/scripts/get-deltix-client.ps1) }"
    Remove-Item Env:VERSION

.EXAMPLE
    # System-wide install (writes to C:\Program Files\Deltix — needs admin)
    iex "& { $(irm https://raw.githubusercontent.com/SammyBytes/Deltix-Client/main/scripts/get-deltix-client.ps1) } -System"

.EXAMPLE
    # Custom install directory (e.g. inside a portable app folder)
    $env:INSTALL_DIR = 'C:\Tools\deltix'
    iex "& { $(irm https://raw.githubusercontent.com/SammyBytes/Deltix-Client/main/scripts/get-deltix-client.ps1) }"
    Remove-Item Env:INSTALL_DIR

.NOTES
    Environment variables recognised (all optional):
      VERSION       - pin a specific version (e.g. "0.7.16"); default = latest
      INSTALL_DIR   - override the install directory; default = ~/.local/bin
                     (or C:\Program Files\Deltix with -System)
#>

[CmdletBinding()]
param(
    [switch]$System
)

$ErrorActionPreference = 'Stop'

$Repo = 'SammyBytes/Deltix-Client'

function Write-Info  { param([string]$M) Write-Host "[INFO]  $M" }
function Write-Warn  { param([string]$M) Write-Host "[WARN]  $M" -ForegroundColor Yellow }
function Write-Err   { param([string]$M) Write-Host "[ERROR] $M" -ForegroundColor Red }

# --- 1. Refuse to run on non-Windows -----------------------------------------
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
    Write-Err "This installer is for Windows. For Linux/macOS use get-deltix-client.sh."
    exit 1
}

# --- 2. Resolve version ------------------------------------------------------
$Version = $env:VERSION
if (-not $Version) {
    Write-Info "Resolving latest ${Repo} release..."
    try {
        $release = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$Repo/releases/latest"
    } catch {
        Write-Err "Could not query GitHub for the latest release: $_"
        Write-Info "Pin a version with: `$env:VERSION = '0.7.16'"
        exit 1
    }
    $Version = $release.tag_name -replace '^v',''
}
$Tag = "v$Version"

# --- 3. Detect arch -> release asset name -----------------------------------
# PROCESSOR_ARCHITECTURE is 'AMD64' on x64 Windows, 'ARM64' on ARM64 Windows.
# WoW processes report x86 / x64 / arm; reject those (not what we ship).
$procArch = $env:PROCESSOR_ARCHITECTURE
switch ($procArch) {
    'AMD64' { $assetArch = 'x64' }
    'ARM64' { $assetArch = 'arm64' }
    default {
        Write-Err "Unsupported architecture: $procArch (only AMD64 / ARM64 are shipped)."
        exit 1
    }
}
$Asset = "deltix-windows-$assetArch.exe"

# --- 4. Fetch release metadata, extract download URL + expected digest ------
Write-Info "Fetching release metadata for $Tag..."
$releaseJson = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag"
$assetMeta = $releaseJson.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1
if (-not $assetMeta) {
    Write-Err "Asset '$Asset' not found in $Tag."
    exit 1
}
$DownloadUrl = $assetMeta.browser_download_url
$Digest     = $assetMeta.digest

# --- 5. Download to temp file ------------------------------------------------
$tmp = [System.IO.Path]::GetTempFileName()
try {
    Write-Info "Downloading $Asset ($Tag)..."
    # -UseBasicParsing for maximum compat (PS 5.1 too); TLS 1.2 forced for GitHub.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $tmp.FullName -UseBasicParsing
} catch {
    Write-Err "Download failed: $_"
    Remove-Item -Force $tmp.FullName -ErrorAction SilentlyContinue
    exit 1
}

# --- 6. Verify SHA-256 against GitHub's published digest (sha256:...) -------
if ($Digest -and $Digest.StartsWith('sha256:')) {
    $expected = $Digest.Substring(7)
    $actual   = (Get-FileHash -Path $tmp.FullName -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Write-Err "SHA-256 mismatch: got $actual, expected $expected."
        Remove-Item -Force $tmp.FullName -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Info "SHA-256 verified."
} else {
    Write-Warn "Release asset has no published digest; skipping integrity check."
}

# --- 7. Resolve install directory -------------------------------------------
if ($System) {
    $InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { 'C:\Program Files\Deltix' }
} else {
    $InstallDir = if ($env:INSTALL_DIR) {
        $env:INSTALL_DIR
    } else {
        Join-Path $HOME '.local\bin'
    }
}
$bin = Join-Path $InstallDir 'deltix.exe'

# If system install requires admin and we don't have it, escalate once.
$needsAdmin = $System -and -not (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
if ($needsAdmin) {
    Write-Info "System install requires admin. Re-launching with elevation..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" + ($System ? ' -System' : '')
    $psi.Verb = 'runas'
    try {
        [System.Diagnostics.Process]::Start($psi) | Out-Null
        exit 0
    } catch {
        Write-Err "Could not elevate: $($_.Exception.Message)"
        Write-Info "Re-run this script from an elevated PowerShell."
        Remove-Item -Force $tmp.FullName -ErrorAction SilentlyContinue
        exit 1
    }
}

try {
    if (-not (Test-Path -LiteralPath $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    Move-Item -Path $tmp.FullName -Destination $bin -Force
} catch {
    Write-Err "Could not install to '$bin': $_"
    Remove-Item -Force $tmp.FullName -ErrorAction SilentlyContinue
    exit 1
}
Write-Info "Installed $bin"

# --- 8. PATH hint ------------------------------------------------------------
$pathDirs = ($env:PATH -split ';') | ForEach-Object { $_.TrimEnd('\') }
if ($pathDirs -notcontains $InstallDir.TrimEnd('\')) {
    Write-Warn "$InstallDir is not on your PATH."
    Write-Host ""
    Write-Host "    PowerShell (current session only):"
    Write-Host "      `$env:PATH = '$InstallDir;' + `$env:PATH"
    Write-Host ""
    Write-Host "    PowerShell (persistent, current user):"
    Write-Host "      [Environment]::SetEnvironmentVariable('Path', '$InstallDir;' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')"
    Write-Host "      # then open a new PowerShell"
}

# --- 9. Self-test ------------------------------------------------------------
Write-Info "Done. Try: deltix version"
