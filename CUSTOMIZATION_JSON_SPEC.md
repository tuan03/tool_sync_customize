# Tổng Quan Customization Payload

Tài liệu này giải thích vì sao dữ liệu customization được lưu trong Shopify line item properties, vì sao payload phải chia nhỏ, và bên thứ ba cần đọc những field nào để dựng lại preview sản xuất.

## 1. Vì Sao Đưa Payload Vào Line Item

Mỗi customization phải đi kèm đúng sản phẩm trong order. Vì vậy payload được lưu vào line item properties để giữ lại:

- Sản phẩm và variant được mua.
- Option, text, font, color, ảnh upload của customer.
- Preview model gồm layer, tọa độ và transform.

## 2. Vì Sao Không Gửi Trực Tiếp JSON

JSON customization thường dài và có nhiều ký tự đặc biệt như dấu ngoặc kép, xuống dòng, emoji, URL ảnh. Nếu gửi raw JSON vào một property, dữ liệu dễ khó đọc, khó parse hoặc có rủi ro bị cắt.

Vì vậy app encode JSON thành base64 để biến payload thành một chuỗi text ổn định hơn khi đi qua Shopify. Base64 không phải bảo mật, chỉ là cách đóng gói dữ liệu.

## 3. Vì Sao Phải Chia Nhỏ Payload

Base64 payload có thể rất dài, nên app chia thành nhiều field nhỏ:

```text
_customization_payload_1
_customization_payload_2
_customization_payload_3
...
```

Mục đích là giảm nguy cơ vượt giới hạn độ dài của một property và tránh mất dữ liệu. Khi cần khôi phục, app dùng `_customization_payload_count` để ghép lại đúng thứ tự.

Flow tổng quát:

```text
JSON customization
-> encode base64
-> chia thành _customization_payload_1...n
-> lưu vào line item properties
-> ghép lại theo thứ tự
-> decode base64
-> parse thành JSON
-> render preview
```

## 4. Vì Sao Không Lưu Ảnh Preview Trực Tiếp

App không render và upload ảnh preview PNG ngay lúc Add to Cart để tránh làm chậm trải nghiệm mua hàng. Render preview + upload ảnh có thể tốn thời gian, đặc biệt khi customer upload ảnh lớn.

Thay vào đó, app lưu dữ liệu cần thiết để dựng lại preview sau. Khi cần sản xuất, backend hoặc app thứ ba render lại ảnh từ source gốc để đảm bảo chất lượng.

## 5. Cấu Trúc Customization Tổng Quát

Trong order line item, customization data thường gồm 2 nhóm.

### Thông tin để người xử lý đọc

Đây là các field có thể đọc trực tiếp:

```text
Customization: Customized product
Choose Color: Option 2
Song Title: ccc
Artist: ccc
Upload Image: amzcustom-order-....jpg
Production preview: https://...
```

Nhóm này giúp người bán hoặc người sản xuất hiểu customer đã chọn gì.

### Thông tin kỹ thuật cho máy

Đây là các field bắt đầu bằng `_`:

```text
_customization_id
_customization_options
_customization_schema
_customization_payload_encoding
_customization_payload_count
_customization_payload_1
_customization_payload_2
...
```

Nhóm này không dành cho người đọc thủ công. Nó dùng để app/backend khôi phục full customization.

## 6. JSON Sau Khi Decode Sẽ Có Gì

Sau khi ghép và decode `_customization_payload_1...n`, JSON tổng quát sẽ có các phần quan trọng:

```json
{
  "customizationId": "570ce252-c4ba-41d8-87fb-f44a7302f726",
  "schemaVersion": 1,
  "productId": "10308940595495",
  "variantId": "51697989845287",
  "createdAt": "2026-07-28T03:41:04.272Z",
  "previewModel": {
    "width": 509,
    "height": 509,
    "background": "#ffffff",
    "layers": []
  },
  "selections": {
    "options": {},
    "texts": {},
    "fonts": {},
    "colors": {},
    "images": {},
    "imageTransforms": {},
    "textTransforms": {},
    "placementOffsets": {}
  },
  "variantOptions": [
    {
      "name": "CHOOSE PRODUCT SIZE",
      "value": "Small (Mini Size)"
    }
  ]
}
```

