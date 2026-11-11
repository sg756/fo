h5-nginx/ · 另一台小机托管 Expo H5
============================================================

只改同目录 h5-nginx.conf（不读 floworder.conf）。

默认：
  监听 80
  静态 /var/www/floworder-h5
  /api/ → 192.168.0.3:80/api/


--------------------------------------------------------------------------------
安装 / 更新配置
--------------------------------------------------------------------------------

  sudo bash scripts/h5-nginx/install.sh

  会生成两份配置：
    /etc/nginx/conf.d/00-floworder-h5-http.conf
      upstream 保活、gzip、open_file_cache、访问日志格式
    sites-available 或 conf.d 下的 floworder-h5.conf
      server：安全头、超时、API 反代缓冲、静态长缓存、SPA 回退、/healthz


--------------------------------------------------------------------------------
上传 H5
--------------------------------------------------------------------------------

  rsync -av apps/mobile/dist/ root@H5机:/var/www/floworder-h5/

  WEB_API_BASE 示例：http://177.4.12.89/api


--------------------------------------------------------------------------------
常用
--------------------------------------------------------------------------------

  systemctl status|restart|reload nginx
  curl -I http://127.0.0.1/healthz
  tail -f /var/log/nginx/floworder-h5.access.log
