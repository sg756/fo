# 多用户管理交易系统
多用户管理交易系统

简介
此系统是在cbb开发商 的基础上 开发的一个多用户管理系统，cbb多种优秀的交易策略，并支持传统的马丁，网格，还有更好的结构化交易策略模板并能获取到稳定的下单的信号和毫秒级响应下单速度，本系统只解决个人多交易账号的情况。本系统可以支持不同的开发商，只需要替换信号api即可。  
## 
架构
本系统nodejs编写， Nest API + 管理端 
手机端 Expo（SDK 57）+ React Native
 
开发环节搭建
1 Windows只编译 
1.1 服务端源码编译
   本机只要能编译。现成的就是：
   进入到源码目录 : 打开 powershell  
   输入命令 :cd  d:\floworder\scripts\deploy-windows 
   进入目录后在执行命令:  .\build.ps1
   没有 Node 20+ 时，它会下便携 Node 再编。不用 MySQL、不用 .env.dev。
   编完得到 dist-release\（管理端静态资源 + API 的 dist）。
1.2 发布流程
   服务器系统选择linux centos9  
   首先把源码上传到Linux服务器 一般上传到 opt 文件夹下 .  上传后代码目录应该是这样 /opt/dist-release，（不要传 node_modules）
   上传脚本scripts/install-env文件夹下 三个脚本和一个配置文件 , 
   服务器上要先有  （install.sh、configure.sh、apply-dist.sh、floworder.conf）。
   可以在服务器上的opt文件夹上单独创建一个文件夹放这些脚本 linux命令:mkdir /opt/scripts创建成功后, 把这几个脚本配置文件上传在此目录下
   dist-release 是不含这些脚本的.这些工作完成 
   首次：
   改 floworder.conf  （重要 ）
   floworder.conf里面的 APP_ROOT 是必须要指向发布执行文件的目录 举例的执行文件的目录是/opt/dist-release   那么 app_root  = /opt/dist-release
   数据库账号密码和端口设置
   MYSQL_AUTO=true
   DB_HOST=127.0.0.1
   //端口
   DB_PORT=3306
   //数据库名称(可自己改名 )
   DB_NAME=users_manager
   //连接用户名(可自己改名)
   DB_USER=
   //密码
   DB_PASS= 
   数据库一定要配置好，不然后面步骤全错。

   设置好后执行命令:  sudo bash ./install.sh 
   自动安装  Node、库、设置数据库连接用户

   上面执行安装完成后 在执行命令: sudo bash ./configure.sh
   configure.sh会生成 .env文件 和创建systemd 服务.
   APP_ROOT/apps/api/.env 里的管理员密码等.
   configure.sh 必须在 apply-dist.sh 之前（后者要 systemd 单元已经在）。
   需要改默认密码 请在安装之前 打开configure.sh 
   找到这个键值改了就行
   # ===== 初始平台管理员 (seed) =====
   ADMIN_EMAIL="admin"
   ADMIN_PASSWORD="1234567"

   完成这部份安装后 装依赖、同步库、启动,  执行命令: sudo bash./apply-dist.sh 
   如果有询问就是一直yes 如果提示让你设置app_root 如果配置文件设置了，直接enter回车.

   ---以后重新再发版---
   不用再跑 install.sh / configure.sh，只要：
   本机 build.ps1 → 上传编译好的执行文件覆盖就行 →然后 Linux 上再执行一次 apply-dist.sh。

