# 把 Linux 上 export-db.sh 导出的 .sql 导入本机测试库。
# 目标库只读 apps\api\.env 的 DATABASE_URL，会先删掉该库里的同名表再导入。
# powershell -ExecutionPolicy Bypass -File scripts\dev\import-linux-db.ps1 -Dump D:\backup\users_manager-20261009.sql

param(
  [Parameter(Mandatory = $true)]
  [string]$Dump,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$DevRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $DevRoot "common.ps1")

if (-not (Test-Path -LiteralPath $Dump)) {
  Write-Error "找不到导出文件: $Dump"
}
$Dump = (Resolve-Path -LiteralPath $Dump).Path

$AppRoot = Resolve-DevAppRoot
$EnvFile = Join-Path $AppRoot "apps\api\.env"
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Error "找不到 $EnvFile 。请先跑 scripts\dev\install-dev.ps1"
}
$rawUrl = Get-EnvFileValue -Path $EnvFile -Key "DATABASE_URL"
$db = Parse-DatabaseUrl -Url $rawUrl
if (-not $db) {
  Write-Error "无法解析 DATABASE_URL（格式 mysql://用户:密码@主机:端口/库名）"
}

Write-Host "==> 将导入到本机 $($db.User)@$($db.Host):$($db.Port)/$($db.Name)"
Write-Host "    来源: $Dump"
Write-Host "    该库里与导出文件同名的表会被覆盖。"
if (-not $Yes) {
  $ans = Read-Host "确认导入? [y/N]"
  if ($ans -notmatch '^[Yy]') {
    Write-Host "已取消。"
    exit 0
  }
}

function Find-MysqlExe {
  $cmd = Get-Command mysql -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $globs = @(
    "$env:ProgramFiles\MariaDB*\bin\mysql.exe",
    "${env:ProgramFiles(x86)}\MariaDB*\bin\mysql.exe",
    "$env:ProgramFiles\MySQL\MySQL Server *\bin\mysql.exe",
    "${env:ProgramFiles(x86)}\MySQL\MySQL Server *\bin\mysql.exe"
  )
  foreach ($g in $globs) {
    $hit = Get-Item $g -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$mysqlExe = Find-MysqlExe
if (-not $mysqlExe) {
  Write-Error "找不到 mysql.exe。请安装 MariaDB/MySQL 客户端，或把它加进 PATH。"
}

$cnf = Join-Path $env:TEMP ("fo-mysql-" + [guid]::NewGuid().ToString("N") + ".cnf")
function Write-Cnf([string]$HostName) {
  @(
    "[client]"
    "host=$HostName"
    "port=$($db.Port)"
    "user=$($db.User)"
    "password=$($db.Pass)"
    "default-character-set=utf8mb4"
  ) | Set-Content -LiteralPath $cnf -Encoding ASCII
}

function Invoke-Mysql([string[]]$Extra) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $mysqlExe --defaults-extra-file=$cnf @Extra
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

try {
  Write-Cnf $db.Host
  $code = Invoke-Mysql @("--execute=SELECT 1")
  if ($code -ne 0 -and $db.Host -in @("127.0.0.1", "::1")) {
    Write-Cnf "localhost"
    $code = Invoke-Mysql @("--execute=SELECT 1")
  }
  if ($code -ne 0) {
    Write-Error "连不上本机库 $($db.User)@$($db.Host):$($db.Port)。请核对 apps\api\.env 的 DATABASE_URL。"
  }

  $create = "CREATE DATABASE IF NOT EXISTS ``$($db.Name)`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  if ((Invoke-Mysql @("--execute=$create")) -ne 0) {
    Write-Error "创建数据库 $($db.Name) 失败"
  }

  Write-Host "==> 导入中…"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    # 用 cmd 重定向，避免 PowerShell 管道把大 SQL 拆坏
    cmd.exe /c "`"$mysqlExe`" --defaults-extra-file=`"$cnf`" --default-character-set=utf8mb4 $($db.Name) < `"$Dump`""
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($code -ne 0) {
    Write-Error "导入失败（退出码 $code）"
  }
  Write-Host "==> 导入完成: $($db.Name)"
} finally {
  Remove-Item -LiteralPath $cnf -Force -ErrorAction SilentlyContinue
}
