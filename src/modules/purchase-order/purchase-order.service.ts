import { count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { purchaseOrder, purchaseOrderItem, grpoLine } from '../../db/schema';
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

/** ยอดรับต่อ line ของ PO ที่ระบุ — query เดียวครอบทุกใบ กัน N+1 ตอนทำหน้า list */
async function receivedByPo(poNumbers: string[]) {
  if (poNumbers.length === 0) return new Map<string, { ordered: number; received: number }[]>();

  const rows = await db
    .select({
      poNumber: purchaseOrderItem.poNumber,
      ordered: purchaseOrderItem.quantity,
      // left join แล้ว sum ได้ NULL เมื่อ line นั้นยังไม่เคยมี GRPO — coalesce เป็น 0
      received: sql<number>`coalesce(sum(${grpoLine.receivedQty}), 0)::int`,
    })
    .from(purchaseOrderItem)
    .leftJoin(grpoLine, eq(grpoLine.poItemId, purchaseOrderItem.id))
    .where(inArray(purchaseOrderItem.poNumber, poNumbers))
    .groupBy(purchaseOrderItem.id, purchaseOrderItem.poNumber, purchaseOrderItem.quantity);

  const map = new Map<string, { ordered: number; received: number }[]>();
  for (const r of rows) {
    const list = map.get(r.poNumber) ?? [];
    list.push({ ordered: r.ordered, received: r.received });
    map.set(r.poNumber, list);
  }
  return map;
}

/** เติม ordered/received ต่อ line ให้ frontend ไม่ต้องบวก grpoLines เอง */
function withLineTotals<T extends { quantity: number; grpoLines: { receivedQty: number }[] }>(
  item: T,
) {
  const received = item.grpoLines.reduce((sum, l) => sum + l.receivedQty, 0);
  return { ...item, ordered: item.quantity, received, isFullyReceived: received >= item.quantity };
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

  return rows.map((po) => {
    const items = po.items.map(withLineTotals);
    return { ...po, items, receivedStatus: toReceivedStatus(items) };
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

  const items = po.items.map(withLineTotals);
  return { ...po, items, receivedStatus: toReceivedStatus(items) };
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

  // เติมสถานะการรับของโดยไม่พ่วง items/grpoLines กลับไป — หน้า list ยังเบาเหมือนเดิม
  const received = await receivedByPo(rows.map((r) => r.poNumber));
  const data = rows.map((po) => ({
    ...po,
    receivedStatus: toReceivedStatus(received.get(po.poNumber) ?? []),
  }));

  return paginate(data, totalResult[0].value, page, limit);
}
