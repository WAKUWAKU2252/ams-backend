// ท่อบาง ๆ: แกะ request -> เรียก service -> ส่งกลับ (ห้าม logic/ประกอบการ์ด/ยิง fetch เอง)
// การประกอบการ์ด+อีเมลและการยิงเข้า Power Automate ย้ายไปอยู่ที่ sendToManager.ts แล้ว
//
// ⚠️ POST /request-approval เหลือไว้เพื่อความเข้ากันได้เท่านั้น — เส้นทางปกติของการแจ้ง
// ขออนุมัติย้ายไปอยู่ใน submitRequest ฝั่ง backend แล้ว (1 call = เปลี่ยนสถานะ + แจ้ง +
// บันทึกผลลง notifiedAt/notifyError) การให้ frontend ยิงเป็นขั้นที่สองทำให้ขาดกลางคันได้
// แล้วใบค้าง PENDING_APPROVAL โดยไม่มีใครรู้และหาไม่เจอ
import { Elysia, t } from 'elysia';
import * as teamsService from './teams.service';
import { sendApprovalRequest } from './sendToManager';

export const teamsRoutes = new Elysia({
  prefix: '/teams',
})

  .post(
    '/request-approval',
    async ({ body, set }) => {
      const result = await sendApprovalRequest({
        ...body,
        requestByEmail: body.requestByEmail?.trim() || null,
        previousRejection: null,
      });
      set.status = result.status;
      return { success: result.ok, message: result.message, error: result.error };
    },
    {
      body: t.Object({
        requestId: t.Number(),
        managerId: t.Number(),
        // ชื่อว่างได้ (employee.firstName/lastName เป็น nullable) — ไม่มีชื่อยังส่งอีเมลได้
        managerName: t.String(),
        // ต่างจากช่องอื่น: minLength 1 เพราะเป็นปลายทางจริงที่ Power Automate ใช้ส่ง
        // ว่างแล้วปล่อยผ่าน = flow ล้มที่ปลายทางโดยฝั่งเราขึ้นว่าส่งสำเร็จ (บั๊กเดิม)
        managerEmail: t.String({ minLength: 1, maxLength: 100 }),
        ownerPrName: t.String(),
        requestBy: t.String(),
        // optional: เส้นทางปกติ (submitRequest) อ่านจาก employee.email ให้เองอยู่แล้ว
        requestByEmail: t.Optional(t.String({ maxLength: 100 })),
        poNumber: t.String(),
        vendorName: t.String(),
        poDate: t.String(),
        grpo: t.Array(
          t.Object({
            grpoNumber: t.String(),
            item: t.Array(
              t.Object({
                poLine: t.String(),
                description: t.String(),
                quantity: t.Number(),
                serialItems: t.Array(
                  t.Object({
                    serialNumber: t.String(),
                    pricePerUnit: t.Number(),
                    // 📍 location ย้ายลงมาระดับชิ้น — ประกอบ "ที่ตั้ง - ตำแหน่งย่อย" มาจาก frontend
                    location: t.String(),
                  })
                ),
              })
            ),
          })
        ),
      }),
    }
  )

  // ⚠️ endpoint นี้ยังไม่มีการยืนยันตัวตน (ตั้งใจเลื่อนไว้ — ดู TODO ข้างล่าง)
  // ต่างจาก route อื่นทั้งระบบที่ผ่าน authGuard เพราะ Power Automate ไม่มี JWT ของเรา
  //
  // TODO ก่อนขึ้น production: ใส่ shared secret (เช่น header X-Teams-Webhook-Secret
  // เทียบกับ env ใหม่) — ตอนนี้ใครรู้ URL ก็เปลี่ยนสถานะใบไหนก็ได้ด้วย curl บรรทัดเดียว
  // และ URL ที่ใช้อยู่เป็น ngrok สาธารณะ
  .post(
    '/webhook',
    async ({ body, set }) => {
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
