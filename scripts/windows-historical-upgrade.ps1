param(
  [Parameter(Mandatory)][string]$LegacyInstaller,
  [Parameter(Mandatory)][string]$CandidateInstaller,
  [Parameter(Mandatory)][string]$ReportDirectory
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
    Select-Object PSChildName, DisplayName, DisplayVersion, InstallLocation, UninstallString
}

function Get-Startup([string]$Name) {
  if (Test-Path -LiteralPath $startupPath) {
    return Get-ItemPropertyValue -Path $startupPath -Name $Name -ErrorAction SilentlyContinue
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
$beforeShortcuts = @(Get-Shortcuts)
Test-Profile $legacyApp 'seed'

Install-Package $CandidateInstaller '/S /currentuser --no-desktop-shortcut'
$after = @(Get-Installations)
$afterShortcuts = @(Get-Shortcuts)
$current = @($after | Where-Object { $_.DisplayVersion -eq '1.17.13' })
if ($current.Count -ne 1) { throw 'Expected exactly one registered 1.17.13 installation.' }
$newApp = Join-Path $current[0].InstallLocation 'Helself.exe'
if (-not (Test-Path -LiteralPath $newApp)) { throw 'The registered candidate executable does not exist.' }

$receipt = [ordered]@{
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
Write-Output 'PASS historical upgrade preserves workspace, encrypted vault, settings, install location, startup and shortcut.'
