# =============================================================================
# 空 Windows 一键打 APK。本机不用先装 Node、不用先下代码、不用 Android SDK。
# 这条命令会：下载仓库 → 按需下载便携 Node → 打开浏览器登录 Expo → 云端打包并打印 APK 地址。
#
# 必填：-ApiBase -AppName -PackageName
# 可选：-Icon -ExpoToken -sw -Profile -GhToken（私有仓才需要）
#
#   Set-ExecutionPolicy Bypass -Scope Process -Force; $d = Join-Path $env:TEMP 'fo-app.ps1'; irm 'https://raw.githubusercontent.com/sg756/fo/main/scripts/mobile/remote-one-click.ps1' -OutFile $d; & $d -ApiBase 'http://服务器IP/api' -AppName '你的应用名' -PackageName 'com.example.app'
# =============================================================================

param(
  [ValidateSet("build", "update", "web", "login")]
  [string]$Action = "build",

  [ValidateSet("production", "preview", "store")]
  [string]$Profile = "production",

  [string]$ApiBase = "",
  [string]$WebApiBase = "",
  [string]$AppName = "",
  [string]$PackageName = "",
  [string]$Icon = "",
  [string]$ExpoToken = "",
  [string]$Message = "",
  [string]$GhToken = "",

  [switch]$sw
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Show-RemoteUsage {
  Write-Host "空机器一条命令（必填三个，缺一个就退出）：" -ForegroundColor Yellow
  Write-Host "  Set-ExecutionPolicy Bypass -Scope Process -Force; `$d = Join-Path `$env:TEMP 'fo-app.ps1'; irm 'https://raw.githubusercontent.com/sg756/fo/main/scripts/mobile/remote-one-click.ps1' -OutFile `$d; & `$d -ApiBase 'http://服务器IP/api' -AppName '你的应用名' -PackageName 'com.example.app'"
  Write-Host "私有仓再加 -GhToken '你的PAT'。图标可不填。没登录 Expo 会打开浏览器。"
}

function Test-RemoteParams {
  if ($Action -ne "build") { return }
  $missing = @()
  if (-not $ApiBase -or -not $ApiBase.Trim()) { $missing += "-ApiBase      接口地址，例 http://服务器IP/api" }
  if (-not $AppName -or -not $AppName.Trim()) { $missing += "-AppName      应用名（桌面显示）" }
  if (-not $PackageName -or -not $PackageName.Trim()) { $missing += "-PackageName  安卓包名，例 com.example.app" }
  if ($missing.Count -eq 0) { return }
  Write-Host "打包缺少参数，已停止：" -ForegroundColor Red
  foreach ($m in $missing) { Write-Host "  $m" -ForegroundColor Red }
  Write-Host ""
  Show-RemoteUsage
  exit 1
}

function Save-Url {
  param([string]$Url, [string]$OutFile, [hashtable]$Headers)
  $args = @{
    Uri             = $Url
    OutFile         = $OutFile
    UseBasicParsing = $true
    Headers         = $Headers
  }
  Invoke-WebRequest @args
}

function Get-RepoZip {
  param([string]$Token)
  $zip = Join-Path $env:TEMP "fo-main.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  $headers = @{ "User-Agent" = "fo-mobile-pack" }
  $urls = @(
    "https://codeload.github.com/sg756/fo/zip/refs/heads/main"
  )
  if ($Token) {
    $headers["Authorization"] = "Bearer $($Token.Trim())"
    $headers["Accept"] = "application/vnd.github+json"
    $urls = @(
      "https://api.github.com/repos/sg756/fo/zipball/main"
    ) + $urls
  }
  $last = ""
  foreach ($url in $urls) {
    try {
      Write-Host "==> 下载源码 $url"
      Save-Url -Url $url -OutFile $zip -Headers $headers
      $fs = [IO.File]::OpenRead($zip)
      try {
        $b0 = $fs.ReadByte(); $b1 = $fs.ReadByte()
      } finally { $fs.Close() }
      if ($b0 -eq 0x50 -and $b1 -eq 0x4B) { return $zip }
      $last = "下载到的不是压缩包"
    } catch {
      $last = $_.Exception.Message
    }
  }
  Write-Host "下载源码失败：$last" -ForegroundColor Red
  Write-Host "仓库若是私有的，请在命令末尾加 -GhToken '你的PAT'" -ForegroundColor Red
  exit 1
}

function Expand-Repo {
  param([string]$ZipPath)
  $extract = Join-Path $env:TEMP "fo-main-extract"
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  New-Item -ItemType Directory -Path $extract | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $extract -Force
  $hit = Get-ChildItem -LiteralPath $extract -Recurse -Filter package.json -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\apps\\mobile\\package\.json$' } |
    Select-Object -First 1
  if (-not $hit) {
    Write-Host "压缩包里没有 apps\mobile" -ForegroundColor Red
    exit 1
  }
  $root = (Resolve-Path (Join-Path $hit.DirectoryName "..\..")).Path
  $destParent = Join-Path $env:LOCALAPPDATA "fo-pack"
  $dest = Join-Path $destParent "src"
  New-Item -ItemType Directory -Path $destParent -Force | Out-Null
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  Move-Item -LiteralPath $root -Destination $dest
  Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
  Add-Ps1Utf8Bom -Root $dest
  return $dest
}

function Add-Ps1Utf8Bom {
  param([string]$Root)
  $utf8 = New-Object System.Text.UTF8Encoding $true
  Get-ChildItem -LiteralPath $Root -Recurse -Filter *.ps1 -File | ForEach-Object {
    $text = [IO.File]::ReadAllText($_.FullName)
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
    [IO.File]::WriteAllText($_.FullName, $text, $utf8)
  }
}

Test-RemoteParams
Write-Host "==> 空机器打包：下载源码并调用一键脚本"
$zip = Get-RepoZip -Token $GhToken
$repo = Expand-Repo -ZipPath $zip
$one = Join-Path $repo "scripts\mobile\one-click.ps1"
if (-not (Test-Path -LiteralPath $one)) {
  Write-Host "下载的源码里没有 scripts\mobile\one-click.ps1" -ForegroundColor Red
  exit 1
}

$call = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $one,
  "-Action", $Action,
  "-Profile", $Profile
)
if ($ApiBase) { $call += @("-ApiBase", $ApiBase) }
if ($WebApiBase) { $call += @("-WebApiBase", $WebApiBase) }
if ($AppName) { $call += @("-AppName", $AppName) }
if ($PackageName) { $call += @("-PackageName", $PackageName) }
if ($Icon -and $Icon.Trim()) { $call += @("-Icon", $Icon.Trim()) }
if ($ExpoToken -and $ExpoToken.Trim()) { $call += @("-ExpoToken", $ExpoToken.Trim()) }
if ($Message) { $call += @("-Message", $Message) }
if ($sw) { $call += "-sw" }

Write-Host "==> 源码目录 $repo"
& powershell.exe @call
exit $LASTEXITCODE
