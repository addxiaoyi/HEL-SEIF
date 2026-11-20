$ErrorActionPreference = 'Stop'
$legacyBase = 'https://github.com/Songwo/zhiyu/releases/download/v1.17.3'
$legacyHash = '04a831046e19827bfefb19363b792411c1b7a27667c5dbe101ffdc305cbaca3b'
$manifestHash = '6703dce9bc69078492e3b3495d8ceba4a85ce065ce52e52ca34b97ddd103e57e'
$artifactHash = '098543495f35f610a1452e97dcb6d4ce04347d551a0bcc9bd80c3d11e5cd9869'
$artifactId = 14545681040
$legacyName = 'Zhiyu-1.17.3-setup.exe'
$stage = Join-Path $env:RUNNER_TEMP 'historical-upgrade-input'
New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path historical-report | Out-Null
$legacy = Join-Path $stage $legacyName
$manifest = Join-Path $stage 'legacy-SHA256SUMS.txt'
$artifact = Join-Path $stage 'candidate.zip'

function Assert-Digest([string]$Path, [string]$Hash) {
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Hash) { throw "Unexpected digest for $Path ($actual)" }
}

Invoke-WebRequest -Uri "$legacyBase/$legacyName" -OutFile $legacy
Invoke-WebRequest -Uri "$legacyBase/SHA256SUMS.txt" -OutFile $manifest
Assert-Digest $legacy $legacyHash
Assert-Digest $manifest $manifestHash
if ((Get-Item -LiteralPath $legacy).Length -ne 116247390) { throw 'Wrong legacy size' }
if (-not (Get-Content -LiteralPath $manifest | Where-Object { $_.Trim() -match "^$legacyHash\s+\*?$([regex]::Escape($legacyName))$" })) {
  throw 'Legacy published checksum does not match'
}

$headers = @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json' }
Invoke-WebRequest -Uri "https://api.github.com/repos/$env:GITHUB_REPOSITORY/actions/artifacts/$artifactId/zip" -Headers $headers -OutFile $artifact
Assert-Digest $artifact $artifactHash
$candidateDir = Join-Path $stage 'candidate'
Expand-Archive -LiteralPath $artifact -DestinationPath $candidateDir
$candidate = @(Get-ChildItem -LiteralPath $candidateDir -Recurse -File -Filter 'Helself-1.17.13-setup.exe')
if ($candidate.Count -ne 1) { throw 'Candidate artifact must contain one offline installer' }
$candidate = $candidate[0].FullName
[ordered]@{
  legacyCommit = '19949728549852a1d9020fa20ccfb287e15fdc0b'
  legacyUrl = "$legacyBase/$legacyName"
  legacySha256 = $legacyHash
  legacySignature = (Get-AuthenticodeSignature -LiteralPath $legacy).Status.ToString()
  candidateSource = '8ac9fb9ef5e8fe7ab607f2d107cd87a340b70ecc'
  candidateRun = 44554301796
  candidateArtifact = $artifactId
  candidateArtifactSha256 = $artifactHash
  candidateSha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  candidateSignature = (Get-AuthenticodeSignature -LiteralPath $candidate).Status.ToString()
} | ConvertTo-Json | Tee-Object -FilePath historical-report/provenance.json
"HISTORICAL_LEGACY_EXE=$legacy" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"HISTORICAL_CANDIDATE_EXE=$candidate" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
