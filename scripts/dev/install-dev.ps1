# 本机开发：Node 20 + npm 依赖 + 复制 .env.dev / .env
# powershell -ExecutionPolicy Bypass -File scripts\dev\install-dev.ps1

param([switch]$Yes)

$ErrorActionPreference = "Stop"
$global:DevYes = [bool]$Yes
$DevRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $DevRoot "common.ps1")

Write-Host "==> 开发环境安装（配置: $ConfFile）"
$AppRoot = Resolve-DevAppRoot
$ApiDir = Join-Path $AppRoot "apps\api"
$AdminDir = Join-Path $AppRoot "apps\admin"
$Example = Join-Path $ApiDir ".env.example"
$EnvDev = Join-Path $ApiDir ".env.dev"
$EnvFile = Join-Path $ApiDir ".env"

if (-not (Test-Path -LiteralPath $Example)) {
  Write-Error "找不到模板: $Example"
}

if (-not $script:SkipConfirm) {
  Write-Host ""
  Write-Host "将在以下目录安装 Node 依赖并复制 env："
  Write-Host "  $AppRoot"
  $ok = Read-Host "继续? [Y/n]"
  if ($ok -match '^[Nn]') {
    Write-Error "已取消。"
  }
}

Ensure-NodeEnv

function Install-NpmDeps {
  param([string]$Dir, [string]$Label)
  Write-Host ""
  Write-Host "==> $Label  : $Dir"
  Set-Location $Dir
  $lock = Join-Path $Dir "package-lock.json"
  if (Test-Path -LiteralPath $lock) {
    npm ci
  } else {
    npm install
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$here = Get-Location
try {
  Install-NpmDeps -Dir $ApiDir -Label "API"
  Install-NpmDeps -Dir $AdminDir -Label "管理端"
} finally {
  Set-Location $here
}

function Copy-EnvIfMissing {
  param([string]$From, [string]$To, [string]$Label)
  if (Test-Path -LiteralPath $To) {
    Write-Host "==> 已有 $Label ，不覆盖: $To"
    return
  }
  Copy-Item -LiteralPath $From -Destination $To -Force
  Write-Host "==> 已从模板复制 $Label : $To"
}

Write-Host ""
Copy-EnvIfMissing -From $Example -To $EnvDev -Label ".env.dev"
Copy-EnvIfMissing -From $EnvDev -To $EnvFile -Label ".env"

Write-Host ""
Write-Host "开发环境（Node / 依赖 / env）已就绪。"
Write-Host "  请核对并改 apps\api\.env.dev 与 .env 里的 DATABASE_URL（两份保持一致）。"
Write-Host "  然后执行: powershell -ExecutionPolicy Bypass -File scripts\dev\setup-dev-db.ps1"
Write-Host "  启动 API:    cd apps\api    ; npm run start:dev"
Write-Host "  启动管理端:  cd apps\admin  ; npm run dev"
