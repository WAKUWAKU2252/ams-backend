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
import { env } from '@config/env';
import { company, sapPurchaseOrderSync, sapGrpoSync, sapAssetSync, user } from '@intrastucture/db/schema';
import { BadRequestError, ForbiddenError } from '@common/errors';
import { bindSync, type SyncTrigger, type SyncOutcome } from './sync.engine';
import { describeError } from './sync.util';
import { makePoConnector } from './connectors/po.connector';
import { makeGrpoConnector } from './connectors/grpo.connector';
import { makeAssetConnector } from './connectors/asset.connector';

/** entity ที่ sync ได้ — ชื่อยังเป็นชุดเดิม ไม่มีบริษัทติดมา (บริษัทเป็นคนละแกน) */
export const SYNC_ENTITIES = ['purchase_order', 'grpo', 'asset'] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * ชุดที่ปุ่มบนหน้าจอเรียก — เอกสารจัดซื้อเท่านั้น ไม่รวม asset
 *
 * ★ ลำดับสำคัญ ห้ามสลับ: grpo อ้างถึง po line ที่ต้องมีอยู่ก่อน ถ้าดึง grpo ก่อน
 *   บรรทัดที่อ้าง PO ซึ่งยังไม่เข้ามาจะตกไปกอง sap_grpo_unlinked แล้วต้องรอรอบหน้า
 *
 * ★ ไม่รวม asset โดยตั้งใจ: ทะเบียนสินทรัพย์เป็นของที่บัญชีดูแล ไม่ใช่ของที่คนทั่วไป
 *   ควรสั่งดึงได้เอง — และมันหนักที่สุดในสามตัว (3,500+ แถว) ปุ่มที่ทุกคนกดได้ไม่ควรลากมันมา
 *   FINANCE/ADMIN/MANAGER ยังสั่ง asset ได้ทางเส้น /company/:company/:entity เหมือนเดิม
 */
export const SYNC_DOCUMENT_ENTITIES = ['purchase_order', 'grpo'] as const satisfies readonly SyncEntity[];

/**
 * role ที่ข้ามด่านบริษัทได้ — สั่ง sync บริษัทไหนก็ได้
 *
 * คนกลุ่มนี้ดูข้อมูลข้ามบริษัทเป็นงานปกติอยู่แล้ว (บัญชีออกเลขให้ทุกบริษัท / หัวหน้าอนุมัติ
 * ข้ามสาย) ส่วน EMPLOYEE ถูกล็อกไว้ที่บริษัทตัวเองเพราะไม่มีเหตุให้ไปสั่งดึงของบริษัทอื่น
 */
const COMPANY_UNRESTRICTED_ROLES = ['FINANCE', 'ADMIN', 'MANAGER'] as const;

/** คนที่กดปุ่ม — role มาจาก JWT ส่วน id ใช้ไต่ไปหาบริษัทที่สังกัด */
export type SyncActor = { id: number; role: string };

export const isSyncEntity = (v: string): v is SyncEntity =>
  (SYNC_ENTITIES as readonly string[]).includes(v);

type SapCompany = { code: string; itemGroups: string | null };

/**
 * บริษัทที่มีฐาน SAP ให้ sync — เรียงตามรหัสให้ลำดับคงที่ทุกรอบ
 *
 * บริษัทที่ sapDbName เป็น NULL ไม่มี SAP ให้ดึง จึงไม่โผล่ที่นี่เลย
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

/**
 * บริษัทที่ผู้ใช้คนนี้สังกัด — ไต่ user -> employee -> companyCode
 *
 * ★ ทำไมไม่อ่านจาก JWT: token มีแค่ sub กับ role ถ้าจะยัด companyCode ลงไป คนที่ล็อกอิน
 *   ค้างอยู่ตอน deploy จะไม่มีค่านี้จนกว่าจะ login ใหม่ — และถ้าวันหนึ่ง HR ย้ายสังกัดคน
 *   token เก่าจะพาสิทธิ์ของบริษัทเดิมติดตัวไปจนหมดอายุ อ่านสดจาก DB ทุกครั้งแพงกว่า
 *   หนึ่ง SELECT แต่ตอบถูกเสมอ
 *
 * ★ null ได้จริง ไม่ใช่เคสมุม: employee.companyCode เป็น nullable โดยตั้งใจ (schema เขียน
 *   กำกับไว้เองว่ามีพนักงานที่ HR ไม่มีข้อมูลแล้ว) และ user.employeeId ก็ nullable
 *   (service account) — วัด 2026-09-07: มี user 21 คนที่ไต่มาถึงตรงนี้แล้วได้ null
 *   ผู้เรียกต้องปฏิเสธพร้อมบอกสาเหตุ ห้ามเดาบริษัทให้
 */
async function findUserCompany(userId: number): Promise<string | null> {
  const found = await db.query.user.findFirst({
    where: eq(user.id, userId),
    with: { employee: true },
  });
  return found?.employee?.companyCode ?? null;
}

/**
 * ด่านบริษัท — คนทั่วไปสั่งได้เฉพาะบริษัทตัวเอง
 *
 * ★ อยู่ที่ service ไม่ใช่ routes โดยตั้งใจ — หัวไฟล์ sync.routes.ts เขียนกำกับไว้ว่า
 *   "ท่อบาง ๆ ห้ามมี logic ห้าม query DB" และด่านนี้ต้องยิง DB เพื่อหาสังกัดของคนกด
 *
 * ★ แยก 403 กับ 400 ให้ชัด: "ไม่ใช่บริษัทคุณ" คือเรื่องสิทธิ์ ส่วน "บัญชีไม่มีบริษัท"
 *   คือข้อมูลของบัญชีไม่ครบ ซึ่งผู้ใช้แก้เองไม่ได้ ต้องบอกให้ไปหาผู้ดูแล ไม่ใช่ปล่อยให้
 *   เดาว่าตัวเองสิทธิ์ไม่ถึง
 */
