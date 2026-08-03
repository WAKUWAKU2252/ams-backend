// logic ทั้งหมดของ upload — validate, เขียนไฟล์ลง disk, บันทึกทะเบียนลง DB
import { join } from 'node:path';
import { mkdir, unlink } from 'node:fs/promises';
import { eq, isNull, and, lt, notExists, sql } from 'drizzle-orm';
import { db } from '../../db';
import { attachment, grpoInvoice, asset } from '../../db/schema';
import { env } from '../../config/env';
import { BadRequestError, NotFoundError } from '../../common/errors';

// ext ทำสองหน้าที่: เป็น whitelist (MIME นอก map = ปฏิเสธ) และเป็นตัวกำหนดนามสกุลบน disk
// — derive จาก MIME ไม่ตัดจากชื่อไฟล์ผู้ใช้ เพื่อกัน path traversal
const RULES = {
  INVOICE: {
    ext: { 'application/pdf': 'pdf', 'image/jpeg': 'jpeg', 'image/png': 'png' },
    maxSize: 10 * 1024 * 1024,
  },
  ASSET_IMG: {
    ext: { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' },
    maxSize: 5 * 1024 * 1024,
  },
} satisfies Record<string, { ext: Record<string, string>; maxSize: number }>;

type DocType = keyof typeof RULES;

await mkdir(env.UPLOAD_DIR, { recursive: true });

export async function saveFiles(files: File[], docType: DocType) {
  const rule = RULES[docType];

  // validate ทั้งชุดก่อนเริ่มเขียน disk — กันสภาพเซฟไปครึ่งเดียวแล้วพัง
  for (const file of files) {
    if (!(file.type in rule.ext)) {
      throw new BadRequestError(`${docType} ไม่รับรอง ${file.type}`);
    }
    if (file.size > rule.maxSize) {
      throw new BadRequestError(`${file.name} เกินขนาดที่รับรอง (${rule.maxSize / 1024 / 1024} MB)`);
    }
  }

  const saved = [];
  for (const file of files) {
    const ext = rule.ext[file.type as keyof typeof rule.ext];
    const storedName = `${crypto.randomUUID()}.${ext}`;

    await Bun.write(join(env.UPLOAD_DIR, storedName), file);

    // ไฟล์ถูกบันทึกแบบยังไม่มีเจ้าของ — ฝั่งเจ้าของ (grpo.invoiceId / asset.imageId)
    // มาชี้เข้ามาทีหลังตอน submit ฟอร์ม โดยใช้ id ที่ return กลับไปให้ frontend
    const [row] = await db
      .insert(attachment)
      .values({
        docType,
        originalName: file.name,
        storedName,
        mimeType: file.type,
        size: file.size,
      })
      .returning();

    saved.push({
      id: row.id,
      name: row.originalName,
      url: `/uploads/${row.id}/file`,
      size: row.size,
    });
  }

  return { files: saved };
}

export async function getFileOrFail(id: string) {
  const row = await db.query.attachment.findFirst({
    where: and(eq(attachment.id, id), isNull(attachment.deletedAt)),
  });
  if (!row) throw new NotFoundError(`Attachment ${id}`);

  // ประกอบ path จาก storedName ใน DB เท่านั้น — ไม่รับ path จาก client
  return {
    path: join(env.UPLOAD_DIR, row.storedName),
    mimeType: row.mimeType,
    originalName: row.originalName,
  };
}

// ตั้งใจไม่ลบไฟล์บน disk: row หายก่อนไฟล์ = ขยะที่กวาดทีหลังได้
// แต่ไฟล์หายก่อน row = ทะเบียนชี้ไฟล์ผี (พังถาวร) — เลือกทางที่ซ่อมได้
export async function softDelete(id: string) {
  const [row] = await db
    .update(attachment)
    .set({ deletedAt: sql`now()` })
    // ต้องมี isNull(deletedAt) — ลบซ้ำรอบสองต้องได้ 404 ไม่ใช่สำเร็จเงียบ ๆ
    .where(and(eq(attachment.id, id), isNull(attachment.deletedAt)))
    .returning();

  if (!row) throw new NotFoundError(`Attachment ${id}`);
  return { success: true };
}

// upload เกิดก่อน submit — ถ้า user refresh/ปิดแท็บ id ที่ browser ถืออยู่จะหายถาวร
// เหลือไฟล์บน disk ที่ไม่มีวันถูกผูกกับอะไรอีก ต้องมีคนกวาด
export async function cleanupOrphans(): Promise<number> {
  // แถวที่เพิ่งเกิด = user อาจกำลังกรอกฟอร์มอยู่ ห้ามแตะเด็ดขาด
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // กำพร้า = ไม่มีเจ้าของฝั่งไหนชี้ถึงเลย (แถวที่ user กดลบเองก็ไม่มีใครชี้ จึงถูกกวาดด้วย)
  const orphans = await db
    .select({ id: attachment.id, storedName: attachment.storedName })
    .from(attachment)
    .where(
      and(
        lt(attachment.createdAt, cutoff),
        notExists(
          db.select({ n: sql`1` }).from(grpoInvoice).where(eq(grpoInvoice.attachmentId, attachment.id)),
        ),
        notExists(
          db.select({ n: sql`1` }).from(asset).where(eq(asset.imageId, attachment.id)),
        ),
      ),
    );

  let removed = 0;
  for (const row of orphans) {
    // รอบนี้ลบไฟล์ก่อนแถว (สลับกับ softDelete) เพราะถ้าลบแถวก่อนแล้วลบไฟล์พลาด
    // ไฟล์นั้นจะไม่มีทะเบียนชี้ -> หาไม่เจออีกเลยในรอบถัดไป
    try {
      await unlink(join(env.UPLOAD_DIR, row.storedName));
    } catch (error) {
      // ไฟล์หายไปก่อนแล้วถือว่าโอเค ไปลบแถวต่อได้ / error อื่น (เช่นไฟล์ถูก lock)
      // ข้ามไว้รอบหน้า — อย่าให้ไฟล์เดียวพังแล้วทั้ง batch ล้ม
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }

    // hard delete ตรงนี้ไม่ขัดกฎ soft delete ของโปรเจกต์ — กฎนั้นคุ้มครองข้อมูลธุรกิจ
    // แต่นี่คือทะเบียนของขยะที่ไม่เคยถูกใช้งาน เก็บไว้มีแต่ทำให้ DB โตฟรี
    await db.delete(attachment).where(eq(attachment.id, row.id));
    removed++;
  }

  return removed;
}
