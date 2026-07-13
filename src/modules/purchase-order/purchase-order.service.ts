import { AppDataSource } from '../../db/data-source';
import { NotFoundError } from '../../common/errors';
import { PurchaseOrder } from './purchase-order.entity';

const repo = () => AppDataSource.getRepository(PurchaseOrder);

// ดึงพร้อม items + grpoLines เพื่อให้หน้า Create New Asset รู้ว่าแต่ละ line รับของแล้วกี่ชิ้น
export function findAll() {
  return repo().find({
    relations: { items: { grpoLines: true } },
    order: { poDate: 'DESC' },
  });
}

export async function findOneOrFail(poNumber: string) {
  const po = await repo().findOne({
    where: { poNumber },
    relations: { items: { grpoLines: true } },
  });
  if (!po) throw new NotFoundError(`Purchase order ${poNumber}`);
  // Elysia serialize เป็น JSON เฉพาะ plain object — entity instance จะกลายเป็น "[object Object]"
  return { ...po };
}
