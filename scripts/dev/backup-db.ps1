# 备份本机测试库。账号只读 apps\api\.env 的 DATABASE_URL。
# powershell -ExecutionPolicy Bypass -File scripts\dev\backup-db.ps1
# 指定路径： -Out D:\backup\local.sql

param(
  [string]$Out
)

$ErrorActionPreference = "Stop"
$DevRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $DevRoot "common.ps1")

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

function Find-MysqlTool([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $globs = @(
    "$env:ProgramFiles\MariaDB*\bin\$Name.exe",
    "${env:ProgramFiles(x86)}\MariaDB*\bin\$Name.exe",
    "$env:ProgramFiles\MySQL\MySQL Server *\bin\$Name.exe",
    "${env:ProgramFiles(x86)}\MySQL\MySQL Server *\bin\$Name.exe"
  )
  foreach ($g in $globs) {
    $hit = Get-Item $g -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$dumpExe = Find-MysqlTool "mysqldump"
if (-not $dumpExe) { $dumpExe = Find-MysqlTool "mariadb-dump" }
if (-not $dumpExe) {
  Write-Error "找不到 mysqldump.exe。请安装 MariaDB/MySQL 客户端，或把它加进 PATH。"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $Out) {
  $dir = Join-Path $AppRoot "backups"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $Out = Join-Path $dir ("local-" + $db.Name + "-" + $stamp + ".sql")
} else {
  $parent = Split-Path -Parent $Out
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
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

function Invoke-Dump([string]$HostName) {
  Write-Cnf $HostName
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $dumpExe --defaults-extra-file=$cnf --single-transaction --quick --routines --triggers --hex-blob --no-tablespaces --default-character-set=utf8mb4 --result-file=$Out $db.Name
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return $code
}

Write-Host "==> 备份本机 $($db.User)@$($db.Host):$($db.Port)/$($db.Name)"
$code = Invoke-Dump $db.Host
if ($code -ne 0 -and $db.Host -in @("127.0.0.1", "::1")) {
  $code = Invoke-Dump "localhost"
}
Remove-Item -LiteralPath $cnf -Force -ErrorAction SilentlyContinue
if ($code -ne 0 -or -not (Test-Path -LiteralPath $Out)) {
  Write-Error "备份失败（退出码 $code）"
}
$len = (Get-Item -LiteralPath $Out).Length
Write-Host "==> 已写出 $Out （$len 字节）"
Write-Host "恢复： powershell -ExecutionPolicy Bypass -File scripts\dev\import-linux-db.ps1 -Dump `"$Out`""
