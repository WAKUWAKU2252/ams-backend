// ตัวช่วยแปลงค่าจาก SAP (mssql คืน Date object) ให้ตรงชนิดที่คอลัมน์ฝั่ง pg รับ
// แยกไฟล์เพราะทั้งสอง connector ใช้เหมือนกัน และเป็นจุดที่พลาดแล้วเวลาเพี้ยนแบบเงียบ ๆ
//
// ── กติกาข้อเดียวของทั้งระบบ: timestamp ทุกตัวที่เก็บ/เทียบ คือ "wall clock แปะ Z"
// SAP เห็น 2026-08-05 10:00 → เราเก็บ '2026-08-05T10:00:00.000Z' ไม่ใช่เวลา UTC จริง
// ของ instant นั้น (03:00Z) — กติกาเดียวกับที่ isoTimestamp ใช้ฝั่ง pg (ดู _shared.ts)
//
// จำเป็นเพราะ SAP B1 เก็บ datetime แบบไม่มี timezone และ driver ตั้ง useUTC:false
// (ดู sap/client.ts) → Date ที่ได้คือ "local components" ถ้าเรียก toISOString() ตรง ๆ
// ค่าจะเลื่อนตาม offset ของเครื่อง: บน UTC+7 นาฬิกาถอย 7 ชม. ทำให้ DocDate ที่ SAP
// เก็บเป็นเที่ยงคืนกลายเป็น "เมื่อวาน" ทุกใบ และ watermark ที่โชว์บนหน้าจอช้าไป 7 ชม.
//
// การแปลงกลับอยู่ที่ asDateTime (sap/client.ts) — สองตัวนี้ต้องแก้คู่กันเสมอ

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/**
 * timestamp — อ่าน "หน้าปัดนาฬิกา" ของค่าที่ SAP ส่งมาแล้วแปะ Z ต่อท้าย
 *
 * ห้ามใช้ d.toISOString(): ค่าที่ได้จาก driver เป็น local components การแปลงเป็น
 * instant จริงจะย้ายวัน/เวลาไปตาม timezone ของเครื่องที่รัน แล้วเพี้ยนแบบเงียบ ๆ
 */
export function toIso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}Z`
  );
}

/** date — คอลัมน์ชนิด date ของ drizzle รับ 'YYYY-MM-DD' ไม่ใช่ ISO เต็ม */
export function toDateOnly(v: unknown): string | null {
  const iso = toIso(v);
  return iso ? iso.slice(0, 10) : null;
}

/**
 * "ตอนนี้" ในกติกาเดียวกัน — ใช้แทน new Date().toISOString() ทุกที่ที่ค่าจะถูกเก็บลง
 * คอลัมน์ timestamp หรือเอาไปเทียบกับค่าที่มาจาก SAP (ขอบบนของหน้าต่าง backfill,
 * lastRunAt, finishedAt) ถ้าใช้ toISOString() ปนเข้ามาจะเทียบข้ามกติกากันเอง
 */
export const nowIso = (): string => toIso(new Date())!;

/** ตัวเลขจาก SAP อาจมาเป็น string (numeric ขนาดใหญ่) — บังคับเป็น number ให้ชัด */
export function toNum(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** char/nvarchar ของ SAP มักมีช่องว่างต่อท้าย — ตัดทิ้งก่อนเก็บ ไม่งั้น key ไม่ match */
export function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** ค่าสูงสุดของ UpdateDate ในชุดผลลัพธ์ — ใช้เลื่อน watermark */
export function maxIso(values: (string | null)[]): string | null {
  let max: string | null = null;
  for (const v of values) if (v && (max === null || v > max)) max = v;
  return max;
}

/**
 * ซอยเป็นก้อนย่อยก่อนยิง SQL — จำเป็นไม่ใช่ทางเลือก
 *
 * pg รับ bind parameter ได้สูงสุด 65535 ตัวต่อคำสั่ง หนึ่งแถวของ purchase_order_item
 * กิน 6 ตัว → เกิน ~10,900 แถวเมื่อไหร่คำสั่งเดียวจะพังทั้งก้อน หน้าต่าง backfill
 * หนึ่งเดือนปกติไม่ถึง แต่เดือนที่จัดซื้อยิงรัวหรือ SAP_BACKFILL_WINDOW_DAYS ที่ตั้งกว้าง
 * ทำให้ถึงได้ และมันจะพังตอนเจอข้อมูลจริงเท่านั้น (ตอน dev ไม่มีทางเห็น)
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * สรุป error ให้อ่านรู้เรื่องและปลอดภัยพอจะเก็บลง log
 *
 * สองปัญหาที่ต้องแก้พร้อมกัน:
 *  1) drizzle ห่อ error ของ pg ไว้ แล้วตั้ง message เป็น "Failed query: <SQL ทั้งก้อน>"
 *     สาเหตุจริง (เช่น ชนกฎ constraint ไหน) ไปอยู่ใน .cause — เก็บแค่ message
 *     จึงได้ SQL ยาวเป็นหน้า ๆ แต่ไม่รู้ว่าพังเพราะอะไร
 *  2) ท่อน "params: ..." ของ drizzle คือ "ข้อมูลจัดซื้อของบริษัททุกแถว" ที่กำลังเขียน
 *     ปล่อยให้ไหลลง sap_*_sync_event และ response ของ API = สำเนาข้อมูลหลุดไปอยู่
 *     ในที่ที่ไม่มีใครดูแล ทั้งที่ทั้งระบบตั้งใจ log แค่จำนวนแถว
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e).slice(0, 500);

  // ไล่ลง cause ให้ถึงต้นตอ (drizzle -> pg) แล้วเก็บข้อความที่มีความหมายที่สุด
  const messages: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur instanceof Error && depth < 5; depth++) {
    // split คืน array ที่มีสมาชิกอย่างน้อยหนึ่งตัวเสมอ แต่ noUncheckedIndexedAccess
    // ไม่รู้เรื่องนั้น — ใช้ ?? '' แทน [0]! เพราะได้ผลเท่ากันโดยไม่ต้องโกหก compiler
    const m = (cur.message.split('\nparams:')[0] ?? '').trim();
    // ตัด SQL ทิ้ง เก็บไว้แค่ให้รู้ว่าพังตอน query — ตัว constraint ที่ชนอยู่ใน cause ชั้นถัดไป
    messages.push(m.startsWith('Failed query:') ? 'Failed query' : m);
    cur = (cur as { cause?: unknown }).cause;
  }

  // pg ใส่รายละเอียดที่ใช้ diagnose ได้จริงไว้คนละช่องกับ message
  const pg = e as { cause?: { detail?: string; constraint?: string; table?: string; column?: string; code?: string } };
  const root = pg.cause ?? {};
  const extra = [
    root.code && `code=${root.code}`,
    root.constraint && `constraint=${root.constraint}`,
    root.table && `table=${root.table}`,
    root.column && `column=${root.column}`,
    root.detail,
  ]
    .filter(Boolean)
    .join(' | ');

  return [...new Set(messages)].join(' <- ').concat(extra ? ` | ${extra}` : '').slice(0, 1000);
}
