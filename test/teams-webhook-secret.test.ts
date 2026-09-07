// ═══ POST /teams/webhook — ด่าน shared secret ═══
//
// เส้นนี้เป็นเส้นเดียวในระบบที่ "เปลี่ยนสถานะใบคำขอ" ได้โดยไม่มี JWT และต้องเปิดออก
// อินเทอร์เน็ตให้ Power Automate ยิงเข้ามา — ด่านเดียวที่กันอยู่คือ header
// X-Teams-Webhook-Secret ถ้าด่านนี้หลุด ใครที่รู้ URL ก็อนุมัติใบแทนหัวหน้าได้ด้วย
// curl บรรทัดเดียว เทสต์ชุดนี้จึงเฝ้าตัวด่านโดยตรง ไม่ได้เฝ้าตรรกะการอนุมัติ
//
// ★ แก้ env ด้วยการเขียนทับ property ตรง ๆ ได้ เพราะ route อ่าน env.TEAMS_WEBHOOK_SECRET
//   ตอนถูกเรียก ไม่ใช่ตอน import (ถ้าวันหลังมีคนย้ายไปอ่านตอน import เทสต์ชุดนี้จะพัง
//   ซึ่งถูกแล้ว — การอ่านตอน import แปลว่าเปลี่ยน secret ต้อง redeploy)
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { env } from '@config/env';
import { createApp } from '../src/app';

const app = createApp();
const SECRET = 'test-secret-0123456789';

/** body ที่ถูกต้องตาม schema — ทุกเคสต้องส่งอันนี้ ไม่งั้นจะตกด่าน validate เป็น 422 ก่อน */
const VALID_BODY = {
  requestId: 999999,
  status: 'Approved' as const,
  approvedBy: 1,
  approverName: 'ผู้ทดสอบ',
  comments: '',
};

function post(headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request('http://localhost/teams/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(VALID_BODY),
    }),
  );
}

const original = env.TEAMS_WEBHOOK_SECRET;
beforeEach(() => {
  env.TEAMS_WEBHOOK_SECRET = SECRET;
});
afterAll(() => {
  env.TEAMS_WEBHOOK_SECRET = original;
});

describe('ด่าน X-Teams-Webhook-Secret', () => {
  test('ไม่ส่ง header → 401', async () => {
    expect((await post()).status).toBe(401);
  });

  test('ส่ง header ผิด → 401', async () => {
    expect((await post({ 'x-teams-webhook-secret': 'wrong-but-same-length!!' })).status).toBe(401);
  });

  test('ส่งค่าที่ถูกต้องแต่สั้นกว่า (prefix ตรง) → 401', async () => {
    // กันการเทียบแบบ startsWith/ตัดความยาว ซึ่งจะทำให้เดาทีละตัวได้
    expect((await post({ 'x-teams-webhook-secret': SECRET.slice(0, 10) })).status).toBe(401);
  });

  test('ส่ง header ว่าง → 401 (ไม่ใช่ผ่านเพราะ falsy)', async () => {
    expect((await post({ 'x-teams-webhook-secret': '' })).status).toBe(401);
  });

  test('ส่งถูกต้อง → ผ่านด่าน (ไม่ใช่ 401/503)', async () => {
    // requestId 999999 ไม่มีจริง จึงตกที่ service เป็น 404 — ซึ่งพิสูจน์ว่าผ่านด่านมาแล้ว
    // (เทสต์นี้เฝ้าด่าน ไม่ได้เฝ้าตรรกะการอนุมัติ ซึ่งมีเทสต์ของตัวเองอยู่แล้ว)
    const res = await post({ 'x-teams-webhook-secret': SECRET });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });
});

describe('เส้นที่ถอดออกแล้ว', () => {
  test('POST /teams/request-approval ต้องไม่มีอยู่ (404)', async () => {
    // เส้นนี้เคยให้ frontend สั่งส่งการ์ดเข้า Teams เองโดยไม่มี auth — ใครยิงเข้ามาก็
    // สแปมหัวหน้าได้ไม่จำกัด ถอดออกแล้วเพราะ submitRequest ฝั่ง backend แจ้งให้เองอยู่แล้ว
    // ★ เทสต์นี้กันการเผลอเอากลับมาโดยไม่ใส่ auth
    const res = await app.handle(
      new Request('http://localhost/teams/request-approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );

    expect(res.status).toBe(404);
  });
});

describe('ยังไม่ได้ตั้ง secret = ปิดเส้นทิ้ง ไม่ใช่ปล่อยผ่าน', () => {
  beforeEach(() => {
    env.TEAMS_WEBHOOK_SECRET = '';
  });

  test('env ว่าง + ไม่ส่ง header → 503 ไม่ใช่ 200', async () => {
    // ★ ข้อที่สำคัญที่สุดของไฟล์นี้: ถ้าวันหลังมีคนแก้ให้ env ว่างแล้ว "ข้ามการเช็ค"
    //   ช่องโหว่จะกลับมาแบบเงียบสนิทบน production ที่ลืมตั้ง env
    expect((await post()).status).toBe(503);
  });

  test('env ว่าง + ส่ง header อะไรมาก็ยัง 503', async () => {
    expect((await post({ 'x-teams-webhook-secret': 'anything' })).status).toBe(503);
  });
});
