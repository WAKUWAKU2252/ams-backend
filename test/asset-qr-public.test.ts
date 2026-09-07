// ═══ ปลายทางของ QR ต้องเปิดได้โดยไม่ต้องล็อกอิน — ทดสอบผ่าน HTTP จริง ═══
//
// ★ ทำไมต้องยิงผ่าน createApp().handle() ไม่ใช่เรียก service ตรง ๆ เหมือนไฟล์อื่น
//
//   asset-by-number.test.ts เรียก assetService.findByAssetNumber() ตรง ๆ ซึ่งทดสอบ
//   "ตรรกะการค้น" ได้ครบ แต่ข้ามชั้นที่บั๊กจริงอยู่ทั้งชั้น: การประกอบ route, ลำดับที่
//   .use() ใน app.ts และการที่ authGuard เป็น plugin ที่ scope กระจายได้ ชั้นนั้น
//   ไม่เคยมีเทสต์เลย — เส้นสาธารณะจึงกลายเป็นเส้นที่ต้องล็อกอินได้โดยไม่มีอะไรฟ้อง
//
//   เทสต์ชุดนี้จึงยิง Request ที่ **ไม่มี Authorization header** เข้าไปตรง ๆ แล้วยืนยัน
//   ว่าไม่ได้ 401 กลับมา ซึ่งเป็นคำถามเดียวที่ตอบจากชั้น service ไม่ได้
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@intrastucture/db';
import { asset } from '@intrastucture/db/schema';
import { createApp } from '../src/app';
import { makeLocation, resetDb, TEST_COMPANY } from './helpers/factory';

const app = createApp();

/** ยิงแบบ "คนที่เพิ่งสแกนสติกเกอร์" — ไม่มี token ไม่มี cookie ไม่มีอะไรเลย */
function anonymous(path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`));
}

let locationId = 0;

beforeEach(async () => {
  await resetDb();
  locationId = await makeLocation();
});

async function makeAsset(assetNumber: string, companyCode = TEST_COMPANY): Promise<void> {
  await db.insert(asset).values({
    origin: 'SAP_LEGACY',
    companyCode,
    assetNumber,
    description: 'ของทดสอบ',
    locationId,
    lifecycle: 'REGISTERED',
    status: 'Active',
  });
}

describe('เส้นที่ QR ต้องเปิดได้โดยไม่ล็อกอิน', () => {
  test('GET /assets/by-number ไม่มี token → ได้ข้อมูล ไม่ใช่ 401', async () => {
    await makeAsset('COM-100-05-002');

    const res = await anonymous('/assets/by-number?number=COM-100-05-002&company=UBA');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ assetNumber: 'COM-100-05-002' });
  });

  test('เลขที่ไม่มีจริง → 404 ไม่ใช่ 401 (สแกนติดแต่ไม่มีในทะเบียน คนละเรื่องกับสิทธิ์)', async () => {
    const res = await anonymous('/assets/by-number?number=COM-999-99-999&company=UBA');
    expect(res.status).toBe(404);
  });

  test('GET /assets/resolve-number ไม่มี token → คืนบริษัทของเลขนั้น', async () => {
    await makeAsset('COM-100-05-002');

    const res = await anonymous('/assets/resolve-number?number=COM-100-05-002');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ companyCode: 'UBA' }]);
  });

  test('GET /master/floor-plans ไม่มี token → ได้ผัง (หน้า QR วาดที่ตั้งจากเส้นนี้)', async () => {
    // ★ ถ้าเส้นนี้กลับไปอยู่หลัง authGuard เมื่อไหร่ หน้า QR จะได้ 401 แล้ว httpClient
    //   ฝั่งจอจะเด้งไป /login = อาการ "สแกนแล้วติด authen" กลับมาทั้งดุ้น
    const res = await anonymous('/master/floor-plans');

    expect(res.status).toBe(200);
    expect(await res.json()).toBeArray();
  });

  test('เส้น master อื่นยังต้องล็อกอิน — /master/departments ต้องได้ 401', async () => {
    // เปิดเฉพาะ floor-plans ใบเดียว ไม่ใช่ทั้ง /master
    const res = await anonymous('/master/departments');
    expect(res.status).toBe(401);
  });

  test('เส้นที่ต้องล็อกอินยังกันอยู่ — /assets/inventory ต้องได้ 401', async () => {
    // ★ ตัวคุมของเทสต์ชุดนี้: ถ้าวันไหน authGuard หลุดทั้งระบบ สามข้อบนจะยังผ่านหมด
    //   ข้อนี้เท่านั้นที่จับได้ว่า "ผ่านเพราะเปิดถูกเส้น" ไม่ใช่ "ผ่านเพราะไม่มีด่านเหลือแล้ว"
    const res = await anonymous('/assets/inventory');
    expect(res.status).toBe(401);
  });
});

describe('resolve-number — กู้ QR รูปแบบเก่าที่ไม่มีรหัสบริษัท', () => {
  test('เลขซ้ำสองบริษัท → คืนครบทั้งคู่ ให้หน้าเว็บถามผู้ใช้', async () => {
    await makeAsset('MAC-212-13-001', 'UBA');
    await makeAsset('MAC-212-13-001', 'UBP');

    const res = await anonymous('/assets/resolve-number?number=MAC-212-13-001');

    expect(res.status).toBe(200);
    // เรียงตามรหัสบริษัท — ลำดับต้องนิ่ง ไม่งั้นปุ่มบนจอสลับที่กันเองระหว่างรีเฟรช
    expect(await res.json()).toEqual([{ companyCode: 'UBA' }, { companyCode: 'UBP' }]);
  });

  test('เลขที่ไม่มีจริง → array ว่าง ไม่ใช่ 404', async () => {
    // หน้าเว็บต้องแยก "ไม่มีในทะเบียน" ออกจาก "ระบบมีปัญหา" ได้ — array ว่างคือคำตอบ
    // ที่ถูกต้องของคำถาม "เลขนี้เป็นของบริษัทไหนบ้าง" ไม่ใช่ความผิดพลาด
    const res = await anonymous('/assets/resolve-number?number=NOPE-001');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('ชิ้นที่ถูกลบแล้วไม่นับ', async () => {
    await makeAsset('DEL-001');
    await db.update(asset).set({ deletedAt: new Date().toISOString() });

    const res = await anonymous('/assets/resolve-number?number=DEL-001');

    expect(await res.json()).toEqual([]);
  });

  test('เลขที่มี / อยู่ข้างใน — ผ่าน query string จึงไม่แตก segment', async () => {
    // เหตุผลที่ by-number/resolve-number รับเลขทาง query ไม่ใช่ path (ดูหัวไฟล์ asset.routes)
    await makeAsset('MAC-212-13-001/1');

    const res = await anonymous(
      `/assets/resolve-number?number=${encodeURIComponent('MAC-212-13-001/1')}`,
    );

    expect(await res.json()).toEqual([{ companyCode: 'UBA' }]);
  });
});
