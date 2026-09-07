// ═══════════════════════════════════════════════════════════════════════════
// ของใช้ร่วมของ connector ตอนทำงานหลายบริษัท (0021)
//
// รวมไว้ที่เดียวเพราะทั้งสามอย่างข้างล่างเป็นจุดที่ "ผิดแล้วเงียบ" ทั้งหมด — กระจาย
// ไปเขียนซ้ำในแต่ละ connector แล้วแก้ไม่ครบจะพังแบบไม่มีอะไรฟ้อง
// ═══════════════════════════════════════════════════════════════════════════
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { employeeCompany } from '@intrastucture/db/schema';
import type { Tx } from '@/modules/integrate/SAP/sync.engine';

/**
 * ประกอบเลขเอกสารเต็มจาก NNM1.BeginStr + DocNum เช่น 'APO-' + 62605007 → 'APO-62605007'
 *
 * BeginStr มี '-' ติดมาในค่าอยู่แล้ว ห้ามเติมเอง
 *
 * beginStr เป็น NULL ได้จริง (series 'Primary' ที่ SAP ติดมาตอนสร้างบริษัทและแทบไม่มี
 * ใครใช้) — กรณีนั้นได้เลขเปล่าซึ่งยังดีกว่าทิ้งใบนั้นไป แต่ถ้าเจอเยอะแปลว่ามีสายเอกสาร
 * ที่เราไม่รู้จัก ควรไปดู NNM1 ก่อนตัดสินใจ
 */
export const docKey = (beginStr: string | null | undefined, docNum: number | string): string =>
  `${beginStr ?? ''}${docNum}`;

/**
 * แผนที่ OHEM.OwnerCode → employee.id ของบริษัทหนึ่ง
 *
 * OHEM มีอยู่ทุกฐานและเดินเลขอิสระกัน — เฉพาะ UBA เทียบ UBP เลขชนกัน 264 ตัว
 * (99% ของฝั่ง UBP) และ 82 คนบังเอิญได้เลขเดียวกันทั้งสองฐาน ค้นโดยไม่กรองบริษัทจะ
 * "ดูเหมือนถูก" 82 เคส แล้วผูกผิดคนที่เหลือแบบเงียบ ๆ → การ์ด Teams ขออนุมัติ
 * วิ่งไปหาหัวหน้าผิดคน
 *
 * ★ อ่านจาก employee_company เท่านั้น (0025) — เดิมเป็น ownerCodeColumn() ที่ switch
 *   เลือกคอลัมน์ ownerCodeUba/Ubp/Mig ตามบริษัท ซึ่งแปลว่าบริษัทที่ต่อ SAP ตัวถัดไป
 *   ต้องเพิ่มคอลัมน์ + case + migration ทุกครั้ง ตอนนี้บริษัทเป็นแถว จึงไม่ต้องแตะ schema
 *
 * ⚠️ ห้ามกลับไปอ่าน employee.ownerCodeUba/Ubp/Mig — สามคอลัมน์นั้นเหลือไว้เพื่อ rollback
 *    รอบเดียวและจะถูกลบ ค่าในนั้นจะหยุดอัปเดตตั้งแต่ 0025 เป็นต้นไป
 *
 * codes ว่าง = คืน Map ว่างโดยไม่ยิงคิวรี (inArray กับ array ว่างใน pg คือ `IN ()` ซึ่ง error)
 */
export async function ownerCodeMap(
  tx: Tx,
  companyCode: string,
  codes: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!codes.length) return out;

  const rows = await tx
    .select({ id: employeeCompany.employeeId, ownerCode: employeeCompany.ownerCode })
    .from(employeeCompany)
    .where(
      and(
        eq(employeeCompany.companyCode, companyCode),
        isNotNull(employeeCompany.ownerCode),
        inArray(employeeCompany.ownerCode, codes),
      ),
    );
  for (const r of rows) if (r.ownerCode != null) out.set(r.ownerCode, r.id);
  return out;
}

/**
 * ออฟเซ็ตของบริษัทสำหรับ advisory lock — lockKey สุดท้าย = <base ของ entity> * 1000 + ค่านี้
 *
 * ต้องแยกต่อบริษัท ไม่งั้น UBA ที่กำลัง sync อยู่จะบล็อก UBP ทั้งที่คนละฐานคนละตาราง
 * ปลายทาง (เดิม lockKey เป็นค่าคงที่ต่อ entity เพราะมีบริษัทเดียว)
 *
 * ชนกันได้ในทางทฤษฎี (mod 997) แต่ผลของการชนคือสองบริษัทนั้น sync ต่อคิวกันแทนที่จะ
 * พร้อมกัน — ช้าลง ไม่ใช่ข้อมูลเพี้ยน จึงยอมรับได้ในระดับจำนวนบริษัทที่เป็นไปได้จริง
 * base สูงสุดคือ 811003 → 811003 * 1000 + 996 ยังอยู่ในช่วง int4 ของ pg
 */
export const companyLockOffset = (companyCode: string): number =>
  [...companyCode].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7);

/** lockKey ที่ engine ใช้จริง — base ของ entity ผสมกับบริษัท */
export const lockKeyFor = (entityBase: number, companyCode: string): number =>
  entityBase * 1000 + companyLockOffset(companyCode);
