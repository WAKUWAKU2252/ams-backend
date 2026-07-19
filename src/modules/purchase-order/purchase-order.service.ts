import { and, count, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { purchaseOrder, purchaseOrderItem, grpoLine, asset } from '../../db/schema';
import { NotFoundError } from '../../common/errors';
import { paginate } from '../../common/pagination';

// with นี้ inline ในแต่ละ query (ไม่แยกเป็น const) เพราะ Drizzle infer type ของ callback
// ได้เฉพาะตอนส่งตรงเข้า query — nested orderBy ล็อกลำดับให้ deterministic:
// items เรียงตาม poLine, grpoLines ตามลำดับรอบรับของ (ไม่ระบุ = ลำดับตาม query planner ไม่แน่นอน)

/**
 * "รับครบหรือยัง" — คำนวณสดทุกครั้ง ไม่เก็บเป็นคอลัมน์
 *   none    ยังไม่มีการรับของเลย
 *   partial รับมาบ้างแล้วแต่ยังไม่ครบทุก line
 *   full    ทุก line รับครบตามจำนวนที่สั่ง
 * ครบทั้งใบต้องครบ "ทุก line" — ดูผลรวมอย่างเดียวไม่พอ เพราะ line หนึ่งรับเกิน
 * อีก line ขาด แล้วผลรวมบังเอิญเท่ากันได้ (เคสรับผิด line ซึ่งเกิดจริง)
 */
export type ReceivedStatus = 'none' | 'partial' | 'full';

function toReceivedStatus(lines: { ordered: number; received: number }[]): ReceivedStatus {
  if (lines.length === 0) return 'none';
  if (lines.every((l) => l.received === 0)) return 'none';
  return lines.every((l) => l.received >= l.ordered) ? 'full' : 'partial';
}

/**
 * "ลงทะเบียนสินทรัพย์ไปแล้วแค่ไหน" — คนละคำถามกับ receivedStatus
 *   Warehouse ถาม "ของมาครบไหม"     -> receivedStatus
 *   คนทำทะเบียนถาม "ลงไปแล้วแค่ไหน"  -> registrationStatus
 *
 * นับทุกบรรทัด — ระบบไม่ตัดสินเองว่าอะไรควรขึ้นทะเบียน บัญชีเป็นผู้ตรวจตอนอนุมัติ
 * (ค่าเช่า cloud/license ราคาสูงแต่เป็นค่าใช้จ่าย — เกณฑ์อัตโนมัติตัดสินผิดได้)
 */
export type RegistrationStatus = 'none' | 'partial' | 'full';

function toRegistrationStatus(lines: { ordered: number; registered: number }[]): RegistrationStatus {
  if (lines.length === 0) return 'none';
  if (lines.every((l) => l.registered === 0)) return 'none';
  return lines.every((l) => l.registered >= l.ordered) ? 'full' : 'partial';
}

interface LineTotals {
  ordered: number;
  unitPrice: number;
  received: number;
  registered: number;
}

/**
 * ยอดรับ + ยอดที่ลงทะเบียนแล้ว ต่อ line ของ PO ที่ระบุ
 * query เดียวครอบทุกใบ กัน N+1 ตอนทำหน้า list
 *
 * แยกสอง aggregate ไม่ join รวมทีเดียว: join grpo_line แล้ว join asset ต่อ จะทำให้แถวคูณกัน
 * (line มี 2 GRPO x asset 3 ชิ้น = 6 แถว) แล้ว sum(receivedQty) จะบวกซ้ำเป็นเท่าตัว
 */
async function totalsByPo(poNumbers: string[]) {
  const map = new Map<string, LineTotals[]>();
  if (poNumbers.length === 0) return map;

  const [received, registered] = await Promise.all([
    db
      .select({
        poNumber: purchaseOrderItem.poNumber,
        itemId: purchaseOrderItem.id,
        ordered: purchaseOrderItem.quantity,
        unitPrice: purchaseOrderItem.unitPrice,
        // left join แล้ว sum ได้ NULL เมื่อ line นั้นยังไม่เคยมี GRPO — coalesce เป็น 0
        received: sql<number>`coalesce(sum(${grpoLine.receivedQty}), 0)::int`,
      })
      .from(purchaseOrderItem)
      .leftJoin(grpoLine, eq(grpoLine.poItemId, purchaseOrderItem.id))
      .where(inArray(purchaseOrderItem.poNumber, poNumbers))
      .groupBy(purchaseOrderItem.id),
    db
      .select({
        itemId: grpoLine.poItemId,
        registered: count(asset.id),
      })
      .from(grpoLine)
      .innerJoin(asset, and(eq(asset.grpoLineId, grpoLine.id), isNull(asset.deletedAt)))
      .innerJoin(purchaseOrderItem, eq(purchaseOrderItem.id, grpoLine.poItemId))
      .where(inArray(purchaseOrderItem.poNumber, poNumbers))
      .groupBy(grpoLine.poItemId),
  ]);

  const regByItem = new Map(registered.map((r) => [r.itemId, r.registered]));
  for (const r of received) {
    const list = map.get(r.poNumber) ?? [];
    list.push({
      ordered: r.ordered,
      unitPrice: r.unitPrice,
      received: r.received,
      registered: regByItem.get(r.itemId) ?? 0,
    });
    map.set(r.poNumber, list);
  }
  return map;
}

/** จำนวน asset ที่ลงทะเบียนแล้ว แยกตาม po_item — key เป็น itemId ตรง ๆ ไม่พึ่งลำดับแถว */
async function registeredByItem(poNumbers: string[]) {
  if (poNumbers.length === 0) return new Map<string, number>();

  const rows = await db
    .select({ itemId: grpoLine.poItemId, registered: count(asset.id) })
    .from(grpoLine)
    .innerJoin(asset, and(eq(asset.grpoLineId, grpoLine.id), isNull(asset.deletedAt)))
    .innerJoin(purchaseOrderItem, eq(purchaseOrderItem.id, grpoLine.poItemId))
    .where(inArray(purchaseOrderItem.poNumber, poNumbers))
    .groupBy(grpoLine.poItemId);

  return new Map(rows.map((r) => [r.itemId, r.registered]));
}

/** เติม ordered/received/registered ต่อ line ให้ frontend ไม่ต้องบวก grpoLines เอง */
function withLineTotals<
  T extends { id: string; quantity: number; unitPrice: number; grpoLines: { receivedQty: number }[] },
>(item: T, registered: Map<string, number>) {
  const received = item.grpoLines.reduce((sum, l) => sum + l.receivedQty, 0);
  return {
    ...item,
    ordered: item.quantity,
    received,
    registered: registered.get(item.id) ?? 0,
    isFullyReceived: received >= item.quantity,
  };
}

// ดึงพร้อม items + grpoLines เพื่อให้หน้า Create New Asset รู้ว่าแต่ละ line รับของแล้วกี่ชิ้น
export async function findAll() {
  const rows = await db.query.purchaseOrder.findMany({
    with: {
      items: {
        orderBy: (item, { asc }) => [asc(item.poLine)],
        // grpoNo/grpoDate ย้ายขึ้นไปอยู่ตาราง grpo แล้ว ต้องพ่วงมาด้วยเพราะหน้าฟอร์มแสดง
        // เลข GRPO ต่อชิ้น — เรียงตาม grpoId (serial) = เรียงตามลำดับรอบรับของอยู่แล้ว
        with: { grpoLines: { with: { grpo: true }, orderBy: (line, { asc }) => [asc(line.grpoId)] } },
      },
    },
    orderBy: (po, { desc }) => [desc(po.poDate)],
  });

  const registered = await registeredByItem(rows.map((r) => r.poNumber));
  return rows.map((po) => {
    const items = po.items.map((item) => withLineTotals(item, registered));
    return {
      ...po,
      items,
      receivedStatus: toReceivedStatus(items),
      registrationStatus: toRegistrationStatus(items),
    };
  });
}

export async function findOneOrFail(poNumber: string) {
  const po = await db.query.purchaseOrder.findFirst({
    where: (po, { eq }) => eq(po.poNumber, poNumber),
    with: {
      items: {
        orderBy: (item, { asc }) => [asc(item.poLine)],
        with: { grpoLines: { with: { grpo: true }, orderBy: (line, { asc }) => [asc(line.grpoId)] } },
      },
    },
  });
  if (!po) throw new NotFoundError(`Purchase order ${poNumber}`);

  const registered = await registeredByItem([poNumber]);
  const items = po.items.map((item) => withLineTotals(item, registered));
  return {
    ...po,
    items,
    receivedStatus: toReceivedStatus(items),
    registrationStatus: toRegistrationStatus(items),
  };
}

interface FindPageParams {
  page: number;
  limit: number;
  search?: string;
}

// list แบบเบา (ไม่มี items/grpoLines) สำหรับหน้า search/autocomplete — ดึงรายละเอียดเต็มทีหลังผ่าน findOneOrFail
// search แบบ startsWith เท่านั้น (ไม่ใช้ %q%) เพื่อให้ query ใช้ index ได้
export async function findPage({ page, limit, search }: FindPageParams) {
  const where = search
    ? or(ilike(purchaseOrder.poNumber, `${search}%`), ilike(purchaseOrder.vendorName, `${search}%`))
    : undefined;

  const [rows, totalResult] = await Promise.all([
    db.query.purchaseOrder.findMany({
      where,
      orderBy: (po, { desc, asc }) => [desc(po.poDate), asc(po.poNumber)],
      limit,
      offset: (page - 1) * limit,
    }),
    db.select({ value: count() }).from(purchaseOrder).where(where),
  ]);

  // เติมสถานะทั้งสองโดยไม่พ่วง items/grpoLines กลับไป — หน้า list ยังเบาเหมือนเดิม
  const totals = await totalsByPo(rows.map((r) => r.poNumber));
  const data = rows.map((po) => {
    const lines = totals.get(po.poNumber) ?? [];
    return {
      ...po,
      receivedStatus: toReceivedStatus(lines),
      registrationStatus: toRegistrationStatus(lines),
    };
  });

  return paginate(data, totalResult[0].value, page, limit);
}