async function assertCanSyncCompany(actor: SyncActor, companyCode: string): Promise<void> {
  if ((COMPANY_UNRESTRICTED_ROLES as readonly string[]).includes(actor.role)) return;

  const own = await findUserCompany(actor.id);
  if (!own) {
    throw new ForbiddenError(
      'บัญชีนี้ยังไม่ได้ระบุว่าสังกัดบริษัทไหน จึงสั่ง sync ไม่ได้ — ติดต่อผู้ดูแลระบบ',
    );
  }
  if (own !== companyCode) {
    throw new ForbiddenError(`สั่ง sync ได้เฉพาะบริษัทที่สังกัด (${own}) เท่านั้น`);
  }
}

/**
 * ปุ่มบนหน้าจอเรียกเส้นนี้ — PO + GRPO ของบริษัทเดียว
 *
 * ทำไมเป็นเส้นเดียวไม่ใช่ให้หน้าจอยิงสองครั้ง: ปุ่มมีบรรทัดเดียวว่า "sync ล่าสุดเมื่อไหร่"
 * การยุบผลสองก้อนให้เหลือสถานะเดียว (สำเร็จทั้งคู่ / อันหนึ่งพัง / ถูกข้ามทั้งคู่) เป็นตรรกะ
 * ที่ควรอยู่ที่เดียว และลำดับ po -> grpo เป็นกติกาของข้อมูล ไม่ควรฝากไว้กับหน้าจอ
 *
 * ตัวหนึ่งพังไม่หยุดตัวถัดไป — แพทเทิร์นเดียวกับ syncAllForCompany
 */
export async function syncDocumentsForCompany(
  companyCode: string,
  trigger: SyncTrigger,
  actor: SyncActor,
) {
  await assertCanSyncCompany(actor, companyCode);
  const c = await requireCompany(companyCode);

  const results: Record<string, SyncOutcome | { status: 'FAILED'; error: string }> = {};
  for (const entity of SYNC_DOCUMENT_ENTITIES) {
    try {
      results[entity] = await bind(entity, c)(trigger, actor.id);
    } catch (e) {
      // describeError ตัด SQL/พารามิเตอร์ที่ drizzle แนบมาทิ้ง — ดูเหตุผลที่ syncAllForCompany
      results[entity] = { status: 'FAILED', error: describeError(e) };
    }
  }
  return results;
}

/**
 * ขอบเขตที่ผู้ใช้คนนี้สั่ง sync ได้ — หน้าจอใช้ตัดสินว่าจะวาดปุ่มยังไง
 *
 * มีเส้นนี้เพื่อไม่ให้ฝั่งหน้าจอต้องรู้กติกาเอง (ว่า role ไหนข้ามบริษัทได้บ้าง) แล้วกติกา
 * สองชุดค่อย ๆ เพี้ยนจากกัน — ปุ่มจะจางหรือไม่จาง ตัดสินจากคำตอบของเส้นนี้ที่เดียว
 *
 * ★ ไม่ใช่ด่านความปลอดภัย เป็นแค่ข้อมูลสำหรับวาดจอ — ตัวบังคับจริงคือ assertCanSyncCompany
 *   ที่ทำงานตอนกดอยู่ดี ต่อให้มีคนแก้คำตอบของเส้นนี้ในเครื่องตัวเองก็ยังกดข้ามบริษัทไม่ได้
 */
export async function getScope(actor: SyncActor) {
  const companies = (await sapCompanyList()).map((c) => c.code);
  const unrestricted = (COMPANY_UNRESTRICTED_ROLES as readonly string[]).includes(actor.role);
  const own = unrestricted ? null : await findUserCompany(actor.id);

  return {
    /**
     * cooldown ที่ engine ใช้จริง — ส่งมาให้หน้าจอนับถอยหลังได้ตรงกัน
     *
     * ★ ห้ามให้หน้าจอ hardcode ค่านี้เอง: มันเป็น env ที่แก้ได้โดยไม่ต้อง deploy
     *   วันที่ปรับเป็น 600 แล้วจอยังนับ 300 ปุ่มจะกลับมากดได้ตอนที่ยังกดไม่ได้จริง
     *   แล้วผู้ใช้จะเจอ SKIPPED ทั้งที่นับถอยหลังจนครบแล้ว
     */
    cooldownSeconds: env.SAP_SYNC_COOLDOWN_SECONDS,
    /** true = เลือกบริษัทไหนก็ได้ (FINANCE/ADMIN/MANAGER) */
    unrestricted,
    /** บริษัทที่สังกัด — null เมื่อ unrestricted หรือเมื่อบัญชีไม่มีสังกัด */
    ownCompany: own,
    /** บริษัทที่กดได้จริง — ว่าง = ปุ่มต้องจาง พร้อมอ่าน reason */
    companies: unrestricted ? companies : own && companies.includes(own) ? [own] : [],
    /** เหตุผลที่กดไม่ได้ — null = กดได้ (ข้อความนี้เอาไปโชว์บนจอได้ตรง ๆ) */
    reason: unrestricted
      ? null
      : !own
        ? 'บัญชีนี้ยังไม่ได้ระบุว่าสังกัดบริษัทไหน จึงสั่ง sync ไม่ได้ — ติดต่อผู้ดูแลระบบ'
        : !companies.includes(own)
          ? `บริษัท ${own} ไม่มีฐาน SAP ที่เปิด sync อยู่`
          : null,
  };
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
