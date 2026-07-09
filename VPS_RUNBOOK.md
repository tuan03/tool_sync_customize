# VPS Runbook

Thong tin hien tai:

- VPS user: `vmadmin`
- VPS IP: `160.25.81.57`
- Domain tam thoi neu chua mua domain: `160.25.81.57.sslip.io`
- App folder du kien: `/var/www/tool_sync_customize`
- Node app port: `3000`
- PM2 app name: `amazon-customizer`
- Public admin URL: `https://160.25.81.57.sslip.io/admin.html`
- Shopify app proxy URL: `https://160.25.81.57.sslip.io/api/shopify/proxy`

## SSH vao VPS

```bash
ssh vmadmin@160.25.81.57
```

## Vao thu muc app

```bash
cd /var/www/tool_sync_customize
```

## Cai dat package

```bash
npm install
```

## Chay app bang PM2

Lan dau:

```bash
pm2 start server.js --name amazon-customizer
pm2 save
```

Sau khi reboot VPS, de PM2 tu khoi dong lai app:

```bash
pm2 startup
```

Chay lenh PM2 in ra, thuong se la mot lenh `sudo ...`, roi chay lai:

```bash
pm2 save
```

## Lenh quan ly app

Xem trang thai:

```bash
pm2 status
```

Restart app:

```bash
pm2 restart amazon-customizer
```

Dung app:

```bash
pm2 stop amazon-customizer
```

Chay lai app da dung:

```bash
pm2 start amazon-customizer
```

Xoa app khoi PM2:

```bash
pm2 delete amazon-customizer
pm2 save
```

Xem log app:

```bash
pm2 logs amazon-customizer
```

Xem 100 dong log gan nhat:

```bash
pm2 logs amazon-customizer --lines 100
```

## File env tren VPS

Mo file:

```bash
nano /var/www/tool_sync_customize/.env.shopify
```

Moi lan doi token/secret/env thi restart app:

```bash
pm2 restart amazon-customizer
```

Bien quan trong:

```env
SHOPIFY_SHOP="your-shop.myshopify.com"
SHOPIFY_CLIENT_ID="..."
SHOPIFY_CLIENT_SECRET="..."
SHOPIFY_ACCESS_TOKEN="..."
SHOPIFY_API_VERSION="2026-04"

CUSTOMIZER_ADMIN_SECRET="..."
CUSTOMIZER_UPLOAD_SECRET="..."
CUSTOMIZER_CRON_SECRET="..."

PORT=3000
```

## Nginx

File config du kien:

```bash
sudo nano /etc/nginx/sites-available/amazon-customizer
```

Kiem tra config:

```bash
sudo nginx -t
```

Reload Nginx:

```bash
sudo systemctl reload nginx
```

Restart Nginx:

```bash
sudo systemctl restart nginx
```

Xem trang thai Nginx:

```bash
sudo systemctl status nginx
```

## Xem request co toi VPS khong

Access log:

```bash
sudo tail -f /var/log/nginx/access.log
```

Error log:

```bash
sudo tail -f /var/log/nginx/error.log
```

Test tu Windows:

```powershell
curl.exe -I https://160.25.81.57.sslip.io/admin.html
```

Test tren VPS:

```bash
curl -I http://127.0.0.1:3000/admin.html
curl -I https://160.25.81.57.sslip.io/admin.html
```

## SSL/HTTPS

Cap HTTPS voi Certbot:

```bash
sudo certbot --nginx -d 160.25.81.57.sslip.io
```

Kiem tra auto-renew:

```bash
sudo certbot renew --dry-run
```

Xem certificate:

```bash
sudo certbot certificates
```

## Shopify app config

Trong `shopify.app.toml` can tro ve VPS:

```toml
application_url = "https://160.25.81.57.sslip.io/admin.html"

[app_proxy]
url = "https://160.25.81.57.sslip.io/api/shopify/proxy"
subpath = "amazon-customizer"
prefix = "apps"
```

Deploy Shopify app:

```bash
shopify app deploy --allow-updates
```

## Deploy code moi len VPS

Neu source tren VPS clone tu Git:

```bash
cd /var/www/tool_sync_customize
git pull
npm install
npm test
pm2 restart amazon-customizer
```

Neu co thay doi theme extension/function thi deploy Shopify app:

```bash
shopify app deploy --allow-updates
```

## Kiem tra truoc khi deploy

Tren may local hoac VPS:

```bash
node --check extensions/amazon-customizer/assets/amazon-customizer.js
npm test
```

Neu sua `public/customizer.js`:

```bash
node --check public/customizer.js
```

## Cleanup file order cu

Dry-run:

```bash
npm run cleanup
```

Xoa that:

```bash
npm run cleanup:apply
```

Co the chi dinh so ngay:

```bash
node scripts/cleanup-shopify-files.js --days=30
node scripts/cleanup-shopify-files.js --days=30 --apply
```

## Flow test sau deploy

1. Mo `https://160.25.81.57.sslip.io/admin.html`.
2. Nhap Product ID.
3. Paste raw Amazon JSON.
4. Bam Convert.
5. Bam Dry-run Sync.
6. Bam Sync to Shopify.
7. Vao product tren Shopify.
8. Mo customizer.
9. Upload anh, chinh preview.
10. Add customized item.
11. Kiem tra cart preview, phu phi va addon hidden.

## Loi thuong gap

Neu `admin.html` khong vao duoc:

```bash
pm2 status
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log
```

Neu upload anh loi:

- Kiem tra app proxy trong `shopify.app.toml`.
- Kiem tra `SHOPIFY_CLIENT_SECRET` tren VPS co dung khong.
- Kiem tra log:

```bash
pm2 logs amazon-customizer
sudo tail -f /var/log/nginx/access.log
```

Neu token Shopify thay doi:

```bash
nano /var/www/tool_sync_customize/.env.shopify
pm2 restart amazon-customizer
```

