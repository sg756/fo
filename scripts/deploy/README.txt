deploy/ · Linux 服务器日常运维（启停）
============================================================

编译在 Windows（../deploy-windows/）。本目录只负责服务器上启停服务。

  run/     start.sh / restart.sh / stop.sh

配置文件：../install-env/floworder.conf

装环境 / 写配置 / 上线产物：
  ../install-env/install.sh
  ../install-env/configure.sh
  ../install-env/apply-dist.sh

日常启停：
  sudo bash scripts/deploy/run/start.sh
  sudo bash scripts/deploy/run/restart.sh
  sudo bash scripts/deploy/run/stop.sh
