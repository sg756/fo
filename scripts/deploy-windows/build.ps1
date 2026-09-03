# ============================================================
#  Windows 构建：管理端(admin) + API
#  配置：同目录 build.conf（源码目录、Node 安装目录等）
#  用法：powershell -ExecutionPolicy Bypass -File scripts\deploy-windows\build.ps1
# ============================================================

param(
  [switch]$Yes  # 等价于 build.conf 里 SKIP_CONFIRM=true（临时用）
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfFile = Join-Path $ScriptDir "build.conf"

function Read-BuildConf {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "找不到配置文件: $Path"
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
  # 展开 %VAR%
  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  return $expanded
}

$Conf = Read-BuildConf -Path $ConfFile
$SkipConfirm = $Yes -or ($Conf["SKIP_CONFIRM"] -match '^(true|1|yes)$')
$PrismaMode = if ($Conf["PRISMA_MODE"]) { $Conf["PRISMA_MODE"].ToLowerInvariant() } else { "skip" }
if ($PrismaMode -notin @("push", "deploy", "skip", "none")) {
  Write-Error "build.conf PRISMA_MODE 无效: $PrismaMode（应用 push|deploy|skip）"
}

$PortableNodeHome = Expand-ConfPath -Value $Conf["NODE_HOME"]
if (-not $PortableNodeHome) {
  $PortableNodeHome = Join-Path $env:LOCALAPPDATA "users-manager-build\node"
}
$PortableRoot = Split-Path -Parent $PortableNodeHome

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Use-PortableNodeIfPresent {
  $nodeExe = Join-Path $PortableNodeHome "node.exe"
  $npmCmd = Join-Path $PortableNodeHome "npm.cmd"
  if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $npmCmd)) {
    if ($env:Path -notlike "*$PortableNodeHome*") {
      $env:Path = "$PortableNodeHome;$env:Path"
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
  $major = Get-NodeMajor
  if ($major -lt 20) { return $false }
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
    Write-Warning "无法查询 nodejs.org，使用备用版本 $fallbackVer"
    return $fallback
  }
}

function Install-PortableNode {
  Write-Host ""
  Write-Host "未检测到 Node.js 20+。"
  Write-Host "将下载官方便携版到 build.conf 的 NODE_HOME（一般无需管理员）："
  Write-Host "  $PortableNodeHome"
  if (-not $SkipConfirm) {
    $ans = Read-Host "是否继续下载并安装？[Y/n]"
    if ($ans -match '^[Nn]') {
      Write-Error "已取消。也可自行安装：https://nodejs.org/ （选 LTS 即可）"
    }
  }

  $info = Get-Node20DistInfo
  $zipPath = Join-Path $env:TEMP "node-$($info.Version)-win-x64.zip"
  $extractTo = Join-Path $env:TEMP "node-extract-$($info.Version)"

  Write-Host "==> 下载 $($info.ZipUrl)"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $info.ZipUrl -OutFile $zipPath -UseBasicParsing

  if (Test-Path -LiteralPath $extractTo) {
    Remove-Item -LiteralPath $extractTo -Recurse -Force
  }
  New-Item -ItemType Directory -Path $extractTo -Force | Out-Null

  Write-Host "==> 解压..."
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractTo -Force

  $inner = Get-ChildItem -LiteralPath $extractTo -Directory | Select-Object -First 1
  if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName "node.exe"))) {
    Write-Error "解压后未找到 node.exe，请检查下载包是否完整。"
  }

  New-Item -ItemType Directory -Path $PortableRoot -Force | Out-Null
  if (Test-Path -LiteralPath $PortableNodeHome) {
    Remove-Item -LiteralPath $PortableNodeHome -Recurse -Force
  }
  Move-Item -LiteralPath $inner.FullName -Destination $PortableNodeHome

  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $extractTo -Recurse -Force -ErrorAction SilentlyContinue

  if (-not (Use-PortableNodeIfPresent)) {
    Write-Error "便携 Node 安装后仍不可用: $PortableNodeHome"
  }
  if (-not (Test-NodeOk)) {
    Write-Error "node 版本仍低于 20：$(node -v)"
  }
  Write-Host "==> 便携环境已就绪 node=$(node -v) npm=$(npm -v)"
  Write-Host "    （目录见 build.conf 的 NODE_HOME；未改系统 PATH）"
}

