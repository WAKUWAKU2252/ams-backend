// ท่อบาง ๆ: แกะ request -> เรียก service -> ส่งกลับ (ห้าม logic/ประกอบการ์ด/ยิง fetch เอง)
// การประกอบการ์ด+อีเมลและการยิงเข้า Power Automate ย้ายไปอยู่ที่ sendToManager.ts แล้ว
//
// module นี้เหลือเส้นเดียว: webhook รับผลอนุมัติกลับจาก Power Automate
//
// ── เคยมี POST /request-approval ให้ frontend สั่งส่งการ์ดเอง — ถอดออกแล้ว ───────
//
// การแจ้งขออนุมัติย้ายไปอยู่ใน submitRequest ฝั่ง backend (1 call = เปลี่ยนสถานะ + แจ้ง +
// บันทึกผลลง notifiedAt/notifyError) การให้ frontend ยิงเป็นขั้นที่สองทำให้ขาดกลางคันได้:
// ปิดเบราว์เซอร์ระหว่างสองขั้นแล้วใบค้าง PENDING_APPROVAL โดยไม่มีใครได้รับแจ้ง และส่งซ้ำ
// ไม่ได้เพราะสถานะเปลี่ยนไปแล้ว
//
// ★ ถอดทิ้งไม่ใช่แค่เลิกเรียก — เส้นนั้นไม่มี auth ใครยิงเข้ามาก็สั่งส่งการ์ด/อีเมลเข้า
//   Teams ของหัวหน้าได้ไม่จำกัด ตัวฟังก์ชัน sendApprovalRequest() ยังอยู่และถูกเรียกจาก
//   asset-request.service ตามปกติ — ที่หายไปคือทางเข้าจากภายนอกเท่านั้น
import { Elysia, t } from 'elysia';
import { env } from '@config/env';
import { ServiceUnavailableError, UnauthorizedError } from '@common/errors';
import * as teamsService from './teams.service';

/**
 * ยืนยันว่าคำขอมาจาก Power Automate จริง — ตัวเดียวที่กัน POST /teams/webhook อยู่
 *
 * เส้นนั้นเปลี่ยนสถานะใบคำขอได้โดยไม่มี JWT (Power Automate ไม่มี token ของเรา) และต้อง
 * เปิดออกอินเทอร์เน็ตให้ flow ยิงเข้ามาได้ ถ้าไม่มีด่านนี้ ใครที่รู้ URL ก็ยิง curl
 * บรรทัดเดียวอนุมัติใบแทนหัวหน้าได้
 *
 * ★ ไม่ตั้ง secret = 503 ไม่ใช่ปล่อยผ่าน — ลืมตั้งบน production แล้ว fail open คือ
 *   ช่องโหว่ที่เงียบสนิท ส่วน fail closed จะเห็นทันทีว่าการ์ดกดแล้วไม่มีอะไรเกิดขึ้น
 *
 * ★ เทียบแบบ timing-safe: เทียบด้วย === จะคืนเร็ว/ช้าต่างกันตามจำนวนตัวอักษรที่ตรง
 *   ซึ่งเดาทีละตัวได้ในทางทฤษฎี — ค่านี้อยู่หน้าอินเทอร์เน็ต ใช้ของที่ถูกต้องไปเลย
 *   (ความยาวไม่เท่ากัน timingSafeEqual จะโยน จึงต้องเช็คก่อน ซึ่งไม่รั่วอะไรเพิ่ม
 *    เพราะความยาวของ secret ไม่ใช่ความลับ)
 */
function assertWebhookSecret(provided: string | undefined): void {
  const expected = env.TEAMS_WEBHOOK_SECRET;
  if (!expected) {
    throw new ServiceUnavailableError(
      'ยังไม่ได้ตั้ง TEAMS_WEBHOOK_SECRET — เส้นรับผลอนุมัติถูกปิดไว้จนกว่าจะตั้งค่า',
    );
  }

  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new UnauthorizedError('X-Teams-Webhook-Secret ไม่ถูกต้อง');
  }
}

export const teamsRoutes = new Elysia({
  prefix: '/teams',
})

  // ไม่ผ่าน authGuard เหมือน route อื่นทั้งระบบ เพราะ Power Automate ไม่มี JWT ของเรา
  // — ตัวยืนยันตัวตนของเส้นนี้คือ shared secret ใน header X-Teams-Webhook-Secret
  // (ดู assertWebhookSecret ข้างบน) ต้องตั้ง TEAMS_WEBHOOK_SECRET ทั้งฝั่ง .env และในตัว flow
  .post(
    '/webhook',
    async ({ body, set, headers }) => {
      // ★ ต้องเช็คก่อนแตะอะไรทั้งสิ้น รวมถึงก่อน log — ไม่งั้น log จะเต็มไปด้วยของปลอม
      //   ที่คนยิงมั่วส่งมา แล้วแยกไม่ออกว่าอันไหนคือการอนุมัติจริง
      assertWebhookSecret(headers['x-teams-webhook-secret']);

      console.log('\n========================================');
      console.log('📥 ได้รับผลการอนุมัติจาก Teams');
      console.log('========================================');
      console.log(`- ID ใบคำขอ  : ${body.requestId}`);
      console.log(`- สถานะ      : ${body.status}`);
      console.log(`- ผู้อนุมัติ   : ${body.approverName || 'ไม่มีข้อมูล'}`);
      console.log(`- employee.id ผู้อนุมัติ: ${body.approvedBy}`);
      console.log(`- คอมเมนต์   : ${body.comments || 'ไม่มีคอมเมนต์'}`);
      console.log('========================================\n');

      const result = await teamsService.applyDecision({
        requestId: body.requestId,
        approvedBy: body.approvedBy,
        status: body.status,
        comments: body.comments ?? '',
      });

      console.log(
        result.applied
          ? `✅ อัปเดตคำขอ ${result.requestId} เป็น ${result.status}`
          : `↩️ คำขอ ${result.requestId} เป็น ${result.status} อยู่แล้ว (ยิงซ้ำ ไม่ทำอะไร)`,
      );

      set.status = 200;
      return {
        success: true,
        message: result.applied
          ? 'บันทึกผลการอนุมัติเรียบร้อย'
          : 'ผลการอนุมัตินี้ถูกบันทึกไปแล้วก่อนหน้า',
      };
    },
    {
      body: t.Object({
        requestId: t.Numeric(),
        // literal union ไม่ใช่ t.String() — ค่านอกสองตัวนี้ต้องถูกตีกลับ 422 ตั้งแต่ประตู
        // ไม่ใช่หลุดเข้ามาแล้วเงียบ (การ์ดส่ง actionResult มาแค่สองค่านี้)
        status: t.Union([t.Literal('Approved'), t.Literal('Rejected')]),
        // employee.id ของหัวหน้า ที่ flow เด้งกลับมาจาก managerId ที่เราส่งไป
        // นี่คือตัวเดียวที่ระบุตัวตนได้จริง — approverName เป็นแค่ชื่อไว้อ่านใน log
        approvedBy: t.Numeric(),
        approverName: t.Optional(t.String()),
        // ว่างได้ — ปุ่ม Approve ข้ามการตรวจ input (associatedInputs: "none") จึงไม่ส่งค่านี้มา
        // ฝั่ง Rejected การ์ดบังคับกรอกให้แล้ว และ service เช็คซ้ำอีกชั้นก่อนใช้เป็น rejectReason
        comments: t.Optional(t.String()),
      }),
    }
  );
