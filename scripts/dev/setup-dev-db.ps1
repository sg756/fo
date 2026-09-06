# 本机开发：检测 MySQL、按 .env 建库/用户、prisma + seed
# 不安装 MySQL 软件。应用账号密码只读 apps\api\.env
# powershell -ExecutionPolicy Bypass -File scripts\dev\setup-dev-db.ps1

param(
  [switch]$Yes,
  [string]$RootPassword
)

$ErrorActionPreference = "Stop"
$global:DevYes = [bool]$Yes
$DevRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $DevRoot "common.ps1")

Write-Host "==> 开发库准备（配置: $ConfFile）"
$AppRoot = Resolve-DevAppRoot
$ApiDir = Join-Path $AppRoot "apps\api"
$EnvFile = Join-Path $ApiDir ".env"
$EnvDev = Join-Path $ApiDir ".env.dev"

if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Error "找不到 $EnvFile 。请先跑 scripts\dev\install-dev.ps1"
}

$rawUrl = Get-EnvFileValue -Path $EnvFile -Key "DATABASE_URL"
$db = Parse-DatabaseUrl -Url $rawUrl
if (-not $db) {
  Write-Error "无法解析 DATABASE_URL。请先改 $EnvFile （格式 mysql://用户:密码@主机:端口/库名）"
}

Write-Host "    将使用 .env 中的库: $($db.User)@$($db.Host):$($db.Port)/$($db.Name)"

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
    $hit = Get-Item -Path $g -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Test-MysqlServiceOrPort {
  $svc = Get-Service -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match 'mysql|mariadb' -and $_.Status -eq 'Running'
  }
  if ($svc) { return $true }
  $tcp = $null
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect($db.Host, [int]$db.Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1500, $false)
    if (-not $ok) { return $false }
    $tcp.EndConnect($iar)
    return $tcp.Connected
  } catch {
    return $false
  } finally {
    if ($tcp) { $tcp.Close() }
  }
}

