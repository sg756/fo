# 供 B/C 脚本 dot-source：. "$PSScriptRoot\..\common.ps1"
# 依赖：调用方已设 $MobileRoot（scripts/mobile 目录）

$ErrorActionPreference = "Stop"

if (-not $MobileRoot) {
  $MobileRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$ConfFile = Join-Path $MobileRoot "mobile.conf"

function Read-MobileConf {
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

$script:MobileConf = Read-MobileConf -Path $ConfFile
$script:SkipConfirm = $false
if ($script:MobileConf["SKIP_CONFIRM"] -match '^(true|1|yes)$') { $script:SkipConfirm = $true }
if ($global:MobileYes) { $script:SkipConfirm = $true }

$script:PortableNodeHome = Expand-ConfPath -Value $script:MobileConf["NODE_HOME"]
if (-not $script:PortableNodeHome) {
  $script:PortableNodeHome = Join-Path $env:LOCALAPPDATA "users-manager-build\node"
}
$script:PortableRoot = Split-Path -Parent $script:PortableNodeHome

$script:EasProfile = if ($script:MobileConf["EAS_PROFILE"]) { $script:MobileConf["EAS_PROFILE"] } else { "preview" }
$script:EasNonInteractive = ($script:MobileConf["EAS_NON_INTERACTIVE"] -match '^(true|1|yes)$')

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
  Write-Host "(无需 Android SDK / 无需管理员; 打包在 Expo 云端完成)"
  if (-not $script:SkipConfirm) {
    $ans = Read-Host "是否继续下载? [Y/n]"
    if ($ans -match '^[Nn]') {
      Write-Error "已取消. 也可自行安装 Node 20+: https://nodejs.org/"
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

function Resolve-AppRoot {
  $candidate = Expand-ConfPath -Value $script:MobileConf["APP_ROOT"]
  if (-not $candidate) {
    $candidate = (Resolve-Path (Join-Path $MobileRoot "..\..")).Path
  }
  if (-not $script:SkipConfirm) {
    Write-Host ""
    Write-Host "======== 请确认仓库根目录 ========"
    Write-Host "当前: $candidate"
    Write-Host "应包含: apps\mobile"
    Write-Host "直接回车使用上述路径，或输入新路径："
    $input = Read-Host "APP_ROOT"
    if ($input -and $input.Trim().Length -gt 0) {
      $candidate = $input.Trim().Trim('"')
    }
  }
  if (-not (Test-Path -LiteralPath $candidate)) {
    Write-Error "目录不存在: $candidate"
  }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $mobileRel = if ($script:MobileConf["MOBILE_DIR"]) { $script:MobileConf["MOBILE_DIR"] } else { "apps\mobile" }
  $mobilePath = Join-Path $resolved $mobileRel
  if (-not (Test-Path (Join-Path $mobilePath "package.json"))) {
    Write-Error "找不到 mobile 工程: $mobilePath"
  }
  if (-not (Test-Path (Join-Path $mobilePath "eas.json"))) {
    Write-Error "找不到 eas.json: $mobilePath （需已配置 EAS 项目）"
  }
  return @{
    AppRoot    = $resolved
    MobilePath = (Resolve-Path -LiteralPath $mobilePath).Path
  }
}

function Normalize-ApiBase {
  param([string]$Raw)
  $u = ($Raw -replace '\\', '/').Trim().TrimEnd('/')
  if (-not $u) { return "" }
  if ($u -notmatch '^https?://') {
    Write-Error "API 地址须以 http:// 或 https:// 开头: $Raw"
  }
  if ($u -notmatch '/api$') {
    $u = "$u/api"
  }
  return $u
}

function Set-MobileApiEndpoint {
  param([string]$MobilePath)
  $api = Normalize-ApiBase -Raw $script:MobileConf["API_BASE"]
  if (-not $api) {
    Write-Error "mobile.conf 未配置 API_BASE（手机端访问的服务器地址，例 http://公网IP/api）"
  }
  $webRaw = $script:MobileConf["WEB_API_BASE"]
  $web = if ($webRaw -and $webRaw.Trim().Length -gt 0) {
    Normalize-ApiBase -Raw $webRaw
  } else {
    $api
  }
  $out = Join-Path $MobilePath "src\api\api.endpoint.ts"
  if (-not (Test-Path -LiteralPath (Split-Path $out -Parent))) {
    Write-Error "找不到目录: $(Split-Path $out -Parent)"
  }
  $content = @"
/**
 * 由 scripts/mobile 根据 mobile.conf 自动生成，请勿手改后指望持久保存。
 * 改地址：编辑 scripts/mobile/mobile.conf 的 API_BASE / WEB_API_BASE 后重新打包或热更新。
 */
export const PACKAGED_API_BASE = '$api';
export const PACKAGED_WEB_API_BASE = '$web';
"@
  $utf8Bom = New-Object System.Text.UTF8Encoding $true
  [System.IO.File]::WriteAllText($out, $content, $utf8Bom)
  Write-Host "==> 已写入客户端地址:"
  Write-Host "    App : $api"
  Write-Host "    H5  : $web"
  Write-Host "    文件: $out"
}

function Prepare-MobileProject {
  param([string]$MobilePath)
  Set-MobileApiEndpoint -MobilePath $MobilePath
  Write-Host "==> 安装依赖 npm ci ($MobilePath)"
  Set-Location $MobilePath
  npm ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Invoke-EasLogin {
  param([string]$MobilePath)
  Ensure-NodeEnv
  $paths = Resolve-AppRoot
  if (-not $MobilePath) { $MobilePath = $paths.MobilePath }
  Prepare-MobileProject -MobilePath $MobilePath
  Write-Host ""
  Write-Host "==> Expo / EAS 登录 (浏览器或终端按提示操作)"
  Write-Host "    账号需有权访问 app.json 里的 owner / projectId"
  npx --yes eas-cli@latest login
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host ""
  Write-Host "登录完成。可用方案 B 的 build-android.ps1 或方案 C 菜单继续打包。"
}

function Invoke-EasAndroidBuild {
  param(
    [string]$Profile,
    [string]$MobilePath
  )
  if (-not $Profile) { $Profile = $script:EasProfile }
  Ensure-NodeEnv
  if (-not $MobilePath) {
    $paths = Resolve-AppRoot
    $MobilePath = $paths.MobilePath
  }
  Prepare-MobileProject -MobilePath $MobilePath
  Write-Host ""
  Write-Host "==> EAS 云构建 Android  profile=$Profile"
  Write-Host "    本机不装 Android SDK；构建在 Expo 云端，完成后给出下载链接。"
  if ($script:EasNonInteractive) {
    npx --yes eas-cli@latest build -p android --profile $Profile --non-interactive
  } else {
    npx --yes eas-cli@latest build -p android --profile $Profile
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "若提示未登录: 先跑方案 B 的 login.ps1, 或方案 C 菜单选 1."
    exit $LASTEXITCODE
  }
  Write-Host ""
  Write-Host "构建已提交/完成。请按终端提示打开链接下载 APK/AAB。"
}

function Invoke-EasUpdate {
  param(
    [string]$Channel,
    [string]$Message,
    [string]$MobilePath
  )
  if (-not $Channel) { $Channel = "production" }
  if ($Channel -notin @("production", "preview")) {
    Write-Error "热更新 channel 无效: $Channel (应用 production|preview)"
  }
  Ensure-NodeEnv
  if (-not $MobilePath) {
    $paths = Resolve-AppRoot
    $MobilePath = $paths.MobilePath
  }
  Prepare-MobileProject -MobilePath $MobilePath
  if (-not $Message -and -not $script:SkipConfirm) {
    $Message = Read-Host "更新说明 (将显示在 EAS, 可空)"
  }
  if (-not $Message) { $Message = "js-update $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
  Write-Host ""
  Write-Host "==> EAS 热更新 channel=$Channel"
  Write-Host "    只推 JS/资源；手机需已安装带 expo-updates 的 APK。"
  Write-Host "    改原生库/权限/SDK 请改用打 APK，不要走热更新。"
  if ($script:EasNonInteractive) {
    npx --yes eas-cli@latest update --channel $Channel --environment $Channel --message $Message --non-interactive
  } else {
    npx --yes eas-cli@latest update --channel $Channel --environment $Channel --message $Message
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "若提示未登录: 先跑方案 B 的 login.ps1, 或方案 C 菜单选 1."
    exit $LASTEXITCODE
  }
  Write-Host ""
  Write-Host "热更新已发布. 用户下次打开 App 会拉取 (需已装带更新模块的 APK)."
}

function Invoke-ExpoWebExport {
  param([string]$MobilePath)
  Ensure-NodeEnv
  if (-not $MobilePath) {
    $paths = Resolve-AppRoot
    $MobilePath = $paths.MobilePath
  }
  Prepare-MobileProject -MobilePath $MobilePath
  Write-Host "==> 导出 Web (H5) -> dist"
  npx --yes expo export --platform web
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $dist = Join-Path $MobilePath "dist"
  Write-Host "导出完成: $dist (可部署到静态服务器 / 由 API 托管)"
}
