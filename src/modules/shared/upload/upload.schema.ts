// ประตูตรวจ request — request ที่ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้ service ไม่ต้องกันเอง
import { t } from 'elysia';

export const uploadBody = t.Object({
  // ต้องตรงกับ pgEnum doc_type ใน db/schema.ts
  entityKind: t.Union([t.Literal('INVOICE'), t.Literal('ASSET_IMG')]),
  // maxSize ตรงนี้เป็นเพดานรวม — เพดานจริงต่อชนิด (5MB รูป) เช็คใน service
  // เพราะ whitelist ขึ้นกับค่า entityKind ซึ่ง TypeBox มองข้าม field ไม่ได้
  files: t.Files({ maxSize: '10m', minItems: 1, maxItem: 10 }),
});

export const attachementIdParams = t.Object({
  id: t.String({ format: 'uuid' }),
});