function Write-MysqlCnf {
  param([string]$Path, [string]$User, [string]$Pass, [string]$HostName, [string]$Port)
  $lines = @(
    "[client]",
    "user=$User",
    "host=$HostName",
    "port=$Port"
  )
  if ($null -ne $Pass -and "$Pass".Length -gt 0) {
    $escPass = $Pass -replace '\\', '\\' -replace '"', '\"'
    $lines += "password=`"$escPass`""
  }
  $lines | Set-Content -LiteralPath $Path -Encoding ASCII
}

function Invoke-MysqlOnce {
  param([string]$MysqlExe, [string]$Cnf, [string]$SqlText, [string[]]$Extra)
  $a = @("--defaults-extra-file=$Cnf", "--connect-timeout=5")
  if ($Extra) { $a += $Extra }
  $script:LastMysqlOut = $SqlText | & $MysqlExe @a 2>&1
  return $LASTEXITCODE
}

function Invoke-MysqlFile {
  param(
    [string]$MysqlExe,
    [string]$User,
    [string]$Pass,
    [string]$HostName,
    [string]$Port,
    [string]$SqlFile,
    [switch]$AllowFail
  )
  $cnf = Join-Path $env:TEMP ("fo-mysql-" + [guid]::NewGuid().ToString("N") + ".cnf")
  $sqlText = Get-Content -LiteralPath $SqlFile -Raw -Encoding ASCII
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    Write-MysqlCnf -Path $cnf -User $User -Pass $Pass -HostName $HostName -Port $Port
    $code = Invoke-MysqlOnce -MysqlExe $MysqlExe -Cnf $cnf -SqlText $sqlText -Extra @()
    if ($code -ne 0) {
      $code = Invoke-MysqlOnce -MysqlExe $MysqlExe -Cnf $cnf -SqlText $sqlText -Extra @("--protocol=TCP")
    }
    # Windows 上 root 常挂在 localhost 命名管道，127.0.0.1 的 TCP 会失败
    if ($code -ne 0 -and $HostName -in @("127.0.0.1", "::1")) {
      Write-MysqlCnf -Path $cnf -User $User -Pass $Pass -HostName "localhost" -Port $Port
      $code = Invoke-MysqlOnce -MysqlExe $MysqlExe -Cnf $cnf -SqlText $sqlText -Extra @()
    }
  } finally {
    $ErrorActionPreference = $prev
    Remove-Item -LiteralPath $cnf -Force -ErrorAction SilentlyContinue
  }
  if ($code -ne 0 -and -not $AllowFail) {
    Write-Host ($script:LastMysqlOut | Out-String)
    Write-Error "mysql 执行失败（用户 $User）"
  }
  return ($code -eq 0)
}

function Test-AppDbLogin {
  param([string]$MysqlExe)
  $sql = Join-Path $env:TEMP ("fo-ping-" + [guid]::NewGuid().ToString("N") + ".sql")
  "SELECT 1;" | Set-Content -LiteralPath $sql -Encoding ASCII
  $ok = Invoke-MysqlFile -MysqlExe $MysqlExe -User $db.User -Pass $db.Pass -HostName $db.Host -Port $db.Port -SqlFile $sql -AllowFail
  Remove-Item -LiteralPath $sql -Force -ErrorAction SilentlyContinue
  return $ok
}

$mysqlExe = Find-MysqlExe
$listening = Test-MysqlServiceOrPort

if (-not $listening) {
  Write-Host ""
  Write-Host "未检测到本机 MySQL/MariaDB（服务未运行，且 $($db.Host):$($db.Port) 连不上）。"
  Write-Host "请先自行安装，例如："
  Write-Host "  winget install MariaDB.Server"
  Write-Host "  或 https://mariadb.org/download/  /  https://dev.mysql.com/downloads/mysql/"
  Write-Host "装好并启动服务后，把 apps\api\.env 与 .env.dev 的 DATABASE_URL 改成你的账号，再重新跑本脚本。"
  exit 1
}

if (-not $mysqlExe) {
  Write-Host ""
  Write-Host "MySQL 端口已开，但找不到 mysql.exe（命令行客户端）。"
  Write-Host "请把 MariaDB/MySQL 的 bin 加到 PATH，或重装时勾选 Command Line Client，再跑本脚本。"
  exit 1
}

Write-Host "==> 使用客户端: $mysqlExe"

if (Test-AppDbLogin -MysqlExe $mysqlExe) {
  Write-Host "==> .env 中的用户已能连上，跳过建用户"
} else {
  Write-Host ""
  Write-Host ".env 用户 $($db.User) 还不能登录。需要用本机 root 建库/建用户。"
  if (-not $script:SkipConfirm) {
    $go = Read-Host "是否用 root 创建库 $($db.Name) 和用户 $($db.User)? [Y/n]"
    if ($go -match '^[Nn]') {
      Write-Error "已取消。请自己建好库和用户，密码必须与 .env 的 DATABASE_URL 一致。"
    }
  }
  if ($PSBoundParameters.ContainsKey("RootPassword")) {
    $rootPass = $RootPassword
  } elseif (-not $script:SkipConfirm) {
    $rootPass = Read-Host "本机 MySQL root 密码（空密码请直接回车）"
  } else {
    $rootPass = ""
  }
  $escUser = $db.User.Replace("'", "''")
  $escPass = $db.Pass.Replace("'", "''")
  $escDb = $db.Name.Replace("'", "''").Replace("``", "````")
  $sql = Join-Path $env:TEMP ("fo-create-" + [guid]::NewGuid().ToString("N") + ".sql")
  @"
CREATE DATABASE IF NOT EXISTS ``$escDb`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$escUser'@'localhost' IDENTIFIED BY '$escPass';
CREATE USER IF NOT EXISTS '$escUser'@'127.0.0.1' IDENTIFIED BY '$escPass';
ALTER USER '$escUser'@'localhost' IDENTIFIED BY '$escPass';
ALTER USER '$escUser'@'127.0.0.1' IDENTIFIED BY '$escPass';
GRANT ALL PRIVILEGES ON ``$escDb``.* TO '$escUser'@'localhost';
GRANT ALL PRIVILEGES ON ``$escDb``.* TO '$escUser'@'127.0.0.1';
FLUSH PRIVILEGES;
"@ | Set-Content -LiteralPath $sql -Encoding ASCII
  $rootOk = Invoke-MysqlFile -MysqlExe $mysqlExe -User "root" -Pass $rootPass -HostName $db.Host -Port $db.Port -SqlFile $sql -AllowFail
  Remove-Item -LiteralPath $sql -Force -ErrorAction SilentlyContinue
  if (-not $rootOk) {
    Write-Host ""
    Write-Host "root 无法建库/用户。请检查 root 密码，或自己在客户端执行建库建用户。"
    Write-Host "用户/密码/库名必须与 .env 的 DATABASE_URL 一致，然后重新跑本脚本。"
    exit 1
  }
  if (-not (Test-AppDbLogin -MysqlExe $mysqlExe)) {
    Write-Error "已尝试建用户，但 $($db.User) 仍连不上。请核对 .env 与 MySQL 实际账号。"
  }
  Write-Host "==> 已按 .env 建好库和用户"
}

if (Test-Path -LiteralPath $EnvDev) {
  $devUrl = Get-EnvFileValue -Path $EnvDev -Key "DATABASE_URL"
  if ($devUrl -and $devUrl -ne $rawUrl) {
    Write-Host "警告: .env.dev 的 DATABASE_URL 与 .env 不一致。Nest 读 .env.dev，请改成相同。"
  }
}

Ensure-NodeEnv
Write-Host ""
Write-Host "==> prisma generate / db push / seed"
$here = Get-Location
try {
  Set-Location $ApiDir
  npx prisma generate
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npx prisma db push
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm run seed
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Set-Location $here
}

$adminEmail = Get-EnvFileValue -Path $EnvFile -Key "ADMIN_EMAIL"
if (-not $adminEmail) { $adminEmail = "见 .env 的 ADMIN_EMAIL" }

Write-Host ""
Write-Host "数据库已就绪。"
Write-Host "  管理员: $adminEmail （密码见 .env 的 ADMIN_PASSWORD；已存在则不改密）"
Write-Host "  启动 API:    cd apps\api    ; npm run start:dev"
Write-Host "  启动管理端:  cd apps\admin  ; npm run dev"
