// ═══ upload.service.ts — สมองของ module ═══
// หน้าที่: logic ทั้งหมด — validate ตามกติกาธุรกิจ, เขียนไฟล์ลง disk, บันทึกทะเบียนลง DB
// กฎเหล็ก: TypeScript ล้วน ห้าม import จาก 'elysia' / ห้ามใช้ any / error ให้โยน AppError

// STEP 1: imports — มีแล้ว 4 ตัวด้านล่าง ยังขาด:
//   - join จาก 'node:path' (ประกอบ path), mkdir จาก 'node:fs/promises' (สร้างโฟลเดอร์)
//   - eq, isNull, and, sql จาก 'drizzle-orm'
//   - BadRequestError จาก '../../common/errors' (เพิ่มเข้าบรรทัดเดียวกับ NotFoundError)
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { eq, isNull, and, sql } from 'drizzle-orm';
import { db } from '../../db';
import { attachment } from '../../db/schema';
import { env } from '../../config/env';
import { BadRequestError, NotFoundError } from '../../common/errors';


// STEP 2: ประกาศ const RULES — กติกาต่อชนิดไฟล์ (หัวใจความปลอดภัยของ module)
//   RULES = { INVOICE: { ext: {...}, maxSize: 10MB }, ASSET_IMG: { ext: {...}, maxSize: 5MB } }
//   - ext เป็น map จาก MIME -> นามสกุล เช่น { 'application/pdf': 'pdf', 'image/jpeg': 'jpg' }
//     ทำหน้าที่ 2 อย่างพร้อมกัน: เป็น whitelist (MIME นอก map = ปฏิเสธ)
//     และเป็นตัวกำหนดนามสกุลไฟล์บน disk (derive จาก MIME ไม่ตัดจากชื่อไฟล์ผู้ใช้ — กัน path traversal)
//   - INVOICE รับ pdf/jpg/png (10MB), ASSET_IMG รับ jpg/png/webp (5MB)
//   - ประกาศ type EntityKind = keyof typeof RULES ไว้ใช้เป็น parameter type
const RULES = {
    INVOICE:{
    ext:{'application/pdf':'pdf','image/jpeg':'jpeg','image/png':'png'},
    maxSize:10*1024*1024,
    },
    ASSET_IMG:{
    ext:{'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'},
    maxSize:5*1024*1024,
    },
} satisfies Record<string, { ext: Record<string, string>; maxSize: number }>;

type EntityKind = keyof typeof RULES;



// STEP 3: สร้างโฟลเดอร์ปลายทางตอน boot (top-level await ได้ใน Bun)
//   await mkdir(env.UPLOAD_DIR, { recursive: true }) — มีอยู่แล้วก็ไม่ error
await mkdir(env.UPLOAD_DIR,{recursive:true});


// STEP 4: เปลี่ยน upload() ด้านล่างเป็น
//   export async function saveFiles(files: File[], entityKind: EntityKind)
//   4.1 validate "ทั้งชุด" ก่อนเริ่มเขียน disk (กันสภาพเซฟไปครึ่งเดียวแล้วพัง):
//       loop ทุกไฟล์ — file.type ไม่อยู่ใน rule.ext -> throw BadRequestError
//                     — file.size เกิน rule.maxSize -> throw BadRequestError
//   4.2 loop เซฟทีละไฟล์:
//       - storedName = crypto.randomUUID() + '.' + ext  (ตั้งชื่อเองเสมอ ห้ามใช้ file.name ใน path)
//       - await Bun.write(join(env.UPLOAD_DIR, storedName), file)
//       - db.insert(attachment).values({...}).returning() — ใส่แค่ docType + metadata ของไฟล์
//         attachment ไม่รู้จักเจ้าของ ฝั่ง grpo.invoiceId / asset.imageId มาชี้เข้ามาเองทีหลัง
//   4.3 return { files: [{ id, name, url, size }] } — shape ตรงกับ attachmentApi.ts ฝั่ง frontend
//       url = `/uploads/${id}/file` ให้ frontend เอาไปใส่ <img :src> ได้เลย


export async function saveFiles(files: File[],entityKind: EntityKind){
    const rule = RULES[entityKind];

    for(const file of files){
        if(!(file.type in rule.ext)){
            throw new BadRequestError(`${entityKind} ไม่รับรอง ${file.type}`)
        }
    }
    for(const file of files){
        if(file.size > rule.maxSize){
            throw new BadRequestError(`${file.name} เกินขนาดที่รับรอง(${rule.maxSize /1024 /1024}) MB`)
        }
    }

    const saved=[];
    for (const file of files){
        const ext = rule.ext[file.type as keyof typeof rule.ext];
        const storedName = `${crypto.randomUUID()}.${ext}`;

        await Bun.write(join(env.UPLOAD_DIR, storedName), file)

        const [row] = await db
        .insert(attachment)
        .values({
            // ไฟล์ถูกบันทึกแบบยังไม่มีเจ้าของ — ฝั่งเจ้าของ (grpo.invoiceId / asset.imageId)
            // มาชี้เข้ามาทีหลังตอน submit ฟอร์ม โดยใช้ id ที่ return กลับไปให้ frontend
            docType: entityKind,
            originalName:file.name,
            storedName,
            mimeType:file.type,
            size:file.size
        }).returning();
    }
}

