// ═══════════════════════════════════════════════════════════════════════════
// ของใช้ร่วมของ connector ตอนทำงานหลายบริษัท (0021)
//
// รวมไว้ที่เดียวเพราะทั้งสามอย่างข้างล่างเป็นจุดที่ "ผิดแล้วเงียบ" ทั้งหมด — กระจาย
// ไปเขียนซ้ำในแต่ละ connector แล้วแก้ไม่ครบจะพังแบบไม่มีอะไรฟ้อง
// ═══════════════════════════════════════════════════════════════════════════
import { employee } from '@intrastucture/db/schema';

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
 * คอลัมน์ ownerCode ที่ต้องใช้ resolve ผู้ขอ PO ของบริษัทนี้
 *
 * OHEM มีอยู่ทั้งสองฐานและเดินเลขอิสระกัน — เลขชนกัน 264 ตัว (99% ของฝั่ง UBP) และ
 * 82 คนบังเอิญได้เลขเดียวกันทั้งสองฐาน ค้นผิดคอลัมน์จะ "ดูเหมือนถูก" 82 เคส
 * แล้วผูกผิดคนที่เหลือแบบเงียบ ๆ → การ์ด Teams ขออนุมัติวิ่งไปหาหัวหน้าผิดคน
 *
 * ⚠️ เพิ่มบริษัทที่มี SAP ตัวที่สาม = ต้องเพิ่มคอลัมน์ใน employee แล้วมาเพิ่ม case ที่นี่
 *    throw ไม่ใช่ถอยไปใช้ UBA — ถอยแล้วจะผูกผิดคนทั้งชุดโดยไม่มีอะไรฟ้อง
 */
export function ownerCodeColumn(companyCode: string) {
  switch (companyCode) {
    case 'UBA':
      return employee.ownerCodeUba;
    case 'UBP':
      return employee.ownerCodeUbp;
    default:
      throw new Error(
        `บริษัท '${companyCode}' ยังไม่มีคอลัมน์ ownerCode ใน employee — ` +
          `ต้องเพิ่มคอลัมน์ก่อนแล้วมาเติม case ที่ ownerCodeColumn()`,
      );
  }
}

/**
 * ออฟเซ็ตของบริษัทสำหรับ advisory lock — lockKey สุดท้าย = <base ของ entity> * 1000 + ค่านี้
 *
 * ต้องแยกต่อบริษัท ไม่งั้น UBA ที่กำลัง sync อยู่จะบล็อก UBP ทั้งที่คนละฐานคนละตาราง
 * ปลายทาง (เดิม lockKey เป็นค่าคงที่ต่อ entity เพราะมีบริษัทเดียว)
 *
 * ชนกันได้ในทางทฤษฎี (mod 997) แต่ผลของการชนคือสองบริษัทนั้น sync ต่อคิวกันแทนที่จะ
 * พร้อมกัน — ช้าลง ไม่ใช่ข้อมูลเพี้ยน จึงยอมรับได้สำหรับ 7 บริษัท
 * base สูงสุดคือ 811003 → 811003 * 1000 + 996 ยังอยู่ในช่วง int4 ของ pg
 */
export const companyLockOffset = (companyCode: string): number =>
  [...companyCode].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7);

/** lockKey ที่ engine ใช้จริง — base ของ entity ผสมกับบริษัท */
export const lockKeyFor = (entityBase: number, companyCode: string): number =>
  entityBase * 1000 + companyLockOffset(companyCode);
