// ═══ ด่านความปลอดภัยของชุดเทสต์ ═══
//
// bun โหลด .env ให้อัตโนมัติ และ src/intrastucture/db/index.ts สร้าง pg Pool ทันทีที่ถูก
// import — แปลว่า "แค่ import service" ก็ต่อเข้าฐานข้อมูลจริงบนเซิร์ฟเวอร์แล้ว ไฟล์นี้ถูก
// ตั้งเป็น preload ใน bunfig.toml เพื่อ mock module นั้นทิ้งก่อนไฟล์เทสต์จะได้ทำงาน
// ผลคือทุกคำสั่งของทุกเทสต์ลงที่ PGlite ในหน่วยความจำ ไม่มีทางแตะ ams_db จริง
//
// PGlite = Postgres ตัวจริงคอมไพล์เป็น WASM ไม่ใช่ mock — CHECK / unique partial index /
// FK / transaction ทำงานจริงทั้งหมด ซึ่งจำเป็น เพราะบั๊กที่เทสต์ชุดนี้ตามหาอยู่ในเงื่อนไข
// WHERE และใน constraint ไม่ใช่ในเลขคณิตของ TypeScript
import { mock } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@intrastucture/db/schema';

export const client = new PGlite({ extensions: { uuid_ossp } });
export const testDb = drizzle(client, { schema });

// รัน migration ชุดเดียวกับ production — schema ที่เทสต์เจอจึงเป็นตัวเดียวกับของจริงเป๊ะ
// (ไม่ใช่ push จาก schema.ts ซึ่งจะกลบข้อผิดพลาดที่อยู่ในไฟล์ migration เอง)
await migrate(testDb, { migrationsFolder: 'src/intrastucture/db/migrations' });

mock.module('@intrastucture/db', () => ({
  db: testDb,
  pool: {
    query: async () => ({ rows: [] }),
    connect: async () => {
      throw new Error('เทสต์ไม่ควรจอง connection ดิบ');
    },
    end: async () => {},
  },
  connectDb: async () => {},
}));

// Teams/Power Automate: ห้ามยิงออกเน็ตจริงระหว่างเทสต์ — คืนค่าสำเร็จแบบเงียบ ๆ
// (เทสต์ที่สนใจ "แจ้งล้มแล้วเกิดอะไรขึ้น" จะ mock ทับเองในไฟล์ของตัวเอง)
//
// ⚠️ ต้องมีทุก flow ครบ และชื่อ path ต้องตรงกับที่ service import จริง — mock ที่ชี้ไฟล์
// ที่ไม่มีอยู่แล้วจะไม่ error อะไรเลย แต่ของจริงจะถูกเรียกแทน แล้วชุดเทสต์จะยิงการ์ด/อีเมล
// เข้า Power Automate ของบริษัทจริงทุกครั้งที่รัน (เกิดขึ้นมาแล้วตอนแยกไฟล์ teams.notify)
mock.module('@modules/integrate/TEAMS/sendToManager', () => ({
  sendApprovalRequest: async () => ({ ok: true, status: 200, message: 'stub' }),
}));
mock.module('@modules/integrate/TEAMS/sendToRequester', () => ({
  sendToRequester: async () => ({ ok: true, status: 200, message: 'stub' }),
}));

// ═══ ด่านที่สอง: ตัดเน็ตทิ้งทั้ง process ═══
//
// mock ข้างบนผูกกับ "ชื่อไฟล์" ซึ่งพังเงียบได้: ย้าย/เปลี่ยนชื่อไฟล์เมื่อไหร่ mock จะชี้ไป
// ที่โมดูลที่ไม่มีอยู่ แล้ว bun ไม่บ่นอะไรเลย ของจริงจะถูกเรียกแทนแบบไม่มีใครรู้
// (เกิดขึ้นมาแล้วตอนแยก teams.notify.ts — เทสต์ยิงเข้า Power Automate ของบริษัทจริง)
//
// ตัวนี้ไม่ผูกกับ path อะไรทั้งนั้น: อะไรก็ตามที่พยายามออกเน็ตจะระเบิดพร้อมบอก URL
// ครอบทุก integration ในอนาคตด้วย ไม่ใช่แค่ Teams (SAP/webhook/อัปโหลดขึ้น cloud ฯลฯ)
//
// ถ้าวันหลังมีเทสต์ที่ต้องการ fetch จริง ๆ ให้ mock ทับเป็นราย ๆ ไปในไฟล์นั้น
// ห้ามถอดด่านนี้ออก — มันคือสิ่งเดียวที่กันไม่ให้ "รันเทสต์" กลายเป็น "ส่งของจริงออกไป"
globalThis.fetch = (async (input: unknown) => {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string })?.url ?? String(input));
  throw new Error(
    `เทสต์พยายามยิงออกเน็ตจริงไปที่ ${redact(raw)}\n` +
      `— แปลว่ามี integration ที่ยังไม่ได้ mock (ดู mock.module ข้างบนใน test/setup.ts) ` +
      `ห้ามปล่อยผ่าน: ปลายทางพวกนี้คือระบบจริงของบริษัท`,
  );
  // as unknown as: ตัวจริงมี property ห้อยอยู่ด้วย (fetch.preconnect ของ bun) ซึ่งเราไม่ได้
  // เลียนแบบ — ไม่ต้องเลียนแบบด้วย เพราะฟังก์ชันนี้มีหน้าที่เดียวคือโยน error ทิ้ง
}) as unknown as typeof fetch;

/**
 * ตัด query string ทิ้งก่อนขึ้นจอ — URL ของ Power Automate มี `sig=` ต่อท้ายซึ่งเป็นความลับ
 * เทียบเท่ารหัสผ่าน (ดู config/env.ts) ใครถือไปก็สั่ง flow ยิงอีเมลในนามบริษัทได้
 *
 * log ของเทสต์ไปโผล่ได้ทุกที่ — CI, terminal ที่แชร์จอ, ไฟล์ที่แปะลง issue — ข้อความที่
 * ตั้งใจจะ "ช่วย debug" จึงต้องไม่พาความลับออกไปด้วย เหลือ host+path ก็พอให้รู้ว่าใครยิง
 */
function redact(url: string): string {
  try {
    const u = new URL(url);
    return u.search ? `${u.origin}${u.pathname}?…(ตัดออก)` : `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
