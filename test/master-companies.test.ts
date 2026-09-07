// ═══ GET /master/companies — รายชื่อบริษัทสำหรับ dropdown ตัวกรอง ═══
//
// เส้นนี้เกิดขึ้นเพราะหน้า Audit ต้องกรองตามบริษัท และ "ให้หน้าจอ derive เอาจากรายชื่อ
// แผนก" เป็นทางที่พังเงียบสองแบบ: ตัวกรองบริษัทหายทั้งตัวเมื่อ /master/departments ล้ม
// (สองอย่างนี้ไม่ได้เกี่ยวกัน) และบริษัทที่ยังไม่มีแผนกจะไม่โผล่ทั้งที่มีสินทรัพย์อยู่
//
// ★ สิ่งที่เทสต์นี้เฝ้าคือ isActive — บริษัทที่ปิดไปแล้วต้องไม่โผล่ให้เลือก ไม่งั้นผู้ใช้
//   จะกรองด้วยตัวเลือกที่ได้ผลว่างเสมอโดยไม่มีอะไรอธิบายว่าทำไม
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { company } from '@intrastucture/db/schema';
import { findCompanies } from '@modules/business/master/master.service';
import { resetDb, TEST_COMPANY } from './helpers/factory';

beforeEach(async () => {
  await resetDb();
});

describe('รายชื่อบริษัท', () => {
  test('คืนบริษัทที่เปิดใช้อยู่ พร้อมรหัสกับชื่อ', async () => {
    const rows = await findCompanies();

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.code)).toContain(TEST_COMPANY);
    // คีย์คือ code ไม่ใช่ id ตัวเลข — ทุกตารางที่อ้างบริษัทถือ companyCode เป็น FK
    for (const r of rows) {
      expect(typeof r.code).toBe('string');
      expect(typeof r.name).toBe('string');
    }
  });

  test('เรียงตามรหัสเสมอ ไม่ปล่อยให้ลำดับสลับเอง', async () => {
    const codes = (await findCompanies()).map((r) => r.code);

    expect(codes).toEqual([...codes].sort());
  });

  // ปิดบริษัทแล้วต้องหายจาก dropdown ทันที — ไม่ใช่ค้างให้เลือกแล้วได้ผลว่าง
  test('บริษัทที่ปิดใช้งานแล้วไม่โผล่ให้เลือก', async () => {
    const before = await findCompanies();
    const target = before[0]!.code;

    await db.update(company).set({ isActive: false }).where(eq(company.code, target));

    const after = await findCompanies();
    expect(after.map((r) => r.code)).not.toContain(target);
    expect(after).toHaveLength(before.length - 1);
  });
});