function Confirm-AppRoot {
  param([string]$DefaultRoot)

  $candidate = $DefaultRoot
  if (-not $SkipConfirm) {
    Write-Host ""
    Write-Host "======== 请确认源码目录 ========"
    Write-Host "当前: $candidate"
    Write-Host "（可在 build.conf 改 SOURCE_ROOT）"
    Write-Host "目录下应有: apps\admin 、 apps\api"
    Write-Host "直接回车 = 使用上述路径；或输入新的绝对路径："
    $input = Read-Host "源码目录"
    if ($input -and $input.Trim().Length -gt 0) {
      $candidate = $input.Trim().Trim('"')
    }
  }

  if (-not (Test-Path -LiteralPath $candidate)) {
    Write-Error "源码目录不存在: $candidate"
  }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $adminPkg = Join-Path $resolved "apps\admin\package.json"
  $apiPkg = Join-Path $resolved "apps\api\package.json"
  if (-not (Test-Path -LiteralPath $adminPkg) -or -not (Test-Path -LiteralPath $apiPkg)) {
    Write-Error "目录不完整，需要 apps\admin 与 apps\api。当前: $resolved"
  }

  if (-not $SkipConfirm) {
    Write-Host ""
    Write-Host "将使用源码目录: $resolved"
    $ok = Read-Host "确认开始编译？[Y/n]"
    if ($ok -match '^[Nn]') {
      Write-Error "已取消编译。"
    }
  }

  return $resolved
}

function Publish-ReleaseBundle {
  param(
    [string]$SourceRoot,
    [string]$OutDir
  )

  Write-Host ""
  Write-Host "==> 组装发布包（与 Linux APP_ROOT 相对路径一致）: $OutDir"
  if (Test-Path -LiteralPath $OutDir) {
    Remove-Item -LiteralPath $OutDir -Recurse -Force
  }

  $adminSrc = Join-Path $SourceRoot "apps\admin\dist"
  $apiSrcDist = Join-Path $SourceRoot "apps\api\dist"
  $apiPkg = Join-Path $SourceRoot "apps\api\package.json"
  $apiLock = Join-Path $SourceRoot "apps\api\package-lock.json"
  $apiPrisma = Join-Path $SourceRoot "apps\api\prisma"

  $adminDst = Join-Path $OutDir "apps\admin\dist"
  $apiDst = Join-Path $OutDir "apps\api"

  New-Item -ItemType Directory -Path $adminDst -Force | Out-Null
  New-Item -ItemType Directory -Path $apiDst -Force | Out-Null

  Copy-Item -Path (Join-Path $adminSrc "*") -Destination $adminDst -Recurse -Force
  Copy-Item -Path $apiSrcDist -Destination (Join-Path $apiDst "dist") -Recurse -Force
  Copy-Item -Path $apiPkg -Destination (Join-Path $apiDst "package.json") -Force
  if (-not (Test-Path -LiteralPath $apiLock)) {
    Write-Error "缺少 apps\api\package-lock.json（服务器 apply-dist 需要它做 npm ci）。请先在 apps\api 执行 npm install 生成 lock。"
  }
  Copy-Item -Path $apiLock -Destination (Join-Path $apiDst "package-lock.json") -Force
  if (Test-Path -LiteralPath $apiPrisma) {
    Copy-Item -Path $apiPrisma -Destination (Join-Path $apiDst "prisma") -Recurse -Force
  } else {
    Write-Error "缺少 apps\api\prisma"
  }

  $okAdmin = Test-Path (Join-Path $adminDst "index.html")
  $okApi = Test-Path (Join-Path $apiDst "dist\main.js")
  $okLock = Test-Path (Join-Path $apiDst "package-lock.json")
  if (-not $okAdmin -or -not $okApi -or -not $okLock) {
    Write-Error "发布包校验失败（需 admin/dist/index.html、api/dist/main.js、api/package-lock.json）"
  }

  Write-Host "    已生成:"
  Write-Host "      apps\admin\dist\"
  Write-Host "      apps\api\dist\"
  Write-Host "      apps\api\package.json / package-lock.json / prisma\"
  Write-Host "    （含 prisma/seed.js；服务器 apply-dist 会自动 seed）"
  Write-Host "    （不打包 .env / .env.dev；服务器密钥由 install-env/configure.sh 写 .env）"
  Write-Host "    上传方式：把「$OutDir 目录内的内容」覆盖到服务器 APP_ROOT（不要传 node_modules）"
}

