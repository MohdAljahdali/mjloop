# mjloop

> Chu kỳ phát triển có xác minh dành cho Claude Code.

[![Plugin Claude Code](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · **Tiếng Việt**

**Buộc các tác nhân lập trình chứng minh rằng chúng đã hoàn thành.**

`mjloop` là plugin Claude Code biến công việc của tác nhân thành các chu kỳ có giới hạn
và có bằng chứng. Một tác nhân dẫn dắt chọn đúng tác nhân cho nhiệm vụ, chạy chúng trong
ngữ cảnh cô lập và chỉ chấp nhận thành công sau khi bộ máy ghi lại kết quả các lệnh xác
minh của chính dự án.

`yêu cầu → luồng → tác nhân cô lập → bộ máy xác minh → kết quả có bằng chứng`

> [!IMPORTANT]
> `mjloop` hiện hỗ trợ Claude Code. Bộ điều hợp cho các tác nhân lập trình khác chưa nằm
> trong plugin đã phát hành.

## Vì sao chọn mjloop?

- **Bằng chứng thay vì sự tự tin** — tuyên bố thành công không thể ghi đè biên nhận thất bại hoặc bị thiếu.
- **Trạng thái tác nhân không thể viết lại** — máy chủ MCP sở hữu trạng thái chạy và các manifest dẫn xuất.
- **Quyền tự chủ có giới hạn** — giới hạn chu kỳ cùng bộ chặn đình trệ và lỗi lặp sẽ dừng công việc không tiến triển.
- **Luồng phù hợp từng việc** — chỉnh sửa ngắn, xây dựng nhiều chu kỳ, sửa lỗi sau khi tái hiện hoặc lập kế hoạch được duyệt.

## Bắt đầu nhanh

Bạn cần Claude Code, Node.js 20 trở lên và Git.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

Sau đó mở Claude Code trong một dự án và chạy:

```text
/mjloop:init
/mjloop:edit thêm xác minh đầu vào cho biểu mẫu đăng ký
```

> [!NOTE]
> Bản sao mới phải được build một lần vì máy chủ MCP và hook CLI chạy từ `engine/dist/`.
> Xem [hướng dẫn cài đặt đầy đủ](docs/install.md).

## Chọn đúng luồng

| Lệnh | Phù hợp nhất | Quy tắc tích hợp |
|---|---|---|
| `/mjloop:edit <yêu cầu>` | Thay đổi nhỏ, tập trung | Một chu kỳ; chuyển cấp nếu phạm vi tăng |
| `/mjloop:build <mục tiêu>` | Tính năng và phần triển khai lớn | Lặp chu kỳ xác minh đến khi xong hoặc bị dừng |
| `/mjloop:fix <vấn đề>` | Lỗi và hồi quy | Tái hiện lỗi trước khi chấp nhận bản sửa |
| `/mjloop:plan <ý tưởng>` | Biến ý tưởng thành story có thể xây dựng | Kiểm tra độ phù hợp và phê duyệt trước khi tạo story |

Dùng `/mjloop:status` để xem lần chạy, `/mjloop:resume` để tiếp tục, `/mjloop:stop` để dừng
và `/mjloop:web` để mở cockpit trong trình duyệt.

## Điều gì xảy ra trong một chu kỳ?

1. Tác nhân dẫn dắt lập đội từ luồng đã chọn và ghi lý do đưa vào hoặc bỏ qua từng chuyên gia.
2. Các tác nhân bị ràng buộc bằng hợp đồng làm việc trong ngữ cảnh cô lập với trách nhiệm rõ ràng.
3. Bộ máy chạy các lệnh đã ghim lúc bắt đầu và lưu toàn bộ log bên ngoài phần tường thuật của tác nhân.
4. Xác minh thất bại trở thành đầu vào chu kỳ sau; biên nhận đạt có thể kết thúc lần chạy.
5. Bộ bảo vệ dừng chu kỳ chạm giới hạn, đình trệ hoặc lặp cùng một lỗi.

## Không chỉ là thực thi

- **Khám phá tính năng** — kỹ năng `mjloop-feature-discovery` hỏi từng quyết định và dừng
  tại bản tóm tắt để con người phê duyệt.
- **Định tuyến theo dự án** — bản đồ thành phần và kỹ năng đã chấp nhận hướng dẫn vai trò
  cố định mà không thay đổi lần chạy đang diễn ra.
- **Cockpit trình duyệt** — xem lần chạy, kế hoạch, story, bằng chứng, cấu hình và bộ nhớ qua `/mjloop:web`.
- **Luồng mở rộng được** — thêm tác nhân, kỹ năng hoặc luồng bằng `/mjloop:add`.

> [!TIP]
> Hãy bắt đầu bằng `/mjloop:edit` cho một thay đổi thật và có giới hạn. Đây là cách nhanh
> nhất để thấy hợp đồng xác minh mà không tốn chi phí chạy nhiều chu kỳ.

## Đọc tiếp

- [Vì sao mjloop tồn tại](docs/about.md)
- [Cài đặt và khắc phục sự cố](docs/install.md)
- [Lệnh, cấu hình và quy trình](docs/usage.md)
- [Tài liệu tiếng Ả Rập](docs/about.ar.md)

Nếu `mjloop` giải quyết vấn đề bạn từng gặp, hãy cân nhắc gắn sao cho kho mã để các nhà
phát triển khác có thể tìm thấy nó.
