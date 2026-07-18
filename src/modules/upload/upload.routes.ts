// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
import { Elysia } from 'elysia';
import { uploadBody, attachementIdParams } from './upload.schema';
import * as uploadService from './upload.service';

export const uploadRoutes = new Elysia({ prefix: '/uploads' })
  // ไม่ต้อง config parser — Elysia เห็น t.Files ใน schema แล้วสลับเป็น multipart ให้เอง
  .post('/', ({ body }) => uploadService.saveFiles(body.files, body.entityKind), {
    body: uploadBody,
  })
  .get(
    '/:id/file',
    async ({ params, set }) => {
      const file = await uploadService.getFileOrFail(params.id);
      // inline = browser เปิดรูป/pdf ดูเลย, filename* รองรับชื่อไฟล์ภาษาไทย
      set.headers['content-disposition'] =
        `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`;
      // Bun stream ให้เอง ไฟล์ใหญ่ก็ไม่กิน RAM
      return Bun.file(file.path);
    },
    { params: attachementIdParams },
  )
  .delete('/:id', ({ params }) => uploadService.softDelete(params.id), {
    params: attachementIdParams,
  });
