// ═══ upload.routes.ts — ท่อบาง ๆ ═══
// หน้าที่: แกะของจาก request -> เรียก service -> ส่งของกลับ
// กฎเหล็ก: ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB

// STEP 1: imports
//   - Elysia จาก 'elysia'
//   - uploadBody, attachmentIdParams จาก './upload.schema'
//   - * as uploadService จาก './upload.service'

// STEP 2: export const uploadRoutes = new Elysia({ prefix: '/uploads' })
//   (ดูแบบจาก purchase-order.routes.ts — โครงเดียวกันเป๊ะ)

// STEP 3: .post('/', ...) — รับ multipart
//   - handler: ({ body }) => uploadService.saveFiles(body.files, body.entityKind)
//   - options: { body: uploadBody }
//   - ไม่ต้อง config parser — Elysia เห็น t.Files ใน schema แล้วสลับเป็น multipart ให้เอง

// STEP 4: .get('/:id/file', ...) — เสิร์ฟไฟล์จริง
//   - handler เป็น async: เรียก getFileOrFail(params.id) ก่อน
//   - set header content-disposition = `inline; filename*=UTF-8''` + encodeURIComponent(originalName)
//     (inline = browser เปิดรูป/pdf ดูเลย, filename* รองรับชื่อไฟล์ภาษาไทย)
//   - return Bun.file(path) — Bun stream ให้เอง ไฟล์ใหญ่ก็ไม่กิน RAM
//   - options: { params: attachmentIdParams }

// STEP 5: .delete('/:id', ...) — soft delete
//   - handler: ({ params }) => uploadService.softDelete(params.id)
//   - options: { params: attachmentIdParams }
