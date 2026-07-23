# Production Preview API

Guide ngắn cho app thứ 3 lấy preview và thông tin customization.

## Auth

Gửi header:

```http
Authorization: Bearer YOUR_CUSTOMIZER_PREVIEW_SECRET
```

Secret lấy từ server app:

- `CUSTOMIZER_PREVIEW_SECRET`
- hoặc fallback `CUSTOMIZER_ADMIN_SECRET`

## Endpoint

### 1. Lấy toàn bộ item custom trong 1 order

```http
GET /production-preview-data?order_id=%231009
```

Lưu ý:

- dùng `#1009`, không phải chỉ `1009`
- nếu dùng Shopify order ID thật thì có thể truyền GID

Ví dụ:

```http
GET https://your-app-domain/production-preview-data?order_id=%231009
Authorization: Bearer YOUR_CUSTOMIZER_PREVIEW_SECRET
```

### 2. Lấy 1 customization cụ thể

```http
GET /production-preview-data?customization_id=YOUR_CUSTOMIZATION_ID
```

Ví dụ:

```http
GET https://your-app-domain/production-preview-data?customization_id=a1832188-4281-4acf-aacc-70e11630dbd9
Authorization: Bearer YOUR_CUSTOMIZER_PREVIEW_SECRET
```

### 3. Mở trang preview HTML

Theo order:

```http
GET /production-preview?order_id=%231009
```

Theo customization:

```http
GET /production-preview?customization_id=YOUR_CUSTOMIZATION_ID
```

## Response chính

Khi gọi theo `order_id`, response sẽ có:

- `order`: thông tin đơn hàng
- `items`: danh sách item custom

Mỗi item có:

- `lineItem.title`: tên sản phẩm
- `lineItem.variantTitle`: biến thể đã chọn
- `lineItem.sku`
- `lineItem.quantity`
- `customization.visibleProperties`: thông tin dễ đọc cho người sản xuất
- `customization.uploads`: ảnh khách upload
- `customization.decodedPayload`: payload đã giải mã JSON
- `productionPreviewUrl`: link mở preview

## App thứ 3 nên dùng thế nào

Flow khuyên dùng:

1. nhập `order_id`
2. gọi `/production-preview-data`
3. nếu có nhiều item thì cho người dùng chọn hoặc hiển thị tất cả
4. dùng `visibleProperties` để đọc nội dung custom
5. dùng `productionPreviewUrl` để mở preview

## Ví dụ JSON rút gọn

```json
{
  "ok": true,
  "mode": "order",
  "order": {
    "name": "#1009"
  },
  "items": [
    {
      "customizationId": "a1832188-4281-4acf-aacc-70e11630dbd9",
      "lineItem": {
        "title": "Music Album Welcome Mat",
        "variantTitle": "24x36 / None",
        "sku": "AMZ-RUG-...",
        "quantity": 1
      },
      "productionPreviewUrl": "https://your-store-domain/apps/amazon-customizer/production-preview?customization_id=...",
      "customization": {
        "visibleProperties": [
          { "key": "Song Title", "value": "ccc" },
          { "key": "Artist", "value": "ccc" }
        ],
        "uploads": [
          {
            "url": "https://cdn.shopify.com/...",
            "filename": "amzcustom-order-....jpg"
          }
        ]
      }
    }
  ]
}
```

## Lỗi thường gặp

Unauthorized:

```json
{ "ok": false, "error": "Unauthorized preview request." }
```

Order không tồn tại:

```json
{ "ok": false, "error": "Order not found." }
```

Thiếu tham số:

```json
{ "ok": false, "error": "Missing customization_id or order_id." }
```

## Test nhanh bằng Postman

URL:

```http
https://your-app-domain/production-preview-data?order_id=%231009
```

Header:

```http
Authorization: Bearer YOUR_CUSTOMIZER_PREVIEW_SECRET
```

