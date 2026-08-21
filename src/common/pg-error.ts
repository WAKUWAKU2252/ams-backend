// ═══════════════════════════════════════════════════════════════════════════
// อ่าน SQLSTATE ของ postgres จาก error ที่ drizzle โยนออกมา
//
// ตั้งแต่ drizzle 0.44 ทุก error ที่เกิดจากการรันคิวรีถูกห่อด้วย DrizzleQueryError
// ("Failed query: INSERT ...") แล้วเก็บ error ตัวจริงของ node-postgres ไว้ที่ .cause
// การเช็ค error.code ตรง ๆ จึงไม่มีวันตรงอีกต่อไป — โค้ดที่เขียนแบบนั้นไม่ได้ "เลิกทำงาน
// แบบส่งเสียง" แต่กลายเป็นเงื่อนไขที่เป็นเท็จเสมอ แล้วเคสที่ตั้งใจแปลงเป็น 4xx
// (เช่น unique ชนกัน -> 409) หลุดออกไปเป็น 500 โดยไม่มีใครรู้
//
// ไล่ตาม cause เป็นชั้น ๆ เผื่อวันหน้ามีใครห่อซ้ำอีกชั้น — จำกัดความลึกกัน cause วน
// ═══════════════════════════════════════════════════════════════════════════

const MAX_CAUSE_DEPTH = 5;

export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    return undefined;
  }

  return undefined;
}

/** 23505 = unique_violation — มีแถวที่ชน unique index อยู่ก่อนแล้ว */
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23505';
}

/**
 * ชื่อ constraint ที่ชน (เช่น 'uq_employee_email') — ไล่ .cause แบบเดียวกับ pgErrorCode
 *
 * ตารางที่มี unique หลายตัวต้องใช้ชื่อนี้แยกว่าชนอันไหน ไม่งั้นได้แต่ข้อความรวม ๆ ว่า
 * "ข้อมูลซ้ำ" ซึ่งคนกรอกฟอร์มที่มี 6 ช่องไม่มีทางรู้ว่าต้องแก้ช่องไหน
 */
export function pgConstraint(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current === 'object') {
      const constraint = (current as { constraint?: unknown }).constraint;
      if (typeof constraint === 'string') return constraint;
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    return undefined;
  }

  return undefined;
}
