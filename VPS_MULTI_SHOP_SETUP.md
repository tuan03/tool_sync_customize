# VPS Multi-Shop Setup

Muc tieu:

- Mot VPS chay nhieu shop.
- Moi shop co mot Node process rieng.
- Moi shop co mot `.env.shopify` rieng.
- Moi shop dung mot port rieng.
- Nginx public ra HTTPS va proxy ve dung port.

Vi du:

| Shop | Folder | Port | PM2 name | Public URL |
| --- | --- | ---: | --- | --- |
| leatherbag | `/var/www/customizer-leatherbag` | `3000` | `customizer-leatherbag` | `https://leatherbag.160.25.81.57.sslip.io` |
| mugshop | `/var/www/customizer-mugshop` | `3001` | `customizer-mugshop` | `https://mugshop.160.25.81.57.sslip.io` |
| walletshop | `/var/www/customizer-walletshop` | `3002` | `customizer-walletshop` | `https://walletshop.160.25.81.57.sslip.io` |

`sslip.io` cho phep dung subdomain tren IP, nen khi chua co domain rieng co the dung:

```txt
<shop-key>.160.25.81.57.sslip.io
```

Sau nay neu co domain that thi thay bang:

```txt
customizer-shop1.yourdomain.com
customizer-shop2.yourdomain.com
```

## Dieu can nho

Kien truc hien tai cua source la single-shop theo `.env.shopify`.

Nghia la moi Node process chi biet 1 shop:

```env
SHOPIFY_SHOP="..."
SHOPIFY_ACCESS_TOKEN="..."
SHOPIFY_CLIENT_SECRET="..."
PORT=3000
```

Neu muon nhieu shop trong cung 1 process thi phai refactor OAuth + database luu token theo shop. Chua lam cai do thi cach on dinh nhat la: **1 shop = 1 folder + 1 port + 1 PM2 process**.

## Quy uoc port

Dung port tang dan:

```txt
3000: shop dau tien
3001: shop thu hai
3002: shop thu ba
...
```

Kiem tra port dang dung:

```bash
sudo ss -lntp
```

## Setup shop moi

Bien can thay:

```bash
SHOP_KEY="leatherbag"
SHOP_HOST="leatherbag.160.25.81.57.sslip.io"
APP_PORT="3000"
APP_DIR="/var/www/customizer-${SHOP_KEY}"
PM2_NAME="customizer-${SHOP_KEY}"
```

### 1. Clone/copy source

Neu source nam tren Git:

```bash
cd /var/www
git clone <repo-url> customizer-leatherbag
cd /var/www/customizer-leatherbag
npm install
```

Neu copy tu shop da co san tren VPS:

```bash
cd /var/www
cp -a tool_sync_customize customizer-leatherbag
cd /var/www/customizer-leatherbag
npm install
```

Khuyen nghi: moi shop nen co folder rieng de khong de `.env.shopify` cua shop nay de len shop khac.

### 2. Tao `.env.shopify` cho shop

```bash
nano /var/www/customizer-leatherbag/.env.shopify
```

Template:

```env
SHOPIFY_SHOP="leatherbag-3anqqbf8.myshopify.com"
SHOPIFY_CLIENT_ID="5806d58aa47058c823c21d0ca93e2814"
SHOPIFY_CLIENT_SECRET="..."
SHOPIFY_ACCESS_TOKEN="..."
SHOPIFY_API_VERSION="2026-04"

CUSTOMIZER_ADMIN_SECRET="chuoi-bi-mat-admin-cua-shop-nay"
CUSTOMIZER_UPLOAD_SECRET="chuoi-bi-mat-upload-cua-shop-nay"
CUSTOMIZER_CRON_SECRET="chuoi-bi-mat-cleanup-cua-shop-nay"

PORT=3000
```

Quan trong:

- Moi shop co `SHOPIFY_ACCESS_TOKEN` rieng.
- Moi shop co `SHOPIFY_CLIENT_SECRET` dung voi app config cua shop/app do.
- Moi shop co `PORT` khac nhau.

### 3. Chay shop bang PM2

```bash
cd /var/www/customizer-leatherbag
pm2 start server.js --name customizer-leatherbag
pm2 save
```

Kiem tra:

```bash
pm2 status
pm2 logs customizer-leatherbag
```

Test local tren VPS:

```bash
curl -I http://127.0.0.1:3000/admin.html
```

### 4. Tao Nginx config cho shop

```bash
sudo nano /etc/nginx/sites-available/customizer-leatherbag
```

Template:

