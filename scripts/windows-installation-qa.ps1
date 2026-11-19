param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw '完整试装仅允许在 GitHub 托管的一次性 Windows runner 执行。'
}
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$setup = (Resolve-Path -LiteralPath $Installer).Path
$version = (Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json).version
$shellIdentityRaw = node --input-type=module -e "import { WINDOWS_TOAST_CLSID, windowsAppId } from './electron/services/windows-identity.mjs'; console.log(JSON.stringify({ appId: windowsAppId(true), toastClsid: WINDOWS_TOAST_CLSID }));"
if ($LASTEXITCODE -ne 0) { throw '无法读取 Windows 通知身份。' }
$shellIdentity = $shellIdentityRaw | ConvertFrom-Json
$installRoot = Join-Path $env:RUNNER_TEMP ('helself-install-' + [guid]::NewGuid().ToString('N'))
$appPath = Join-Path $installRoot 'Helself'
$profile = Join-Path $installRoot 'profile'
$programs = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs'
$shortcut = Join-Path $programs 'Helself.lnk'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$existing = Get-ChildItem $uninstallKey -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object DisplayName -in 'Helself','Nanpad'
if ($existing -or (Test-Path -LiteralPath $shortcut)) { throw 'runner 已有安装，拒绝覆盖。' }
New-Item -ItemType Directory -Path $profile -Force | Out-Null

function Install-Candidate([bool]$First) {
  $startup = if ($First) { ' /ZH_STARTUP=1' } else { '' }
  $process = Start-Process -FilePath $setup -ArgumentList ("/S /currentuser --no-desktop-shortcut$startup /D=$appPath") -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(120000)) { throw '安装超时。' }
  if ($process.ExitCode -ne 0) { throw "安装失败：$($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath (Join-Path $appPath 'Helself.exe'))) { throw '程序未写入预期目录。' }
}
function Check-Profile([string]$Mode) {
  $previousStyle = $env:HELSELF_QA_SPLIT_PROFILE
  try {
    $env:HELSELF_QA_SPLIT_PROFILE = if ($Mode -eq 'verify') { '1' } else { '0' }
    node (Join-Path $PSScriptRoot 'packaged-profile-integration.mjs') (Join-Path $appPath 'Helself.exe') $profile $Mode
    if ($LASTEXITCODE -ne 0) { throw "安装后资料验证失败：$Mode" }
  } finally {
    $env:HELSELF_QA_SPLIT_PROFILE = $previousStyle
  }
}
function Check-Shortcut([string]$Stage) {
  if (-not (Test-Path -LiteralPath $shortcut)) { throw '缺少开始菜单快捷方式。' }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $expectedTarget = Join-Path $appPath 'Helself.exe'
  $expectedIcon = Join-Path $appPath 'resources\helself.ico'
  $shellHelper = Join-Path $appPath 'resources\windows-shell\Helself.WindowsShell.exe'
  if (-not (Test-Path -LiteralPath $shellHelper)) { throw '缺少 Windows 快捷方式辅助程序。' }
  $metadataRaw = & $shellHelper --inspect $shortcut
  if ($LASTEXITCODE -ne 0) { throw '无法读取快捷方式通知身份。' }
  $metadata = $metadataRaw | ConvertFrom-Json
  [ordered]@{
    stage = $Stage
    expectedTarget = $expectedTarget
    actualTarget = $link.TargetPath
    expectedIcon = $expectedIcon + ',0'
    actualIcon = $link.IconLocation
    iconExists = (Test-Path -LiteralPath $expectedIcon)
    workingDirectory = $metadata.workingDirectory
    appId = $metadata.appId
    toastClsid = $metadata.toastClsid
    toastVariantType = $metadata.toastVariantType
  } | ConvertTo-Json -Compress | Write-Output
  if ($link.TargetPath -ne $expectedTarget) { throw '快捷方式程序路径不匹配。' }
  if ($link.IconLocation -ne ($expectedIcon + ',0')) { throw '快捷方式图标路径不匹配。' }
  if ($metadata.workingDirectory -ne $appPath) { throw '快捷方式工作目录不匹配。' }
  if ($metadata.appId -ne $shellIdentity.appId) { throw '快捷方式应用身份不匹配。' }
  if ($metadata.toastVariantType -ne 72) { throw '快捷方式通知身份不是原生 GUID 类型。' }
  if ([guid]$metadata.toastClsid -ne [guid]$shellIdentity.toastClsid) { throw '快捷方式通知 CLSID 不匹配。' }
}
try {
  Install-Candidate $true
  Check-Shortcut 'fresh-install'
  $installedVersion = (Get-Item (Join-Path $appPath 'Helself.exe')).VersionInfo.ProductVersion
  if ($installedVersion -notin @($version, "$version.0")) { throw '安装版本不匹配。' }
  Check-Profile 'seed'
  Check-Shortcut 'after-first-launch'
  Install-Candidate $false
  Check-Shortcut 'overlay-upgrade'
  Check-Profile 'verify'
  Check-Shortcut 'after-upgrade-launch'
  $startup = Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' 'Helself'
  if ($startup -ne ('"' + (Join-Path $appPath 'Helself.exe') + '"')) { throw '覆盖升级未保留自启偏好。' }
  foreach ($name in @('Helself.exe','Uninstall Helself.exe')) {
    & (Join-Path $PSScriptRoot 'windows-icon-check.ps1') -IconPath (Join-Path $appPath $name) -OutputPng (Join-Path $root ('screenshots/qa-installed-' + $name + '.png'))
    if ($LASTEXITCODE -ne 0) { throw '安装后图标不匹配。' }
  }
  Write-Output 'PASS actual installation, launch, overlay upgrade, encrypted profile, preferences and shortcuts'
} finally {
  $uninstaller = Join-Path $appPath 'Uninstall Helself.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { throw '卸载超时。' }
    if ($process.ExitCode -ne 0) { throw '卸载失败。' }
  }
}
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ((Test-Path -LiteralPath (Join-Path $appPath 'Helself.exe')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (Test-Path -LiteralPath (Join-Path $appPath 'Helself.exe')) { throw '卸载未清理程序。' }
if (-not (Test-Path -LiteralPath (Join-Path $profile '.helself-qa-profile'))) { throw '卸载误删隔离资料。' }
$remaining = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
if ($remaining.Helself) { throw '卸载未清理自启项。' }
Write-Output 'PASS uninstall removes program and startup entry, preserves profile'
