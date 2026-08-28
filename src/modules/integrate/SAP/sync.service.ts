// ชั้นที่ตัดสินใจว่า "รันอะไร ของบริษัทไหน ตามลำดับไหน" — engine รู้แค่วิธีรันทีละ entity
//
// ── หลายบริษัท (0021) ──────────────────────────────────────────────────────
// เดิม connector เป็น object ก้อนเดียวต่อ entity เพราะมีบริษัทเดียว ตอนนี้เป็น factory
// ที่ต้องผูกกับบริษัทก่อนใช้ ชั้นนี้จึงเปลี่ยนจาก "map คงที่" เป็น "สร้างตามรายชื่อใน DB"
//
// รายชื่อบริษัทอ่านจากตาราง company ทุกครั้งที่เรียก ไม่ cache: เพิ่มบริษัทควรมีผลทันที
// โดยไม่ต้อง restart และค่าใช้จ่ายคือ SELECT เล็ก ๆ ครั้งเดียวต่อการกดปุ่ม
import { eq, isNotNull, and, asc } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { company, sapPurchaseOrderSync, sapGrpoSync, sapAssetSync } from '@intrastucture/db/schema';
import { BadRequestError } from '@common/errors';
import { bindSync, type SyncTrigger, type SyncOutcome } from './sync.engine';
import { describeError } from './sync.util';
import { makePoConnector } from './connectors/po.connector';
import { makeGrpoConnector } from './connectors/grpo.connector';
import { makeAssetConnector } from './connectors/asset.connector';

/** entity ที่ sync ได้ — ชื่อยังเป็นชุดเดิม ไม่มีบริษัทติดมา (บริษัทเป็นคนละแกน) */
export const SYNC_ENTITIES = ['purchase_order', 'grpo', 'asset'] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export const isSyncEntity = (v: string): v is SyncEntity =>
  (SYNC_ENTITIES as readonly string[]).includes(v);

type SapCompany = { code: string; itemGroups: string | null };

/**
 * บริษัทที่มีฐาน SAP ให้ sync — เรียงตามรหัสให้ลำดับคงที่ทุกรอบ
 *
 * บริษัทที่ sapDbName เป็น NULL (5 จาก 7 ในเครือ) ไม่มี SAP ให้ดึง จึงไม่โผล่ที่นี่เลย
 * และบริษัทที่ isActive = false ถูกตัดออกด้วย — เป็นสวิตช์ปิด sync รายบริษัทโดยไม่ต้องลบแถว
 */
async function sapCompanyList(): Promise<SapCompany[]> {
  return db
    .select({ code: company.code, itemGroups: company.itemGroups })
    .from(company)
    .where(and(isNotNull(company.sapDbName), eq(company.isActive, true)))
    .orderBy(asc(company.code));
}

/** bindSync ซ่อนชนิดของก้อนข้อมูลไว้ข้างใน — ดูเหตุผลที่ sync.engine.ts */
function bind(entity: SyncEntity, c: SapCompany) {
  switch (entity) {
    case 'purchase_order':
      return bindSync(makePoConnector(c.code, c.itemGroups));
    case 'grpo':
      return bindSync(makeGrpoConnector(c.code, c.itemGroups));
    case 'asset':
      return bindSync(makeAssetConnector(c.code, c.itemGroups));
  }
}

async function requireCompany(companyCode: string): Promise<SapCompany> {
  const found = (await sapCompanyList()).find((c) => c.code === companyCode);
  // ไม่มี = พิมพ์รหัสผิด หรือบริษัทนั้นไม่มี SAP / ถูกปิดไว้
  // BadRequest ไม่ใช่ 500 — เป็นคำสั่งที่ผู้ใช้ส่งมาผิด ไม่ใช่ระบบพัง
  if (!found) throw new BadRequestError(`บริษัท '${companyCode}' ไม่มีฐาน SAP ที่เปิด sync อยู่`);
  return found;
}

/** รัน entity เดียวของบริษัทเดียว */
export async function syncOne(
  entity: string,
  companyCode: string,
  trigger: SyncTrigger,
  userId: number | null = null,
) {
  if (!isSyncEntity(entity)) throw new BadRequestError(`ไม่รู้จัก entity '${entity}'`);
  const c = await requireCompany(companyCode);
  return bind(entity, c)(trigger, userId);
}

