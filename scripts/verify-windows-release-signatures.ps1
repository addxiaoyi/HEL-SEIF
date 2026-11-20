param(
  [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory)][string]$Directory,
  [Parameter(Mandatory)][string]$Receipt,
  [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
$signingMode = if ($AllowUnsigned) { 'unsigned' } else { 'signed' }
$thumbprint = $env:HELSELF_SIGN_CERT_SHA1
if (!$AllowUnsigned -and $thumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'Expected release signer thumbprint is missing or invalid' }

$installer = Join-Path $Directory "Helself-$Version-setup.exe"
$online = Join-Path $Directory "Helself-$Version-online-setup.exe"
$app = Join-Path $Directory 'win-unpacked/Helself.exe'
$installerName = Split-Path -Leaf $installer
$signatures = foreach ($file in @($installer, $online, $app)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($AllowUnsigned) {
    if ($signature.Status -ne 'NotSigned') {
      throw "Unsigned release check failed for $($file): expected NotSigned, got $($signature.Status)"
    }
    [ordered]@{
      file = Split-Path -Leaf $file
      status = $signature.Status.ToString()
      sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    continue
  }
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumbprint -or
      !$signature.TimeStamperCertificate) {
    throw "Release signature check failed for $($file): $($signature.Status); expected signer and trusted timestamp required"
  }
  [ordered]@{
    file = Split-Path -Leaf $file
    sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    signer = $signature.SignerCertificate.Subject
    signerThumbprint = $signature.SignerCertificate.Thumbprint
    timestampSigner = $signature.TimeStamperCertificate.Subject
    timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint
  }
}

$size = (Get-Item -LiteralPath $installer).Length
$sha512 = [Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash -LiteralPath $installer -Algorithm SHA512).Hash))
$metadata = Join-Path $Directory 'latest.yml'
$metadataJson = node -e "const fs = require('node:fs'); const yaml = require('js-yaml'); console.log(JSON.stringify(yaml.load(fs.readFileSync(process.argv[1], 'utf8'))))" $metadata
if ($LASTEXITCODE -ne 0) { throw 'Cannot parse Windows update metadata' }
$feed = $metadataJson | ConvertFrom-Json
if ($feed.version -cne $Version -or $feed.path -cne $installerName -or $feed.sha512 -cne $sha512 -or
    @($feed.files).Count -ne 1 -or $feed.files[0].url -cne $installerName -or
    $feed.files[0].sha512 -cne $sha512 -or $feed.files[0].size -ne $size) {
  throw 'Windows update metadata does not match the signed offline installer'
}

# Read the compiled resource; the staging file may not match the executable.
$bundle = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $online).Path))
$payload = $bundle.GetManifestResourceStream('payload')
if (!$payload) { throw 'Online installer payload resource missing' }
$reader = [IO.StreamReader]::new($payload)
try {
  $url = "https://github.com/addxiaoyi/HEL-SEIF/releases/download/v$Version/$installerName"
  if ($reader.ReadLine() -cne $Version -or $reader.ReadLine() -cne $url -or
      $reader.ReadLine() -cne $signatures[0].sha256 -or $reader.ReadLine() -cne "$size" -or !$reader.EndOfStream) {
    throw 'The online installer payload does not match the signed offline installer'
  }
} finally { $reader.Dispose() }

$portable = (Resolve-Path -LiteralPath (Join-Path $Directory "Helself-$Version-portable-x64.zip")).Path
$zip = [IO.Compression.ZipFile]::OpenRead($portable)
try {
  $entries = @($zip.Entries | Where-Object { $_.FullName -ceq "Helself-$Version-portable/Helself.exe" })
  if ($entries.Count -ne 1) { throw 'The portable archive must contain exactly one Helself.exe at the expected path' }
  $stream = $entries[0].Open()
  try { $portableHash = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash.ToLowerInvariant() }
  finally { $stream.Dispose() }
  if ($portableHash -ne $signatures[2].sha256) { throw 'The portable executable differs from the signed desktop executable' }
} finally { $zip.Dispose() }

$commit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the release source commit' }
[ordered]@{
  version = $Version
  signingMode = $signingMode
  sourceCommit = $commit
  verifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
  signatures = $signatures
  offlineInstallerBytes = $size
  offlineInstallerSha512 = $sha512
  onlinePayloadUrl = $url
  portableExecutableSha256 = $portableHash
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Receipt -Encoding utf8