# ---- 0) 读配置 ----
Write-Host "==> 配置文件: $ConfFile"
Write-Host "    NODE_HOME=$PortableNodeHome"
Write-Host "    PRISMA_MODE=$PrismaMode"

# ---- 1) 解析并确认源码目录 ----
# SOURCE_ROOT = 编译输入
$SourceRoot = Expand-ConfPath -Value $Conf["SOURCE_ROOT"]
if (-not $SourceRoot) {
  $SourceRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
}
$SourceRoot = Confirm-AppRoot -DefaultRoot $SourceRoot
$AdminDir = Join-Path $SourceRoot "apps\admin"
$ApiDir = Join-Path $SourceRoot "apps\api"

# RELEASE_DIR = 编译输出（上传包）；默认 SOURCE_ROOT\dist-release
$ReleaseDir = Expand-ConfPath -Value $Conf["RELEASE_DIR"]
if (-not $ReleaseDir) {
  $ReleaseDir = Join-Path $SourceRoot "dist-release"
}
Write-Host "    SOURCE_ROOT=$SourceRoot"
Write-Host "    RELEASE_DIR=$ReleaseDir"

# ---- 2) 编译环境 ----
Use-PortableNodeIfPresent | Out-Null
if (Test-NodeOk) {
  Write-Host "==> 已检测到编译环境 node=$(node -v) npm=$(npm -v)，直接编译"
} else {
  Install-PortableNode
}

# ---- 2.5) 停掉本机可能锁住 node_modules 的进程（nest/vite 等）----
Write-Host "==> 释放可能锁定 node_modules 的本机 Node 进程"
Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $cmd = [string]$_.CommandLine
    $cmd -match 'FlowOrder|users-manager|nest|vite|apps\\api|apps\\admin'
  } |
  ForEach-Object {
    Write-Host "    结束 PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 1

# ---- 3) 编译 ----
Write-Host ""
Write-Host "==> 源码目录(SOURCE_ROOT): $SourceRoot"
Write-Host "==> 构建管理端 admin"
Set-Location $AdminDir
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not (Test-Path (Join-Path $AdminDir "dist\index.html"))) {
  Write-Error "admin 构建失败：找不到 dist\index.html"
}

Write-Host "==> 构建 API"
Set-Location $ApiDir
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npx prisma generate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not (Test-Path (Join-Path $ApiDir "dist\main.js"))) {
  Write-Error "api 构建失败：找不到 dist\main.js"
}

Write-Host "==> 数据库同步 (PRISMA_MODE=$PrismaMode)"
switch ($PrismaMode) {
  "deploy" { npx prisma migrate deploy; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
  "push"   { npx prisma db push; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
  default  { Write-Host "    跳过 Prisma（生产库请在 Linux 用 scripts/install-env/apply-dist.sh 同步）" }
}

# ---- 4) 组装与服务器同结构的发布包 ----
Publish-ReleaseBundle -SourceRoot $SourceRoot -OutDir $ReleaseDir

Write-Host ""
Write-Host "Windows 构建完成。"
Write-Host "  源码内产物: $AdminDir\dist  |  $ApiDir\dist\main.js"
Write-Host "  上传用目录(RELEASE_DIR): $ReleaseDir"
Write-Host ""
Write-Host "下一步："
Write-Host "  1) 将 $ReleaseDir\ 下的 apps\ 覆盖到 Linux 的 APP_ROOT（install-env/floworder.conf）"
Write-Host "  2) sudo bash scripts/install-env/apply-dist.sh"
Write-Host "  详见 scripts\deploy-windows\README.txt"
