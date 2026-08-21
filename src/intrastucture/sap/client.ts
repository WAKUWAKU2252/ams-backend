// ═══════════════════════════════════════════════════════════════════════════
// ประตูเดียวที่แตะ SAP — ไฟล์อื่นห้าม import mssql ตรง
//
// อ่านอย่างเดียวเสมอ: ไม่มีฟังก์ชัน insert/update/delete ในไฟล์นี้ และ login ที่ใช้
// ต้องมีสิทธิ์แค่ SELECT (กำแพงจริงอยู่ที่สิทธิ์ DB ไม่ใช่ที่โค้ด)
//
// pool แยกจาก ams_db คนละตัว — คนละเครื่อง คนละ driver และ SAP เป็น DB จริงของ
// บริษัทที่ระบบอื่นใช้อยู่ ต้องจำกัดจำนวน connection ไม่ให้ไปเบียดคนอื่น
// ═══════════════════════════════════════════════════════════════════════════
import sql from 'mssql';
import { env } from '@config/env';

const config: sql.config = {
  server: env.SAP_DB_HOST,
  port: env.SAP_DB_PORT,
  database: env.SAP_DB_NAME,
  user: env.SAP_DB_USERNAME,
  password: env.SAP_DB_PASSWORD,
  options: {
    encrypt: env.SAP_DB_ENCRYPT,
    trustServerCertificate: env.SAP_DB_TRUST_CERT,
    // SAP B1 เก็บ datetime แบบไม่มี timezone — ให้ driver ประกอบ Date จาก local
    // components ตามหน้าปัดที่เห็นใน SAP แล้ว toIso/asDateTime แปลงเป็นกติกา
    // "wall clock แปะ Z" ของระบบ (ดู sync/sync.util.ts) ห้ามสลับเป็น true เดี่ยว ๆ:
    // ทั้งสามตัวนี้ต้องเปลี่ยนพร้อมกัน ไม่งั้นเวลาจะเลื่อนไป 1 offset แบบเงียบ ๆ
    useUTC: false,
  },
  pool: {
    // ต่ำกว่าฝั่ง ams_db (10) โดยตั้งใจ — sync ทำงานทีละ entity อยู่แล้ว
    // ไม่มีเหตุให้เปิดค้างไว้เยอะบน DB ที่คนอื่นใช้ร่วม
    max: 3,
    min: 0,
    idleTimeoutMillis: 30_000,
  },
  connectionTimeout: 15_000,
  // หน้าต่าง backfill หนึ่งก้อนอาจกินหลายพันแถว — ให้เวลามากกว่า connect
  requestTimeout: 120_000,
};

// lazy: ไม่ต่อ SAP ตอนแอปสตาร์ท เพราะ SAP ล่มไม่ควรทำให้ AMS สตาร์ทไม่ขึ้น
// (ทั้งระบบออกแบบให้ทำงานต่อได้จาก snapshot เดิมเมื่อ SAP ใช้ไม่ได้)
let poolPromise: Promise<sql.ConnectionPool> | null = null;

function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect().catch((e) => {
      // ปล่อยให้ครั้งหน้าลองใหม่ได้ ไม่งั้น pool ที่ต่อพลาดครั้งเดียวจะค้างตลอดอายุ process
      poolPromise = null;
      throw e;
    });
  }
  return poolPromise;
}

/**
 * แปลง 'YYYY-MM-DDTHH:mm:ss.sssZ' แบบ "wall clock แปะ Z" กลับเป็น Date ที่มี local
 * components ตรงตามหน้าปัด — ขาไปกลับของ toIso (ดู sync/sync.util.ts)
 *
 * ต้องประกอบจากตัวเลขเอง ห้าม new Date(v): ตัว Z จะถูกตีความเป็น UTC จริง แล้ว driver
 * (useUTC:false) จะแปลงกลับเป็น local อีกที ทำให้ค่าที่ส่งไป SAP เลื่อนไป 1 offset
 */
function fromWallClockIso(v: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(v);
  // รูปแบบแปลก ๆ ที่ไม่เข้าแพตเทิร์น — ปล่อยให้ Date เดาเอง ดีกว่าโยนทิ้งกลางรอบ sync
  if (!m) return new Date(v);

  // กลุ่ม 1-6 เป็น capture ที่ไม่ optional ในแพตเทิร์น จึงมีค่าแน่เมื่อ exec ไม่คืน null
  // แต่ TS พิมพ์ผลของ exec เป็น (string | undefined)[] ตายตัว — destructure แล้วเช็ค
  // ครั้งเดียวชัดกว่าใส่ ! หกตัว และถ้าวันหลังมีคนแก้ regex ให้กลุ่มไหน optional
  // โค้ดนี้จะตกไปทาง fallback แทนที่จะได้ Invalid Date เงียบ ๆ
  const [, year, month, day, hour, minute, second, ms] = m;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return new Date(v);
  }

  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    ms ? Number(ms.padEnd(3, '0')) : 0,
  );
}

/**
 * บอก driver ให้ผูกพารามิเตอร์เป็น datetime — จำเป็นเพราะถ้าปล่อยให้เดาเองตอนค่าเป็น null
 * mssql จะผูกเป็น nvarchar แล้ว SQL Server ต้องแปลงชนิดตอนเทียบกับคอลัมน์ datetime
 * (ได้ผลถูกอยู่ แต่พังทันทีถ้า locale ของ server ตีความ string คนละแบบ)
 */
export const asDateTime = (v: string | Date | null) => ({
  __sapType: 'datetime' as const,
  value: v == null ? null : v instanceof Date ? v : fromWallClockIso(v),
});

type SapParam = unknown | ReturnType<typeof asDateTime>;

const isTyped = (v: SapParam): v is ReturnType<typeof asDateTime> =>
  typeof v === 'object' && v !== null && '__sapType' in v;

/**
 * ยิง SELECT ไป SAP — ใช้ named parameter เท่านั้น (กัน SQL injection และให้ driver
 * ส่งชนิดข้อมูลถูกต้อง)
 *
 * READ UNCOMMITTED: ดูเหตุผลที่ env.SAP_READ_UNCOMMITTED — สรุปคือคิวรีเรากวาดตาราง
 * ที่คนทั้งบริษัทใช้อยู่ ไม่ควรจับล็อกค้างไว้จนคนโพสต์เอกสารไม่ได้
 */
export async function sapQuery<T = Record<string, unknown>>(
  query: string,
  params: Record<string, SapParam> = {},
): Promise<T[]> {
  const pool = await getPool();
  const request = pool.request();
  for (const [key, param] of Object.entries(params)) {
    if (isTyped(param)) request.input(key, sql.DateTime, param.value);
    else request.input(key, param ?? null);
  }
  const prefix = env.SAP_READ_UNCOMMITTED ? 'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n' : '';
  const result = await request.query<T>(prefix + query);
  return result.recordset;
}

export async function closeSap(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise.catch(() => null);
  poolPromise = null;
  await pool?.close();
}
