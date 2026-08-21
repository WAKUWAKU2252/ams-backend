import {t} from 'elysia';
import { paginationQuery } from '@common/pagination';
import { ASSET_NUMBER_MAX_LENGTH, ASSET_NUMBER_MIN_LENGTH, ASSET_NUMBER_REGEX } from '@common/asset-number';

// ไม่มี createBy — identity มาจาก token (currentUser.id) เท่านั้น ห้ามรับจาก body
export const createDraftBody = t.Object({
    poNumber: t.String({minLength:1, maxLength:50}),
})
export const requestIdParams = t.Object({id: t.Numeric()})

// updatedAt ที่ client เห็นตอนโหลด — ใช้เทียบกัน lost update ตอน submit
export const submitBody = t.Object({ expectedUpdatedAt: t.String({ minLength: 1 }) })
export const rejectBody = t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) })

// แจ้งจำนวนชิ้นของรอบรับของหนึ่งรอบ (PO งานเหมาที่ 1 หน่วย = ของหลายชิ้น)
export const declareLineParams = t.Object({
    id: t.Numeric(),
    grpoLineId: t.String({ format: 'uuid' }),
})
// reason บังคับเสมอ — การมีแถวนี้แปลว่าตัวเลขไม่ตรงกับ SAP แล้ว ต้องมีคนอธิบายและรับผิดชอบ
// declaredQty = 0 ได้ หมายถึงรอบนี้ไม่เกิดสินทรัพย์
export const declareLineBody = t.Object({
    declaredQty: t.Integer({ minimum: 0 }),
    reason: t.String({ minLength: 1, maxLength: 500 }),
})

// ── ขั้นบัญชี ──────────────────────────────────────────────────────────────
export const assignNumberParams = t.Object({
    id: t.Numeric(),
    assetId: t.Numeric(),
})

// pattern มาจาก @common/asset-number ที่เดียว ใช้ร่วมกับ LIKE ฝั่ง SAP — ห้ามพิมพ์ regex ซ้ำที่นี่
// ไม่มี lifecycle/requestId ใน body: สองอย่างนั้น service เป็นคนตัดสินจาก state ปัจจุบัน
export const assignNumberBody = t.Object({
    assetNumber: t.String({
        pattern: ASSET_NUMBER_REGEX.source,
        // ท่อนท้ายยาวไม่เท่ากัน (3–7 ตัว) จึงเป็นช่วง ไม่ใช่ความยาวตายตัวเหมือนเดิม
        minLength: ASSET_NUMBER_MIN_LENGTH,
        maxLength: ASSET_NUMBER_MAX_LENGTH,
        // ขึ้นบน error 422 ตรง ๆ — "ไม่ตรง pattern" อย่างเดียวผู้ใช้เดาไม่ออกว่าต้องพิมพ์ยังไง
        error:
          'เลขสินทรัพย์ต้องอยู่ในรูปแบบ XXX-###-##-<ท่อนท้าย 3-7 ตัว> ' +
          'เช่น COM-775-26-050 หรือ FAB-200-14-B101',
    }),
})

export const cancelBody = t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) })

// ต้องตรงกับ enumRequestStatus ใน schema — REGISTERED/CANCELLED ถูกถอดใน 0014
// (ย้ายไปเป็น lifecycle ของชิ้น) ถ้าเพิ่มค่าที่นี่โดยไม่แก้ enum จะได้ 500 ตอน query
const requestStatusLiteral = t.Union([
    t.Literal('DRAFT'),
    t.Literal('PENDING_APPROVAL'),
    t.Literal('APPROVED'),
    t.Literal('REJECTED'),
])

// status เป็น array ได้ (เช่น ?status=DRAFT&status=REJECTED) — หน้า draft ขอเห็น DRAFT+REJECTED
export const listQuery = t.Composite([ paginationQuery, t.Object({
    status: t.Optional(t.Array(requestStatusLiteral)),
})])
