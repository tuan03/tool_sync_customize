# Sync API Guide

API này dùng để hệ thống bên ngoài gửi `productId` và `Raw Amazon JSON` sang app, rồi app sẽ tự sync cấu hình customize lên Shopify.

## Endpoint

`POST /api/shopify/sync-api`

Ví dụ:

```text
https://your-domain.com/api/shopify/sync-api
```

## Headers

```http
Content-Type: application/json
Authorization: Bearer YOUR_CUSTOMIZER_ADMIN_SECRET
```

`YOUR_CUSTOMIZER_ADMIN_SECRET` là giá trị `CUSTOMIZER_ADMIN_SECRET` đang cấu hình trên server của app.

## Body tối thiểu

```json
{
  "productId": "8762669662407",
  "rawAmazonJson": "{...Raw Amazon JSON...}"
}
```

## Body đầy đủ

```json
{
  "productId": "8762669662407",
  "rawAmazonJson": "{...Raw Amazon JSON...}",
  "priceMultiplier": 1,
  "sourceUrl": "https://www.amazon.com/your-product"
}
```

## Ý nghĩa các field

- `productId`: Shopify product id cần sync.
- `rawAmazonJson`: chuỗi JSON gốc lấy từ Amazon Custom.
- `priceMultiplier`: hệ số nhân giá, có thể bỏ qua nếu không dùng.
- `sourceUrl`: link nguồn để lưu tham chiếu, không bắt buộc.

## Response thành công

```json
{
  "ok": true,
  "message": "Sync successful for product 8762669662407.",
  "result": {
    "productId": "8762669662407"
  }
}
```

## Response lỗi

```json
{
  "ok": false,
  "message": "Sync failed.",
  "error": "Product already has native variants. Automatic migration only supports products that still use the default single variant."
}
```

## cURL mẫu

```bash
curl -X POST "https://your-domain.com/api/shopify/sync-api" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_CUSTOMIZER_ADMIN_SECRET" \
  -d '{
    "productId": "8762669662407",
    "rawAmazonJson": "{...Raw Amazon JSON...}",
    "priceMultiplier": 1
  }'
```

## Ghi chú

- API này sẽ chạy sync thật, không phải dry-run.
- Nếu `productId` không hợp lệ, token sai, hoặc dữ liệu Amazon lỗi, API sẽ trả về `ok: false`.
- Với bản logic hiện tại, auto-migrate chỉ an toàn cho product còn `single default variant`.
