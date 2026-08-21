// logic ของรอบรับของ (GRPO) — TypeScript ล้วน ไม่ import จาก elysia
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { grpo, grpoLine, grpoInvoice, purchaseOrderItem, attachment } from '@intrastucture/db/schema';
import { BadRequestError, NotFoundError } from '@common/errors';

export async function findOneOrFail(id: number) {
  const row = await db.query.grpo.findFirst({
    where: eq(grpo.id, id),
    with: {
      lines: { with: { poItem: true } },
      invoices: { with: { attachment: true } },
    },
  });
  if (!row) throw new NotFoundError(`GRPO ${id}`);
  return row;
}

// รอบรับของทั้งหมดของ PO ใบหนึ่ง — grpo ไม่ได้ผูก poNumber ตรง ๆ (ผูกผ่าน line)
// เพราะ GRPO อ้าง PO line ไม่ใช่ PO ทั้งใบ จึงต้องไต่ผ่าน grpo_line -> purchase_order_item
export async function findByPo(poNumber: string) {
  const grpoIds = db
    .select({ id: grpoLine.grpoId })
    .from(grpoLine)
    .innerJoin(purchaseOrderItem, eq(purchaseOrderItem.id, grpoLine.poItemId))
    .where(eq(purchaseOrderItem.poNumber, poNumber));

  return db.query.grpo.findMany({
    where: inArray(grpo.id, grpoIds),
    with: {
      lines: { with: { poItem: true } },
      invoices: { with: { attachment: true } },
    },
    orderBy: (g, { asc }) => [asc(g.grpoDate), asc(g.id)],
  });
}

// แนบไฟล์ที่อัปโหลดไว้แล้วเข้ากับรอบรับของ (1 รอบมีได้หลายใบ / 1 ใบครอบหลายรอบ)
// แนบใบเดิมซ้ำรอบเดิม = no-op (PK กันซ้ำ) ไม่ถือเป็น error
export async function linkInvoice(id: number, attachmentId: string) {
  const target = await db.query.grpo.findFirst({ where: eq(grpo.id, id) });
  if (!target) throw new NotFoundError(`GRPO ${id}`);

  const file = await db.query.attachment.findFirst({
    where: and(eq(attachment.id, attachmentId), isNull(attachment.deletedAt)),
  });
  if (!file) throw new NotFoundError(`Attachment ${attachmentId}`);

  // composite FK กันเคสนี้อยู่แล้วที่ระดับ DB แต่ error ของ pg อ่านไม่รู้เรื่องสำหรับผู้ใช้
  // เช็คตรงนี้เพื่อให้ได้ 400 พร้อมข้อความไทย แทน 500 พร้อม constraint name
  if (file.docType !== 'INVOICE') {
    throw new BadRequestError('ไฟล์นี้ไม่ใช่ invoice — แนบได้เฉพาะไฟล์ที่อัปโหลดเป็น INVOICE');
  }

  await db.insert(grpoInvoice).values({ grpoId: id, attachmentId }).onConflictDoNothing();
  return { success: true };
}

export async function unlinkInvoice(id: number, attachmentId: string) {
  // ไม่ลบแถว attachment ทิ้งที่นี่ — ไฟล์อาจถูก GRPO รอบอื่นใช้ร่วมอยู่
  // (invoice ใบเดียวครอบหลายรอบได้) ปล่อยให้ cleanupOrphans ตัดสินใจว่ากำพร้าจริงไหม
  const deleted = await db
    .delete(grpoInvoice)
    .where(and(eq(grpoInvoice.grpoId, id), eq(grpoInvoice.attachmentId, attachmentId)))
    .returning();

  // ถอดของที่ไม่มีอยู่ = ผู้ใช้เข้าใจสถานะผิด ควรบอกไม่ใช่เงียบ ๆ ว่าสำเร็จ
  if (deleted.length === 0) {
    throw new NotFoundError(`invoice ${attachmentId} ในรอบ GRPO ${id}`);
  }
  return { success: true };
}
