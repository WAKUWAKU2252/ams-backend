import { count, ilike, or } from 'drizzle-orm';
import { db } from '../../db';
import { purchaseOrder } from '../../db/schema';
import { NotFoundError } from '../../common/errors';
import { paginate } from '../../common/pagination';

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

  return paginate(rows, totalResult[0].value, page, limit);
}

export async function completedPo(number: string){

}
