// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
import { Elysia } from 'elysia';
import { uploadBody, attachementIdParams } from './upload.schema';
import * as uploadService from './upload.service';
import { authGuard } from '@plugins/auth';

export const uploadRoutes = new Elysia({ prefix: '/uploads' })
  .use(authGuard)
  // ไม่ต้อง config parser — Elysia เห็น t.Files ใน schema แล้วสลับเป็น multipart ให้เอง
  .post('/', ({ body, currentUser }) => uploadService.saveFiles(body.files, body.entityKind, currentUser.id), {
    body: uploadBody,
  })
  .delete('/:id', ({ params, currentUser }) => uploadService.softDelete(params.id, currentUser.id), {
    params: attachementIdParams,
  });

/**
 * เสิร์ฟไฟล์ — **เปิดสาธารณะ ไม่อยู่หลัง authGuard**
 *
 * แยกออกมาเพราะหน้าปลายทางของ QR (/assets/:assetNumber) เปิดให้คนที่ยังไม่ล็อกอินดูได้
 * ถ้าไฟล์ยังอยู่หลัง guard รูปสินทรัพย์จะโหลดไม่ขึ้นสำหรับคนที่สแกนสติกเกอร์ ซึ่งเป็น
 * คนกลุ่มหลักที่หน้านั้นมีไว้ให้
 *
 * ★ ที่ยังอยู่หลัง guard: อัปโหลด (POST) และลบ (DELETE) — การ "อ่านไฟล์ที่รู้ id" กับ
 *   "เพิ่ม/ลบไฟล์" เป็นคนละระดับความเสี่ยงกันคนละเรื่อง อย่าเผลอยกทั้ง module ออกมา
 *
 * ⚠️ id เป็น UUID เดาไม่ได้ก็จริง แต่นั่นคือ "ความลับของ URL" ไม่ใช่การควบคุมสิทธิ์ —
 *    ใครที่ได้ id ไป (จากหน้าสาธารณะ/แชร์ลิงก์/ประวัติเบราว์เซอร์) เปิดไฟล์ได้ตลอดไป
 *    รับได้เพราะไฟล์ในระบบนี้คือรูปสินทรัพย์กับใบกำกับที่แนบมากับของ ไม่ใช่เอกสารบุคคล
 *    ถ้าวันหลังมีการแนบไฟล์ประเภทอื่น ต้องกลับมาคิดใหม่ตรงนี้
 */
export const uploadPublicRoutes = new Elysia({ prefix: '/uploads' }).get(
  '/:id/file',
  async ({ params, set }) => {
    const file = await uploadService.getFileOrFail(params.id);
    // inline = browser เปิดรูป/pdf ดูเลย, filename* รองรับชื่อไฟล์ภาษาไทย
    set.headers['content-disposition'] =
      `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`;

    // ไฟล์ตัวนี้ไม่มีวันเปลี่ยนเนื้อหา — storedName เป็น UUID และห้ามเขียนทับไฟล์เดิม
    // (เปลี่ยนรูป = อัปไฟล์ใหม่แล้วสลับ imageId ดูคอมเมนต์ที่ uq_asset_image)
    // จึง cache ได้ยาวสุด: ตารางที่โหลดรูปย่อซ้ำทุกครั้งที่เปิดหน้าจะไม่ยิงมาถึง server อีก
    //
    // ยังเป็น private ทั้งที่เส้นนี้เปิดสาธารณะแล้ว — cache ที่เบราว์เซอร์ของผู้ใช้คือ
    // ประโยชน์เกือบทั้งหมดอยู่แล้ว ไม่มีเหตุต้องให้ proxy กลางทางเก็บรูปของบริษัทไว้แจกต่อ
    set.headers['cache-control'] = 'private, max-age=31536000, immutable';
    // Bun stream ให้เอง ไฟล์ใหญ่ก็ไม่กิน RAM
    return Bun.file(file.path);
  },
  { params: attachementIdParams },
);
