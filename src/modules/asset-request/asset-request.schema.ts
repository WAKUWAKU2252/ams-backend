import {t} from 'elysia';
import { paginationQuery } from '../../common/pagination';

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

const requestStatusLiteral = t.Union([
    t.Literal('DRAFT'),
    t.Literal('PENDING_APPROVAL'),
    t.Literal('APPROVED'),
    t.Literal('REJECTED'),
    t.Literal('REGISTERED'),
    t.Literal('CANCELLED'),
])

// status เป็น array ได้ (เช่น ?status=DRAFT&status=REJECTED) — หน้า draft ขอเห็น DRAFT+REJECTED
export const listQuery = t.Composite([ paginationQuery, t.Object({
    status: t.Optional(t.Array(requestStatusLiteral)),
})])