/**
 * รันครบทั้งชุดของบริษัทหนึ่ง ตามลำดับ dependency — PO ต้องมาก่อน GRPO เสมอเพราะ
 * grpo_line ต้องหา purchase_order_item ที่ sync แล้วเพื่อ resolve poItemId
 *
 * asset (สินทรัพย์เก่าจาก SAP) ไม่มี dependency กับสองตัวบนเลย — เขียนลงตาราง asset
 * ตรง ๆ โดยไม่แตะ PO/GRPO วางไว้ท้ายสุดเพราะเป็นของที่ "มีอยู่ก่อนแล้ว" ไม่ใช่ของที่
 * กำลังไหลเข้ามา ลำดับจึงเป็นเรื่องการอ่านผลลัพธ์ ไม่ใช่ความถูกต้อง
 *
 * GRPO พังไม่ทำให้ผลของ PO ที่สำเร็จไปแล้วเสียไป (คนละทรานแซกชัน คนละ watermark)
 * จึงรวม error ไว้ในผลลัพธ์แทนที่จะโยนทิ้งทั้งชุด
 */
export async function syncAllForCompany(
  companyCode: string,
  trigger: SyncTrigger,
  userId: number | null = null,
) {
  const c = await requireCompany(companyCode);
  const results: Record<string, SyncOutcome | { status: 'FAILED'; error: string }> = {};
  for (const entity of SYNC_ENTITIES) {
    try {
      results[entity] = await bind(entity, c)(trigger, userId);
    } catch (e) {
      // describeError ตัด SQL/พารามิเตอร์ที่ drizzle แนบมาทิ้ง แล้วดึงสาเหตุจริงจาก cause
      // (ถ้าส่ง e.message ดิบ ๆ ออก API ข้อมูลจัดซื้อทุกแถวที่กำลังเขียนจะติดไปด้วย)
      results[entity] = { status: 'FAILED', error: describeError(e) };
    }
  }
  return results;
}

/**
 * รันครบทุก entity ของทุกบริษัท — ไล่ทีละบริษัทจนจบ ไม่ทำขนาน
 *
 * ขนานได้ในทางเทคนิค (คนละ pool คนละ lock key) แต่จงใจไม่ทำ: สอง sync พร้อมกันแปลว่า
 * เปิดทรานแซกชันบน ams_db พร้อมกันสองชุด ซึ่งสวนทางกับทั้งไฟล์ sync.engine.ts ที่ออกแบบ
 * ให้ทรานแซกชันสั้นที่สุดเพื่อไม่ให้คนใช้งานโดนบล็อก
 *
 * บริษัทหนึ่งพังไม่หยุดบริษัทถัดไป — ผลแยกกันคนละ key
 */
export async function syncAll(trigger: SyncTrigger, userId: number | null = null) {
  const out: Record<string, Awaited<ReturnType<typeof syncAllForCompany>>> = {};
  for (const c of await sapCompanyList()) {
    out[c.code] = await syncAllForCompany(c.code, trigger, userId);
  }
  return out;
}

/**
 * สถานะปัจจุบันของทุก entity ทุกบริษัท — ไว้ให้หน้าจอโชว์ว่า sync ล่าสุดเมื่อไหร่ ค้างที่ไหน
 *
 * คืนเป็น { [companyCode]: { purchase_order, grpo, asset } } เพื่อให้หน้าจอแยกการ์ด
 * ต่อบริษัทได้ตรง ๆ โดยไม่ต้องมาจัดกลุ่มเอง
 */
export async function getStatus() {
  const companies = await sapCompanyList();
  const [po, grpo, asset] = await Promise.all([
    db.select().from(sapPurchaseOrderSync),
    db.select().from(sapGrpoSync),
    db.select().from(sapAssetSync),
  ]);

  const out: Record<string, Record<string, unknown>> = {};
  for (const c of companies) {
    // ยังไม่เคยรัน = ยังไม่มีแถว (connector สร้างให้ตอนรันครั้งแรก) — ไม่ใช่ error
    out[c.code] = {
      purchase_order: po.find((r) => r.companyCode === c.code) ?? null,
      grpo: grpo.find((r) => r.companyCode === c.code) ?? null,
      asset: asset.find((r) => r.companyCode === c.code) ?? null,
    };
  }
  return out;
}
