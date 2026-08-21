// ═══════════════════════════════════════════════════════════════════════════
// ตัวแปลง "ผลลัพธ์ของ drizzle ที่เป็น array" ให้เป็นค่าเดี่ยวที่ type แน่นอน
//
// ที่มา: tsconfig เปิด noUncheckedIndexedAccess ไว้ (ถูกแล้ว) ทำให้ rows[0] มีชนิด
// T | undefined เสมอ แม้เรารู้ว่าคิวรีนั้นคืนแถวเดียวแน่ ๆ เช่น
//   - .returning() ของ insert/update ที่เขียนทีละแถว
//   - .select({ value: count() }) หรือ max() ซึ่ง aggregate คืนแถวเดียวเสมอ
//
// ทำไมไม่ใช้ `!` (non-null assertion): มันแค่ปิดปาก compiler โดยไม่มีอะไรรองรับ
// ตอน runtime ถ้าสมมติฐานผิดจริงจะได้ "Cannot read properties of undefined"
// ที่ไม่บอกว่าพังตรงไหน — helper พวกนี้ตรวจจริงแล้วโยน error ที่ระบุที่มาได้
//
// ทำไมไม่ใช้ `any`: จะทำให้ทุกอย่างที่ไหลต่อจากตรงนี้หลุด type checking ไปทั้งสาย
// ซึ่งตรงข้ามกับเหตุผลที่เปิด strict ไว้ตั้งแต่แรก
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ผิดสัญญาระดับโครงสร้าง ไม่ใช่ความผิดของผู้ใช้ — ปล่อยเป็น 500 ให้ error-handler
 * จับ (AppError คือฝั่ง 4xx ที่ตั้งใจสื่อสารกับผู้ใช้ ตัวนี้จึงไม่ใช่ AppError)
 */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

/**
 * แถวแรกของผลลัพธ์ที่ "ต้องมีเสมอ" — ใช้กับ .returning() ของ insert/update ทีละแถว
 *
 * @param rows ผลลัพธ์จาก drizzle
 * @param what ชื่อที่จะโผล่ใน error ถ้าสมมติฐานผิด เช่น 'insert asset'
 */
export function requireRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new InvariantError(`${what}: คาดว่าจะได้ผลลัพธ์ 1 แถว แต่ไม่ได้แถวไหนกลับมาเลย`);
  }
  return row;
}

/**
 * ค่าของ aggregate (count/max/sum) ที่ drizzle ห่อมาเป็น [{ value }]
 *
 * แยกจาก requireRow เพราะ call site อ่านง่ายกว่ามาก:
 *   const total = requireScalar(rows, 'count assets')   ชัดกว่า
 *   const { value: total } = requireRow(rows, '...')
 */
export function requireScalar<V>(rows: readonly { value: V }[], what: string): V {
  return requireRow(rows, what).value;
}

/**
 * แถวแรกที่ "ไม่มีก็ได้" — คืน undefined อย่างเปิดเผยให้ฝั่งเรียกจัดการเอง
 * (ไว้ใช้ตอนที่ "ไม่เจอ" เป็นผลลัพธ์ปกติ ไม่ใช่ความผิดปกติ)
 */
export function firstRow<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}