## 7. Field Nên Tập Trung

Bên thứ ba nên tập trung vào các field sau.

| Field | Mục đích |
| --- | --- |
| `customizationId` | ID duy nhất của customization. |
| `productId` | Shopify product ID. |
| `variantId` | Shopify variant ID đã mua. |
| `variantOptions` | Tên option và value của variant gốc Shopify. |
| `selections.options` | Option custom customer đã chọn. |
| `selections.texts` | Text customer đã nhập. |
| `selections.fonts` | Font customer đã chọn. |
| `selections.colors` | Màu customer đã chọn. |
| `selections.images` | Ảnh customer upload, gồm filename và URL gốc. |
| `previewModel` | Cấu trúc để render lại preview. |
| `previewModel.layers` | Danh sách layer cần vẽ lên canvas. |

## 8. Field Cần Đọc Để Render Preview

Để render preview, cần đọc chủ yếu:

```text
previewModel.width
previewModel.height
previewModel.background
previewModel.layers
```

Mỗi layer trong `previewModel.layers` có thể là:

### Image layer

```json
{
  "type": "image",
  "src": "https://cdn.shopify.com/.../base.png",
  "rect": { "x": 0, "y": 0, "width": 1, "height": 1 }
}
```

Dùng để vẽ ảnh nền/base design.

### Clipped image layer

```json
{
  "type": "clipped-image",
  "src": "https://cdn.shopify.com/.../customer-upload.png",
  "clipRect": { "x": 0.13, "y": 0.33, "width": 0.72, "height": 0.53 },
  "imageRect": { "x": 0.31, "y": 0.33, "width": 0.37, "height": 0.72 }
}
```

Dùng để vẽ ảnh customer upload vào khu vực bị crop/mask.

### Text layer

```json
{
  "type": "text",
  "text": "122",
  "rect": { "x": 0.44, "y": 0.66, "width": 0.09, "height": 0.07 },
  "color": "rgb(15, 232, 78)",
  "fontFamily": "Acme",
  "fontSizeRatio": 0.066,
  "lineHeightRatio": 0.078,
  "singleLine": true
}
```

Dùng để vẽ text customer đã nhập lên design.

## 9. Cách Tính Tọa Độ

Tọa độ trong payload là tỷ lệ từ `0` đến `1`, không phải pixel trực tiếp.

Công thức:

```text
pixelX = rect.x * previewModel.width
pixelY = rect.y * previewModel.height
pixelW = rect.width * previewModel.width
pixelH = rect.height * previewModel.height
```

Ví dụ canvas rộng `1000px`, `rect.x = 0.25` thì vị trí X là `250px`.

## 10. Flow Dựng Lại Preview

1. Lấy tất cả `_customization_payload_1...n`.
2. Sắp xếp theo số thứ tự.
3. Nối chuỗi lại thành một base64 string.
4. Decode base64 thành JSON string.
5. Parse JSON.
6. Tạo canvas theo `previewModel.width` và `previewModel.height`.
7. Fill background bằng `previewModel.background`.
8. Render từng layer trong `previewModel.layers` theo đúng thứ tự.
9. Dùng URL ảnh gốc trong `layer.src`, không dùng thumbnail.
10. Export canvas thành PNG khi cần sản xuất/in ấn.

## 11. Field Có Thể Bỏ Qua

Bên thứ ba thường không cần xử lý trực tiếp:

```text
_customization_options
_customization_schema
_customization_payload_encoding
_customization_payload_count
raw selection IDs
raw font IDs
raw color IDs
```

Những field này chủ yếu để app nội bộ mapping và khôi phục state.

## 12. Lưu Ý Chất Lượng Ảnh

- Không dùng thumbnail trong cart/order để in.
- Nên dùng URL ảnh gốc từ `selections.images` hoặc `previewModel.layers[].src`.
- Preview sản xuất nên được render lại từ source gốc.
- Nếu cần chất lượng cao hơn preview hiển thị trên web, có thể render canvas ở kích thước lớn hơn dựa trên cùng tỷ lệ tọa độ.
