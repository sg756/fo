GOST 代理（用户操作说明）
========================

总说明（含整机执行顺序）：请先看上一级  ../README.txt

目录文件：
  gost.conf                 ← 只改这个：账号 / 密码 / 端口
  install-gost-centos9.sh   ← 首次安装
  update-gost-config.sh     ← 以后改配置并重启
  check-gost-stability.sh   ← 抽查连通率、延迟、出口 IP
  check-gost-speed.sh       ← 查内存占用，以及经代理的延迟和下载速度

一、首次安装（执行顺序）
  1. 编辑 gost.conf，改 GOST_USER / GOST_PASS / GOST_PORT
  2. sudo bash install-gost-centos9.sh
  3. 看屏幕打印：
       局域网 IP:端口  → 填中间件 / 业务侧的 proxyIP（同内网）
       公网 IP         → 填交易所白名单

二、以后维护（改账号密码端口）
  1. 再编辑 gost.conf
  2. sudo bash update-gost-config.sh

三、稳定性抽查（在 gost 这台服务器上）
  1. 本脚本与 gost.conf 放在同一目录
  2. bash check-gost-stability.sh
  3. 看成功次数、延迟、出口 IP。出口 IP 应与交易所白名单一致，且开始/结束相同
  拉长采样：CHECK_N=300 bash check-gost-stability.sh

四、网速和内存（偶发下单失败时）
  bash check-gost-speed.sh
  按提示选：1 通过代理，2 不走代理、直连币安。
  也可以直接：bash check-gost-speed.sh 1    或    bash check-gost-speed.sh 2
  看：可用内存、到币安合约/现货 ping 的延迟和失败次数、一次下载速度。
  选 1 时还会看 gost 常驻内存。代理地址仍可写在后面：bash check-gost-speed.sh 1 127.0.0.1
  多采几次延迟：CHECK_N=20 bash check-gost-speed.sh 2

关于 IP：gost.conf 里不用填 IP（保持 GOST_LISTEN=0.0.0.0）。
与 users-manager 无强制先后依赖；需要本机代理时再装即可。
