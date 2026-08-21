// ═══ เทสต์ที่เฝ้าด่านกันยิงออกเน็ต ═══
//
// ไฟล์นี้ไม่ได้ทดสอบฟีเจอร์อะไรเลย มันเฝ้า test/setup.ts เอง
//
// ที่มา: ตอนแยก teams.notify.ts เป็น sendToManager/sendToRequester ตัว mock.module ใน
// setup.ts ยังชี้ชื่อไฟล์เดิมอยู่ — bun ไม่ error อะไรเลยเมื่อ mock ชี้โมดูลที่ไม่มีอยู่
// ผลคือของจริงถูกเรียกแทน แล้วชุดเทสต์ยิงเข้า Power Automate ของบริษัทจริงทุกครั้งที่รัน
// (รอบนั้นรอด เพราะ payload ไม่ผ่าน schema ของ trigger ถ้าผ่านคือหัวหน้าได้การ์ดปลอม)
//
// อาการแบบนั้นไม่มีทางเห็นจากเทสต์ปกติ เพราะ "ส่งสำเร็จ" กับ "stub บอกว่าสำเร็จ" หน้าตา
// เหมือนกันเป๊ะ — ต้องมีเทสต์ที่ถามตรง ๆ ว่าตอนนี้กำลังคุยกับ stub อยู่จริงไหม
import { describe, expect, test } from 'bun:test';
import { sendApprovalRequest } from '@modules/integrate/TEAMS/sendToManager';
import { sendToRequester } from '@modules/integrate/TEAMS/sendToRequester';

describe('ด่านกันเทสต์ยิงออกเน็ต', () => {
  test('fetch ถูกตัดทิ้งทั้ง process — ยิงเมื่อไหร่ระเบิดพร้อมบอกปลายทาง', async () => {
    // ไม่ผูกกับ path ของโมดูลไหน จึงเป็นด่านเดียวที่ไม่พังเงียบเวลาย้ายไฟล์
    expect(fetch('https://example.com/ยิงจริงไม่ได้')).rejects.toThrow(
      /เทสต์พยายามยิงออกเน็ตจริง.*example\.com/s,
    );
  });

  test('flow แจ้งหัวหน้าเป็น stub อยู่จริง ไม่ใช่ของจริงที่ต่อ Power Automate', async () => {
    // ★ ถ้าเทสต์นี้ล้ม อย่าเพิ่งแก้ที่นี่ — ไปดูว่า mock.module ใน setup.ts ยังชี้ path ถูกไหม
    const result = await sendApprovalRequest({} as never);
    expect(result.message).toBe('stub');
  });

  test('flow แจ้งผู้ขอเป็น stub อยู่จริง', async () => {
    const result = await sendToRequester({} as never);
    expect(result.message).toBe('stub');
  });
});
