// ประตูตรวจ request — request ที่ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้ service ไม่ต้องกันเอง
import { t } from 'elysia';

// grpo.id เป็น serial — t.Numeric() แปลง string ใน path ให้เป็น number ให้แล้ว
export const grpoIdParams = t.Object({
  id: t.Numeric(),
});

export const grpoListQuery = t.Object({
  poNumber: t.Optional(t.String({ maxLength: 50 })),
});

// รับแค่ id ของไฟล์ที่อัปโหลดไว้แล้ว — ไม่รับไฟล์ตรงนี้ (อัปโหลดไปที่ POST /uploads ก่อน)
export const linkInvoiceBody = t.Object({
  attachmentId: t.String({ format: 'uuid' }),
});

// ถอด invoice ต้องระบุใบไหน — 1 รอบแนบได้หลายใบ (attachmentId อยู่ใน path)
export const unlinkInvoiceParams = t.Object({
  id: t.Numeric(),
  attachmentId: t.String({ format: 'uuid' }),
});