1.2.1 手机版发布
    方式：Expo EAS 云构建 
  - 需要：能跑 Node（可自动下便携版）+ Expo 账号登录 + 能上网
    在源码目录找到build.ps1,   一般路径scripts\mobile\C\build.ps1
    打开powershell 中 命令 cd  盘符:\\源码目录\scripts\mobile\C  进入到当前目录 再执行.\build.ps1，命令会列出 
    1) 登录 Expo / EAS (每台电脑首次必做)
    2) 打内测 APK (profile=preview)
    3) 打正式 APK (profile=production)
    4) 打上架 AAB (profile=store, 仅 Google Play)
    5) 导出 Web H5
    6) 热更新正式包 (channel=production, 只改 JS)
    7) 热更新内测包 (channel=preview, 只改 JS)
    0) 退出
   没有账号 先选1登录expo 去注册账号，注册成功后。第一登录需要执行一次命令初始化,在命令行中执行 
    npx eas-cli init 。按提示用当前账号新建或关联项目，它会改 app.json 的 owner、projectId。 
   再执行一次.\build.ps1 选3确定就行 ，如果有交互然后一路yes确认.

   改应用名 / 包名 / 图标（都在 apps\mobile）
   没有 app.json 时，把 app.json.example 复制为 app.json（打包脚本也会自动复制）。
   app.json 只留在本机，不要提交（含 Expo 账号、应用名、包名）。
   打开 apps\mobile\app.json，改完必须重新打 APK（热更新改不了名字、包名、图标）。

   应用程序名（手机桌面上看到的名字）：
     "name": "您的名称"
     android 里再改 "label": "您的名称"   （和 name 保持一样）
     slug 是 Expo 项目短名（英文小写、无空格），例如 "myapp"。换 slug 后要再跑一次 npx eas-cli init。

   包名（Android 唯一标识，已装的旧包无法覆盖升级）：
     android.package ，格式 com.公司或项目.应用 ，只能小写字母、数字、点，例如 com.mycompany.app
     改过包名等于一个新应用，必须重新 eas build，不能只发热更新。

   图标（替换文件，路径不用改）：
     apps\mobile\assets\icon.png                         主图标，建议 1024×1024 PNG
     apps\mobile\assets\android-icon-foreground.png      自适应图标前景
     apps\mobile\assets\android-icon-background.png      自适应图标背景
     apps\mobile\assets\android-icon-monochrome.png      单色图标
     apps\mobile\assets\favicon.png                      H5 网页图标
     换图后重新 .\build.ps1 打 APK。只改 JS 的热更新不会换图标。

