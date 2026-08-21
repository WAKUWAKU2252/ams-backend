// ═══════════════════════════════════════════════════════════════════════════
// อ่าน CSV ที่ docs/ — ใช้ร่วมกันทุก importer (department / employee / user)
//
// ทำไมไม่ split(',') เอาเอง: ไฟล์จาก HR มีจุลภาคอยู่ในค่าจริง เช่น
// "Safety, Health, and Environment Division" ซึ่งถูกครอบด้วย double quote ตามมาตรฐาน
// ถ้า split ตรง ๆ แถวนั้นจะเลื่อนทั้งแถวแล้วชื่อแผนกไปโผล่ผิดคอลัมน์โดยไม่มีอะไรฟ้อง
// (เจอจริง 4 แถวในไฟล์ v_hr_emp_final.csv)
// ═══════════════════════════════════════════════════════════════════════════

/** RFC4180: คั่นด้วย , ครอบด้วย " และ "" คือ quote ตัวจริงหนึ่งตัว */
function parseRows(text: string): string[][] {
  // BOM จาก Excel ติดมากับหัวคอลัมน์แรกเสมอ — ไม่ตัดทิ้ง key แรกจะกลายเป็น "﻿id"
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') (field += '"'), i++;
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (row.push(field), (field = ''));
    else if (c === '\n') (row.push(field), rows.push(row), (row = []), (field = ''));
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) (row.push(field), rows.push(row));
  return rows;
}

/**
 * อ่านไฟล์เป็น array ของ object ตามหัวคอลัมน์
 *
 * - คอลัมน์ที่ขึ้นต้นด้วย `_` ถูกตัดทิ้ง: เป็นข้อมูลอ้างอิงสำหรับคนอ่านไฟล์
 *   (เช่น `_prcCode`, `_hrGroup`) ไม่ใช่คอลัมน์ใน DB — ให้ไฟล์ทำหน้าที่เป็นเอกสารได้
 *   โดยที่ importer ไม่ต้องรู้จักมัน
 * - คอลัมน์หัวว่างถูกตัดทิ้งเช่นกัน (ไฟล์ export จาก Excel มักมีคอลัมน์ว่างต่อท้ายเป็นสิบ)
 * - แถวที่ทุกช่องว่างถูกข้าม (v_hr_emp_final.csv มีแถวว่างคั่นอยู่กลางไฟล์ 1 แถว)
 */
export async function readCsv(path: string): Promise<Record<string, string>[]> {
  const rows = parseRows(await Bun.file(path).text());
  if (rows.length === 0) throw new Error(`${path}: ไฟล์ว่าง`);

  const header = rows[0]!.map((h) => h.trim());
  const keep = header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h !== '' && !h.startsWith('_'));

  return rows
    .slice(1)
    .map((cols) => {
      const o: Record<string, string> = {};
      for (const { h, i } of keep) o[h] = (cols[i] ?? '').trim();
      return o;
    })
    .filter((o) => Object.values(o).some((v) => v !== ''));
}

/** 'true'/'1'/'yes' = true — ช่องว่างถือเป็น fallback ไม่ใช่ false (ต่างกันตอน default เป็น true) */
export function toBool(v: string, fallback: boolean): boolean {
  const s = v.trim().toLowerCase();
  if (s === '') return fallback;
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}