// STEP 5: export async function getFileOrFail(id: string)
//   - db.query.attachment.findFirst where: id ตรง AND deletedAt เป็น null
//     (ไฟล์ที่ลบแล้วต้องมองไม่เห็น)
//   - ไม่เจอ -> throw NotFoundError
//   - return { path: join(env.UPLOAD_DIR, row.storedName), mimeType, originalName }
//     (ประกอบ path จาก storedName ใน DB เท่านั้น — ไม่รับ path จาก client)

// STEP 6: export async function softDelete(id: string)
//   - db.update(attachment).set({ deletedAt: sql`now()` }) + .returning()
//   - where ต้องมี isNull(deletedAt) ด้วย — ลบซ้ำรอบสองต้องได้ 404 ไม่ใช่สำเร็จเงียบ ๆ
//   - returning ว่าง -> throw NotFoundError / สำเร็จ -> return { success: true }
//   - ตั้งใจ "ไม่ลบไฟล์บน disk": row หายก่อนไฟล์ = ขยะที่กวาดทีหลังได้
//     แต่ไฟล์หายก่อน row = ทะเบียนชี้ไฟล์ผี (พังถาวร) — เลือกทางที่ซ่อมได้

// ═══ STEP 7: cleanupOrphans — กวาดไฟล์กำพร้า (แก้ปัญหา user refresh แล้ว id หาย) ═══
// ที่มา: upload เกิดก่อน submit — ถ้า user refresh/ปิดแท็บ id ที่ browser ถืออยู่จะหายถาวร
// เหลือแถว entityId = NULL + ไฟล์บน disk ที่ไม่มีวันถูกผูกกับ asset ไหนอีก -> ต้องมีคนกวาด
// เลือกกวาดฝั่ง server เพราะจับได้ทุกเคส (browser ปิด/เน็ตหลุด/เครื่องดับ) — ความจริงอยู่ที่ DB
//
// export async function cleanupOrphans(): Promise<number>
//
//   7.1 หา "ขยะ" — db.query.attachment.findMany where 2 เงื่อนไข AND กัน:
//       - isNull(attachment.entityId)              -> ยังไม่เคยถูกผูกกับ asset
//       - lt(attachment.createdAt, cutoff)         -> เกิดมานานเกิน 24 ชม.
//       เงื่อนไขอายุคือหัวใจ: แถวที่เพิ่งเกิด = user อาจกำลังกรอกฟอร์มอยู่ ห้ามแตะเด็ดขาด
//       cutoff คำนวณใน TS ได้เลย: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
//       (createdAt เป็น isoTimestamp -> เทียบกับ ISO string ได้ / import lt เพิ่มจาก drizzle-orm)
//       หมายเหตุ: แถวที่ user กดลบเอง (deletedAt มีค่า) entityId ก็เป็น NULL อยู่แล้ว
//       -> เข้าเงื่อนไขนี้อัตโนมัติ = ไฟล์ที่กดลบก็ถูกกวาดจริงในรอบนี้ด้วย (ตั้งใจ)
//
//   7.2 loop ทีละแถว — ลบ "ไฟล์ก่อน แถวทีหลัง" (สลับกับหลักตอนใช้งานปกติ เพราะรอบนี้
//       ถ้าลบแถวก่อนแล้วลบไฟล์พลาด ไฟล์นั้นจะไม่มีทะเบียนชี้ -> หาไม่เจออีกเลยในรอบถัดไป):
//       - await unlink(join(env.UPLOAD_DIR, row.storedName))  // import unlink จาก 'node:fs/promises'
//       - ครอบ try/catch "ต่อไฟล์" ไม่ใช่ครอบทั้ง loop:
//         * error code 'ENOENT' (ไฟล์หายไปก่อนแล้ว) -> ถือว่าโอเค ไปลบแถวต่อได้
//         * error อื่น (เช่น ไฟล์ถูก lock) -> continue ข้ามแถวนี้ไว้รอบหน้า
//           อย่าให้ไฟล์เดียวพังแล้วทั้ง batch ล้ม
//
//   7.3 ลบแถวทิ้งจริง (hard delete): db.delete(attachment).where(eq(attachment.id, row.id))
//       ไม่ขัดกฎ soft delete ของโปรเจกต์ — กฎนั้นคุ้มครอง "ข้อมูลธุรกิจ"
//       แต่นี่คือทะเบียนของขยะที่ไม่เคยถูกใช้งาน เก็บไว้มีแต่ทำให้ DB โตฟรี
//
//   7.4 นับจำนวนที่กวาดสำเร็จ แล้ว return ให้คนเรียกเอาไป log
//
// STEP 8: ตั้งเวลาเรียก — "ไม่ทำในไฟล์นี้" ไปทำที่ src/index.ts (มี comment นำทางรอที่นั่น)
//   เหตุผล: ถ้า setInterval ตรงนี้ แค่ import service ใน test ก็มี job แอบรันเป็น side effect
//   และต้อง export cleanupOrphans เพิ่มใน modules/upload/index.ts ให้ entry เรียกได้
//   (ขยายข้อยกเว้นจากกฎ "export เฉพาะ routes" — job ก็เป็น public surface ของ module)