1.4 linux代理安装
      上传 `scripts/gost 目录下的 gost.conf  install-gost-contos9.sh  这两文件在服务器需同一目录 建议 /opt/gost。gost.conf 中需要指定代理的账号密码和端口 ，可先windows改在上传,上传完成请在linux上 输入命令: sudo bash /opt/gost/install-gost-centos9.sh。

 1.5 开发环境搭建
   本机 Windows 改代码调试用这一节。和上面 1.1 / 1.2 的「只编译再上传 Linux」不是同一条路。
   不要跑 scripts/install-env/ 里的 Linux 脚本。脚本不会自动安装 MySQL 软件。

   前置：本机先装好 MySQL 或 MariaDB，服务要启动（默认端口 3306）。
   没有的话可自行安装，例如：winget install MariaDB.Server
   或官网：https://mariadb.org/download/   https://dev.mysql.com/downloads/mysql/
   装完把 mysql 的 bin 加到 PATH（能在 powershell 里打出 mysql 命令更好）。

   第一步：装 Node、依赖、复制 env
   打开 powershell，进入仓库根目录（有 apps\api、apps\admin 的那一层），执行：
   powershell -ExecutionPolicy Bypass -File scripts\dev\install-dev.ps1
   没有 Node 20+ 时会下载便携版（目录见 scripts\dev\dev.conf 的 NODE_HOME）。
   会给 apps\api 、 apps\admin 执行 npm 安装依赖。
   没有 apps\api\.env.dev 时，从 apps\api\.env.example 复制一份。
   没有 apps\api\.env 时，再从 .env.dev 复制一份（已有文件不覆盖）。
   .env 和 .env.dev  。

   第二步：改数据库连接（两份都要改，保持一样）
   打开这两个文件：
   apps\api\.env.dev     ← Nest 开发启动（npm run start:dev）只读这个
   apps\api\.env         ← Prisma 建表、npm run seed 读这个
   改 DATABASE_URL，格式：
   mysql://用户名:密码@127.0.0.1:3306/数据库名
   前面是连接用户，最后 / 后面是库名。例如：
   DATABASE_URL="mysql://users_manager:你的密码@127.0.0.1:3306/users_manager"
   管理员账号也可在这两份里改 ADMIN_EMAIL / ADMIN_PASSWORD（seed 用，库里已有该管理员则不改密）。

   第三步：建库、建表、写入管理员
   powershell -ExecutionPolicy Bypass -File scripts\dev\setup-dev-db.ps1
   脚本只读 .env 里的 DATABASE_URL，不会再问你一套应用账号。
   · 本机没有 MySQL / 3306 连不上：提示去装，脚本到此结束。
   · .env 里的用户已经能登录：跳过建用户，直接 prisma generate、db push、seed。
   · 用户还不存在：询问是否用本机 root 按 .env 建库、建用户并授权；同意后再输入 root 密码（空密码直接回车）。
   找不到 mysql.exe 时，把 MariaDB/MySQL 的 bin 加到 PATH 再跑一次。

   第四步：启动（开两个 powershell 窗口）
   窗口1：
   cd apps\api
   npm run start:dev
   API 默认 http://localhost:3000
   窗口2：
   cd apps\admin
   npm run dev
   管理端 Vite，接口会代理到 localhost:3000。浏览器打开终端里提示的本地地址。

   手机 App 本地调试（可选）：
   cd apps\mobile
   npm install
   确认 apps\mobile\src\api\api.endpoint.ts 指向本机 API（或改 scripts\mobile\mobile.conf 的 API_BASE 后再用打包脚本写入）。
   npx expo start
   真下单还要本机中间件（.env.dev 里 TRADE_MIDDLEWARE_BASE，默认 http://127.0.0.1:1820），只改页面可以先不装。

   脚本和可选配置：
   scripts\dev\install-dev.ps1
   scripts\dev\setup-dev-db.ps1
   scripts\dev\dev.conf
   细节：scripts\dev\README.txt

## 目录分工

| 目录 | 用途 |
|------|------|
| `scripts/install-env/` | 服务器先装环境，再 apply-dist |
| `scripts/deploy/` | Linux 上日常启停（start / restart / stop） |
| `scripts/deploy-windows/` | 本机编译 |
| `scripts/mobile/` | App（Expo）打包 |
| `scripts/gost/` | GOST 代理 |
| `scripts/dev/` | 本机 Windows 开发环境（Node / env / 建库） |

## 配置文件（脚本执行前先改）

| 用途 | 文件 |
|------|------|
| 服务器 | `install-env/floworder.conf` |
| 本地开发 API | `apps/api/.env.dev`（Nest 非 production 读取；从 `.env.example` 复制） |
| 服务器 API | `apps/api/.env`（configure 生成/改写；发布包勿带本机密文） |
| Windows 本机 | `deploy-windows/build.conf` |
| App | `mobile/mobile.conf`（本机，从 `mobile.conf.example` 复制） |
| 本机开发 | `scripts/dev/dev.conf` |

## 执行前必改配置

编辑：`scripts/install-env/floworder.conf`

至少确认：

- `APP_ROOT` — 代码最终目录（上传必须进这里）
- `PORT` — 对外端口（常用 80）
- `DB_PASS` — 数据库密码（生产务必改）
- `MYSQL_*` — 本机建库相关；外部库则 `MYSQL_AUTO=false` 并稍后在 `.env` 写 `DATABASE_URL`

本机 Windows 再改：`scripts/deploy-windows/build.conf`  
`SOURCE_ROOT`（本机源码）、`RELEASE_DIR`（上传包，默认 `dist-release`）、`NODE_HOME`

 
## 日常运维速查

| 场景 | 执行 |
|------|------|
| 装服务器环境 | `sudo bash scripts/install-env/install.sh` |
| 写业务配置 | `sudo bash scripts/install-env/configure.sh` |
| Windows 本机编译 | `scripts\deploy-windows\build.ps1` |
| Windows 产物上线 | `sudo bash scripts/install-env/apply-dist.sh` |
| Linux 启停 | `scripts/deploy/run/start.sh` / `restart.sh` / `stop.sh` |
| 本机开发 Node/依赖/env | `scripts\dev\install-dev.ps1` |
| 本机开发建库/prisma | `scripts\dev\setup-dev-db.ps1` |

## 别搞混

| 脚本 | 作用 |
|------|------|
| `install.sh` | 只装环境，不要代码也可以 |
| `configure.sh` | 有代码后写 `.env` + systemd |
| `build.ps1` | 本机编译，生成 `dist-release\` |
| `apply-dist.sh` | 产物在 Linux 上装依赖并重启（与 install 同目录，读同级 `floworder.conf`） |
| `start.sh` / `restart.sh` / `stop.sh` | Linux 上日常启停服务 |
