# 供 install-dev.ps1 / setup-dev-db.ps1 dot-source
# 依赖：调用方已设 $DevRoot（scripts/dev 目录）

$ErrorActionPreference = "Stop"

if (-not $DevRoot) {
  $DevRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$ConfFile = Join-Path $DevRoot "dev.conf"

function Read-DevConf {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "找不到配置: $Path"
  }
  Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { return }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim().Trim('"').Trim("'")
    $map[$k] = $v
  }
  return $map
}

function Expand-ConfPath {
  param([string]$Value)
  if (-not $Value) { return "" }
  return [Environment]::ExpandEnvironmentVariables($Value)
}

$script:DevConf = Read-DevConf -Path $ConfFile
$script:SkipConfirm = $false
if ($script:DevConf["SKIP_CONFIRM"] -match '^(true|1|yes)$') { $script:SkipConfirm = $true }
if ($global:DevYes) { $script:SkipConfirm = $true }

$script:PortableNodeHome = Expand-ConfPath -Value $script:DevConf["NODE_HOME"]
if (-not $script:PortableNodeHome) {
  $script:PortableNodeHome = Join-Path $env:LOCALAPPDATA "users-manager-build\node"
}
$script:PortableRoot = Split-Path -Parent $script:PortableNodeHome

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Use-PortableNodeIfPresent {
  $nodeExe = Join-Path $script:PortableNodeHome "node.exe"
  $npmCmd = Join-Path $script:PortableNodeHome "npm.cmd"
  if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $npmCmd)) {
    if ($env:Path -notlike "*$script:PortableNodeHome*") {
      $env:Path = "$script:PortableNodeHome;$env:Path"
    }
    return $true
  }
  return $false
}

function Get-NodeMajor {
  Use-PortableNodeIfPresent | Out-Null
  Refresh-Path
  Use-PortableNodeIfPresent | Out-Null
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { return -1 }
  try {
    $v = & node -v 2>$null
    if (-not $v) { return -1 }
    return [int](($v -replace '^v', '').Split('.')[0])
  } catch {
    return -1
  }
}

function Test-NodeOk {
  Use-PortableNodeIfPresent | Out-Null
  if ((Get-NodeMajor) -lt 20) { return $false }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { return $false }
  return $true
}

function Get-Node20DistInfo {
  $fallbackVer = "v20.18.1"
  $fallback = @{
    Version = $fallbackVer
    ZipUrl  = "https://nodejs.org/dist/$fallbackVer/node-$fallbackVer-win-x64.zip"
  }
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 60
    $pick = $index | Where-Object { $_.lts -ne $false -and $_.version -match '^v20\.' } | Select-Object -First 1
    if (-not $pick) {
      $pick = $index | Where-Object { $_.version -match '^v20\.' } | Select-Object -First 1
    }
    if (-not $pick) { return $fallback }
    $ver = $pick.version
    return @{
      Version = $ver
      ZipUrl  = "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip"
    }
  } catch {
    Write-Warning "无法查询 nodejs.org，使用备用 $fallbackVer"
    return $fallback
  }
}

function Ensure-NodeEnv {
  Use-PortableNodeIfPresent | Out-Null
  if (Test-NodeOk) {
    Write-Host "==> Node 已就绪: $(node -v) / npm $(npm -v)"
    return
  }
  Write-Host ""
  Write-Host "未检测到 Node.js 20+。将下载便携版到："
  Write-Host "  $script:PortableNodeHome"
  if (-not $script:SkipConfirm) {
    $ans = Read-Host "是否继续下载? [Y/n]"
    if ($ans -match '^[Nn]') {
      Write-Error "已取消。也可自行安装 Node 20+: https://nodejs.org/"
    }
  }
  $info = Get-Node20DistInfo
  $zipPath = Join-Path $env:TEMP "node-$($info.Version)-win-x64.zip"
  $extractTo = Join-Path $env:TEMP "node-extract-$($info.Version)"
  Write-Host "==> 下载 $($info.ZipUrl)"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $info.ZipUrl -OutFile $zipPath -UseBasicParsing
  if (Test-Path -LiteralPath $extractTo) { Remove-Item -LiteralPath $extractTo -Recurse -Force }
  New-Item -ItemType Directory -Path $extractTo -Force | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractTo -Force
  $inner = Get-ChildItem -LiteralPath $extractTo -Directory | Select-Object -First 1
  if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName "node.exe"))) {
    Write-Error "解压后未找到 node.exe"
  }
  New-Item -ItemType Directory -Path $script:PortableRoot -Force | Out-Null
  if (Test-Path -LiteralPath $script:PortableNodeHome) {
    Remove-Item -LiteralPath $script:PortableNodeHome -Recurse -Force
  }
  Move-Item -LiteralPath $inner.FullName -Destination $script:PortableNodeHome
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $extractTo -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Use-PortableNodeIfPresent) -or -not (Test-NodeOk)) {
    Write-Error "便携 Node 安装后仍不可用"
  }
  Write-Host "==> 便携 Node 就绪: $(node -v)"
}

function Resolve-DevAppRoot {
  $candidate = Expand-ConfPath -Value $script:DevConf["APP_ROOT"]
  if (-not $candidate) {
    $candidate = (Resolve-Path (Join-Path $DevRoot "..\..")).Path
  }
  if (-not (Test-Path -LiteralPath $candidate)) {
    Write-Error "源码目录不存在: $candidate"
  }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $apiPkg = Join-Path $resolved "apps\api\package.json"
  $adminPkg = Join-Path $resolved "apps\admin\package.json"
  if (-not (Test-Path -LiteralPath $apiPkg) -or -not (Test-Path -LiteralPath $adminPkg)) {
    Write-Error "目录不完整，需要 apps\api 与 apps\admin。当前: $resolved"
  }
  return $resolved
}

function Get-EnvFileValue {
  param(
    [string]$Path,
    [string]$Key
  )
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  $line = Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object {
    $_ -match ("^\s*" + [regex]::Escape($Key) + "\s*=")
  } | Select-Object -First 1
  if (-not $line) { return "" }
  $raw = $line.Substring($line.IndexOf("=") + 1).Trim()
  if (($raw.StartsWith('"') -and $raw.EndsWith('"')) -or ($raw.StartsWith("'") -and $raw.EndsWith("'"))) {
    $raw = $raw.Substring(1, $raw.Length - 2)
  }
  return $raw
}

function Parse-DatabaseUrl {
  param([string]$Url)
  if (-not $Url) { return $null }
  $m = [regex]::Match($Url, '^mysql://([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/([^?]+)')
  if (-not $m.Success) { return $null }
  function Decode-UrlPart([string]$s) {
    return [Uri]::UnescapeDataString(($s -replace '\+', '%20'))
  }
  return [pscustomobject]@{
    User = Decode-UrlPart $m.Groups[1].Value
    Pass = Decode-UrlPart $m.Groups[2].Value
    Host = $m.Groups[3].Value
    Port = if ($m.Groups[4].Value) { $m.Groups[4].Value } else { "3306" }
    Name = $m.Groups[5].Value.TrimEnd('/')
  }
}
