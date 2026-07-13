import { db } from '../../db';
import { NotFoundError } from '../../common/errors';

// with นี้ inline ในแต่ละ query (ไม่แยกเป็น const) เพราะ Drizzle infer type ของ callback
// ได้เฉพาะตอนส่งตรงเข้า query — nested orderBy ล็อกลำดับให้ deterministic:
// items เรียงตาม poLine, grpoLines ตามวันรับของ (ไม่ระบุ = ลำดับตาม query planner ไม่แน่นอน)

// ดึงพร้อม items + grpoLines เพื่อให้หน้า Create New Asset รู้ว่าแต่ละ line รับของแล้วกี่ชิ้น
export function findAll() {
  return db.query.purchaseOrder.findMany({
    with: {
      items: {
        orderBy: (item, { asc }) => [asc(item.poLine)],
        with: { grpoLines: { orderBy: (line, { asc }) => [asc(line.grpoDate)] } },
      },
    },
    orderBy: (po, { desc }) => [desc(po.poDate)],
  });
}

export async function findOneOrFail(poNumber: string) {
  const po = await db.query.purchaseOrder.findFirst({
    where: (po, { eq }) => eq(po.poNumber, poNumber),
    with: {
      items: {
        orderBy: (item, { asc }) => [asc(item.poLine)],
        with: { grpoLines: { orderBy: (line, { asc }) => [asc(line.grpoDate)] } },
      },
    },
  });
  if (!po) throw new NotFoundError(`Purchase order ${poNumber}`);
  return po;
}
