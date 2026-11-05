param(
  [Parameter(Mandatory = $true)][string]$IconPath,
  [Parameter(Mandatory = $true)][string]$OutputPng,
  [string]$ExpectedIconPath = (Join-Path $PSScriptRoot '../build/icon.ico'),
  [long]$WindowHandle = 0,
  [string]$ExpectedWindowImagePath = (Join-Path $PSScriptRoot '../build/icon.png')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HelselfShellIcon {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Info {
    public IntPtr Icon;
    public int Index;
    public uint Attributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Display;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string Type;
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SHGetFileInfo(string path, uint attrs, out Info info, uint size, uint flags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
"@

# 直接查询 Windows Shell 的文件图标，避免 Electron 接口返回通用文件类型图标。
function Read-ShellBitmap([string]$Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $info = New-Object HelselfShellIcon+Info
  $found = [HelselfShellIcon]::SHGetFileInfo($resolved, 0, [ref]$info, [System.Runtime.InteropServices.Marshal]::SizeOf($info), 0x100)
  if ($found -eq [IntPtr]::Zero -or $info.Icon -eq [IntPtr]::Zero) { throw 'Windows returned no icon' }
  $icon = [System.Drawing.Icon]::FromHandle($info.Icon)
  try { return $icon.ToBitmap() }
  finally {
    $icon.Dispose()
    [HelselfShellIcon]::DestroyIcon($info.Icon) | Out-Null
  }
}
$bitmap = $null
if ($WindowHandle) {
  $handle = [HelselfShellIcon]::SendMessage([IntPtr]$WindowHandle, 0x7F, [IntPtr]1, [IntPtr]::Zero)
  if ($handle -eq [IntPtr]::Zero) { throw 'Window returned no application icon' }
  # WM_GETICON 返回借用句柄，不能 DestroyIcon，否则会破坏正在运行的窗口。
  $borrowed = [System.Drawing.Icon]::FromHandle($handle)
  try { $bitmap = $borrowed.ToBitmap() } finally { $borrowed.Dispose() }
} else { $bitmap = Read-ShellBitmap $IconPath }
$expected = $null
try {
  $expected = if ($WindowHandle) {
    [System.Drawing.Bitmap]::new((Resolve-Path -LiteralPath $ExpectedWindowImagePath).Path)
  } else { Read-ShellBitmap $ExpectedIconPath }
  if ($bitmap.Size -ne $expected.Size) {
    $resized = [System.Drawing.Bitmap]::new($expected, $bitmap.Size)
    $expected.Dispose()
    $expected = $resized
  }
  $matched = 0
  $difference = 0
  for ($y = 0; $y -lt $bitmap.Height; $y++) {
    for ($x = 0; $x -lt $bitmap.Width; $x++) {
      $pixel = $bitmap.GetPixel($x, $y)
      $reference = $expected.GetPixel($x, $y)
      $delta = [Math]::Abs([int]$pixel.A - $reference.A)
      if ($pixel.A -gt 0 -or $reference.A -gt 0) {
        $delta += [Math]::Abs([int]$pixel.R - $reference.R)
        $delta += [Math]::Abs([int]$pixel.G - $reference.G)
        $delta += [Math]::Abs([int]$pixel.B - $reference.B)
      }
      $difference += $delta
      if ($delta -le 24) { $matched++ }
    }
  }
  $bitmap.Save([IO.Path]::GetFullPath($OutputPng))
  $pixels = $bitmap.Width * $bitmap.Height
  # 比较实际几何与配色，避免旧色板或碰巧同色的默认图标蒙混通过。
  $ratio = $matched / $pixels
  $mean = $difference / ($pixels * 4)
  $valid = $ratio -ge 0.97 -and $mean -le 3
  @{ ok = $valid; matchedRatio = $ratio; meanDifference = $mean; size = $bitmap.Width } | ConvertTo-Json -Compress
  if (-not $valid) { exit 1 }
} finally {
  if ($bitmap) { $bitmap.Dispose() }
  if ($expected) { $expected.Dispose() }
}
