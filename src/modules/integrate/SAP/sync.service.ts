// ชั้นที่ตัดสินใจว่า "รันอะไร ตามลำดับไหน" — ตัว engine รู้แค่วิธีรันทีละ entity
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { sapPurchaseOrderSync, sapGrpoSync, sapAssetSync } from '@intrastucture/db/schema';
import { BadRequestError } from '@common/errors';
import { bindSync, type SyncTrigger, type SyncOutcome } from './sync.engine';
import { describeError } from './sync.util';
import { poConnector } from './connectors/po.connector';
import { grpoConnector } from './connectors/grpo.connector';
import { assetConnector } from './connectors/asset.connector';

// bindSync ซ่อนชนิดของก้อนข้อมูลไว้ข้างใน — ดูเหตุผลที่ sync.engine.ts
const connectors = {
  purchase_order: bindSync(poConnector),
  grpo: bindSync(grpoConnector),
  asset: bindSync(assetConnector),
} as const;
export type SyncEntity = keyof typeof connectors;

export const isSyncEntity = (v: string): v is SyncEntity => v in connectors;

export async function syncOne(entity: string, trigger: SyncTrigger, userId: number | null = null) {
  if (!isSyncEntity(entity)) throw new BadRequestError(`ไม่รู้จัก entity '${entity}'`);
  return connectors[entity](trigger, userId);
}

/**
 * รันครบทั้งชุดตามลำดับ dependency — PO ต้องมาก่อน GRPO เสมอเพราะ grpo_line
 * ต้องหา purchase_order_item ที่ sync แล้วเพื่อ resolve poItemId
 *
 * asset (สินทรัพย์เก่าจาก SAP) ไม่มี dependency กับสองตัวบนเลย — เขียนลงตาราง asset
 * ตรง ๆ โดยไม่แตะ PO/GRPO วางไว้ท้ายสุดเพราะเป็นของที่ "มีอยู่ก่อนแล้ว" ไม่ใช่ของที่
 * กำลังไหลเข้ามา ลำดับจึงเป็นเรื่องการอ่านผลลัพธ์ ไม่ใช่ความถูกต้อง
 *
 * GRPO พังไม่ทำให้ผลของ PO ที่สำเร็จไปแล้วเสียไป (คนละทรานแซกชัน คนละ watermark)
 * จึงรวม error ไว้ในผลลัพธ์แทนที่จะโยนทิ้งทั้งชุด
 */
export async function syncAll(trigger: SyncTrigger, userId: number | null = null) {
  const results: Record<string, SyncOutcome | { status: 'FAILED'; error: string }> = {};
  for (const entity of ['purchase_order', 'grpo', 'asset'] as const) {
    try {
      results[entity] = await connectors[entity](trigger, userId);
    } catch (e) {
      // describeError ตัด SQL/พารามิเตอร์ที่ drizzle แนบมาทิ้ง แล้วดึงสาเหตุจริงจาก cause
      // (ถ้าส่ง e.message ดิบ ๆ ออก API ข้อมูลจัดซื้อทุกแถวที่กำลังเขียนจะติดไปด้วย)
      results[entity] = { status: 'FAILED', error: describeError(e) };
    }
  }
  return results;
}

/** สถานะปัจจุบันของทุก entity — ไว้ให้หน้าจอโชว์ว่า sync ล่าสุดเมื่อไหร่ ค้างที่ไหน */
export async function getStatus() {
  const [po] = await db.select().from(sapPurchaseOrderSync).where(eq(sapPurchaseOrderSync.id, 1));
  const [grpo] = await db.select().from(sapGrpoSync).where(eq(sapGrpoSync.id, 1));
  const [asset] = await db.select().from(sapAssetSync).where(eq(sapAssetSync.id, 1));
  // ยังไม่เคยรัน = ยังไม่มีแถว (connector สร้างให้ตอนรันครั้งแรก) — ไม่ใช่ error
  return { purchase_order: po ?? null, grpo: grpo ?? null, asset: asset ?? null };
}
