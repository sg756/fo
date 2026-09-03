GOST 代理（用户操作说明）
========================

总说明（含业务服务 deploy、整机执行顺序）：请先看上一级  ../README.txt

目录文件：
  gost.conf                 ← 只改这个：账号 / 密码 / 端口
  install-gost-centos9.sh   ← 首次安装
  update-gost-config.sh     ← 以后改配置并重启

一、首次安装（执行顺序）
  1. 编辑 gost.conf，改 GOST_USER / GOST_PASS / GOST_PORT
  2. sudo bash install-gost-centos9.sh
  3. 看屏幕打印：
       局域网 IP:端口  → 填中间件 / 业务侧的 proxyIP（同内网）
       公网 IP         → 填交易所白名单

二、以后维护（改账号密码端口）
  1. 再编辑 gost.conf
  2. sudo bash update-gost-config.sh

关于 IP：gost.conf 里不用填 IP（保持 GOST_LISTEN=0.0.0.0）。
与 users-manager（scripts/deploy）无强制先后依赖；需要本机代理时再装即可。
