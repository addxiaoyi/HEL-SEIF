param(
  [Parameter(Mandatory)][string]$LegacyInstaller,
  [Parameter(Mandatory)][string]$CandidateInstaller,
  [Parameter(Mandatory)][string]$ReportDirectory,
  [Parameter(Mandatory)][ValidateSet('reinstall', 'overlay')][string]$Migration
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Use a GitHub-hosted Windows runner.'
}

$legacyPath = Join-Path $env:RUNNER_TEMP ('historical-install-' + [guid]::NewGuid().ToString('N'))
$profilePath = Join-Path $env:APPDATA 'Nanpad'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$startupPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$programs = [Environment]::GetFolderPath('Programs')
$report = (New-Item -ItemType Directory -Path $ReportDirectory -Force).FullName

function Get-Installations {
  Get-ItemProperty -Path "$uninstallRoot\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -match 'Helself|Zhiyu|Nanpad' } |
    ForEach-Object {
      if ($_.UninstallString -notmatch '^"([^"]+)" /currentuser$') {
        throw "Unexpected uninstall command for $($_.DisplayName)"
      }
    $uninstaller = $Matches[1]
      [pscustomobject]@{
        key = $_.PSChildName
        displayName = $_.DisplayName
        displayVersion = $_.DisplayVersion
      installLocation = Split-Path -Parent $uninstaller
      uninstaller = $uninstaller
      }
    }
}

function Get-Startup([string]$Name) {
  if (Test-Path -LiteralPath $startupPath) {
    return (Get-Item -LiteralPath $startupPath).GetValue($Name)
  }
}

function Get-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  Get-ChildItem -LiteralPath $programs -Filter '*.lnk' -File |
    ForEach-Object {
      $link = $shell.CreateShortcut($_.FullName)
      if ($link.TargetPath -match '\\(Zhiyu|Helself|Nanpad)\.exe$') {
        [pscustomobject]@{ name = $_.Name; target = $link.TargetPath }
      }
    }
}

function Install-Package([string]$Installer, [string]$Arguments) {
  $setup = (Resolve-Path -LiteralPath $Installer).Path
  $process = Start-Process -FilePath $setup -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(180000)) { throw "Timed out running $setup" }
  if ($process.ExitCode -ne 0) { throw "$setup exited with $($process.ExitCode)" }
}

function Test-Profile([string]$App, [string]$Phase) {
  node (Join-Path $PSScriptRoot 'historical-upgrade-profile.mjs') $App $report $Phase
  if ($LASTEXITCODE -ne 0) { throw "Profile check failed in $Phase" }
}

if ((Test-Path -LiteralPath $profilePath) -or (Get-Installations) -or (Get-Shortcuts) -or (Get-Startup 'Zhiyu') -or (Get-Startup 'Helself')) {
  throw 'The runner already contains an installation or a profile.'
}

$legacyApp = Join-Path $legacyPath 'Zhiyu.exe'
$activeStart = '"' + $legacyApp + '"'
Install-Package $LegacyInstaller "/S /currentuser --no-desktop-shortcut /ZH_STARTUP=1 /D=$legacyPath"
if (-not (Test-Path -LiteralPath $legacyApp)) { throw 'Original setup did not create Zhiyu.exe.' }
if ((Get-Startup 'Zhiyu') -ne $activeStart) { throw 'Original setup did not enable startup.' }
$before = @(Get-Installations)
if ($before.Count -ne 1 -or $before[0].InstallLocation -ne $legacyPath) { throw 'Original installation was not registered at its chosen location.' }
Test-Profile $legacyApp 'seed'
$beforeShortcuts = @(Get-Shortcuts)

if ($Migration -eq 'reinstall') {
  $originalGuid = 'fb69fbc9-7441-53dc-a02a-7d6d9419e218'
  $legacyUninstaller = Join-Path $legacyPath 'Uninstall Zhiyu.exe'
  if ($before[0].key -ne $originalGuid -or $before[0].uninstaller -ne $legacyUninstaller) {
    throw 'Unexpected uninstaller for the original fixture.'
  }
  $fixtureFiles = @('profile.json', 'vault.enc', 'preferences.json')
  $profileHashes = @{}
  foreach ($name in $fixtureFiles) {
    $profileHashes[$name] = (Get-FileHash -LiteralPath (Join-Path $profilePath $name)).Hash
  }
  Install-Package $legacyUninstaller '/S /currentuser'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path -LiteralPath $legacyApp) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if ((Test-Path -LiteralPath $legacyApp) -or (Get-Installations) -or (Get-Startup 'Zhiyu')) {
    throw 'Original uninstall did not retire the original software and startup entry.'
  }
  foreach ($name in $fixtureFiles) {
    if ((Get-FileHash -LiteralPath (Join-Path $profilePath $name)).Hash -ne $profileHashes[$name]) {
      throw "Original uninstall changed the fixture file $name"
    }
  }
}

$arguments = '/S /currentuser --no-desktop-shortcut'
if ($Migration -eq 'reinstall') { $arguments += " /ZH_STARTUP=1 /D=$legacyPath" }
Install-Package $CandidateInstaller $arguments
$after = @(Get-Installations)
$afterShortcuts = @(Get-Shortcuts)
$current = @($after | Where-Object { $_.DisplayVersion -eq '1.17.13' })
if ($current.Count -ne 1) { throw 'Expected exactly one registered 1.17.13 installation.' }
$newApp = Join-Path $current[0].InstallLocation 'Helself.exe'
if (-not (Test-Path -LiteralPath $newApp)) { throw 'The registered candidate executable does not exist.' }

$receipt = [ordered]@{
  migration = $Migration
  before = $before
  after = $after
  beforeShortcuts = $beforeShortcuts
  afterShortcuts = $afterShortcuts
  beforeStartup = $activeStart
  afterLegacyStartup = Get-Startup 'Zhiyu'
  afterCurrentStartup = Get-Startup 'Helself'
  reusedInstallLocation = ($legacyPath -eq $current[0].InstallLocation)
  retiredLegacyInstallation = ($after.Count -eq 1 -and -not (Test-Path -LiteralPath $legacyApp))
  startupPreserved = ((Get-Startup 'Helself') -eq ('"' + $newApp + '"') -and -not (Get-Startup 'Zhiyu'))
  shortcutMigrated = ($afterShortcuts.Count -eq 1 -and $afterShortcuts[0].target -eq $newApp)
}
$receipt | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $report 'windows-upgrade.json')
$receipt | ConvertTo-Json -Depth 6 -Compress | Write-Output

Test-Profile $newApp 'verify'
$failed = @('reusedInstallLocation', 'retiredLegacyInstallation', 'startupPreserved', 'shortcutMigrated' | Where-Object { -not $receipt[$_] })
if ($failed.Count) { throw "Windows upgrade assertions failed: $($failed -join ', ')" }
Write-Output "PASS ${Migration}: workspace, encrypted vault, settings, install location, startup and shortcut."