```nginx
server {
    listen 80;
    server_name leatherbag.160.25.81.57.sslip.io;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable:

```bash
sudo ln -s /etc/nginx/sites-available/customizer-leatherbag /etc/nginx/sites-enabled/customizer-leatherbag
sudo nginx -t
sudo systemctl reload nginx
```

### 5. Cap HTTPS

```bash
sudo certbot --nginx -d leatherbag.160.25.81.57.sslip.io
```

Test public:

```bash
curl -I https://leatherbag.160.25.81.57.sslip.io/admin.html
```

Mo tren trinh duyet:

```txt
https://leatherbag.160.25.81.57.sslip.io/admin.html
```

### 6. Sua `shopify.app.toml` cua shop

Trong folder shop:

```bash
nano /var/www/customizer-leatherbag/shopify.app.toml
```

Sua:

```toml
application_url = "https://leatherbag.160.25.81.57.sslip.io/admin.html"

[app_proxy]
url = "https://leatherbag.160.25.81.57.sslip.io/api/shopify/proxy"
subpath = "amazon-customizer"
prefix = "apps"
```

Deploy Shopify app:

```bash
cd /var/www/customizer-leatherbag
shopify app deploy --allow-updates
```

## Lenh quan ly tung shop

Restart:

```bash
pm2 restart customizer-leatherbag
```

Stop:

```bash
pm2 stop customizer-leatherbag
```

Start lai:

```bash
pm2 start customizer-leatherbag
```

Xem log:

```bash
pm2 logs customizer-leatherbag
```

Xem log request Nginx:

```bash
sudo tail -f /var/log/nginx/access.log
```

Xem loi Nginx:

```bash
sudo tail -f /var/log/nginx/error.log
```

## Them shop thu hai

Vi du shop `mugshop`, port `3001`.

```bash
cd /var/www
cp -a tool_sync_customize customizer-mugshop
cd /var/www/customizer-mugshop
nano .env.shopify
```

`.env.shopify`:

```env
SHOPIFY_SHOP="mugshop.myshopify.com"
SHOPIFY_CLIENT_ID="..."
SHOPIFY_CLIENT_SECRET="..."
SHOPIFY_ACCESS_TOKEN="..."
SHOPIFY_API_VERSION="2026-04"

CUSTOMIZER_ADMIN_SECRET="..."
CUSTOMIZER_UPLOAD_SECRET="..."
CUSTOMIZER_CRON_SECRET="..."

PORT=3001
```

PM2:

```bash
pm2 start server.js --name customizer-mugshop
pm2 save
```

Nginx:

```bash
sudo nano /etc/nginx/sites-available/customizer-mugshop
```

```nginx
server {
    listen 80;
    server_name mugshop.160.25.81.57.sslip.io;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable + HTTPS:

```bash
sudo ln -s /etc/nginx/sites-available/customizer-mugshop /etc/nginx/sites-enabled/customizer-mugshop
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d mugshop.160.25.81.57.sslip.io
```

Shopify config:

```toml
application_url = "https://mugshop.160.25.81.57.sslip.io/admin.html"

[app_proxy]
url = "https://mugshop.160.25.81.57.sslip.io/api/shopify/proxy"
subpath = "amazon-customizer"
prefix = "apps"
```

Deploy:

```bash
shopify app deploy --allow-updates
```

## Update code cho nhieu shop

Neu moi shop la mot folder copy rieng, khi sua code can update tung folder:

```bash
cd /var/www/customizer-leatherbag
git pull
npm install
npm test
pm2 restart customizer-leatherbag
```

```bash
cd /var/www/customizer-mugshop
git pull
npm install
npm test
pm2 restart customizer-mugshop
```

Neu thay doi extension/function, can deploy Shopify app cho shop/app tuong ung:

```bash
shopify app deploy --allow-updates
```

## Backup env truoc khi sua

```bash
cp .env.shopify ".env.shopify.backup.$(date +%Y%m%d-%H%M%S)"
```

## Kiem tra port bi trung

```bash
sudo ss -lntp | grep ':3000'
sudo ss -lntp | grep ':3001'
sudo ss -lntp | grep ':3002'
```

Neu port da co process dung, doi port trong `.env.shopify` va Nginx config.

## Checklist cho moi shop moi

1. Co folder rieng trong `/var/www/customizer-<shop-key>`.
2. `.env.shopify` dung shop/token/secret/port rieng.
3. PM2 process dang chay.
4. Nginx proxy dung host va port.
5. HTTPS da cap bang Certbot.
6. `shopify.app.toml` da tro ve public URL cua shop do.
7. Da `shopify app deploy --allow-updates`.
8. Mo duoc `/admin.html`.
9. Convert/Dry-run/Sync thanh cong.
10. Product customizer upload duoc anh.
11. Add customized item thanh cong.
12. Cart an addon va hien preview dung.

