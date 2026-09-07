import {t} from 'elysia';
import { paginationQuery } from '@common/pagination';

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

// ── ไม่บังคับ pattern โดยตั้งใจ (ถอด ASSET_NUMBER_REGEX ออก) ─────────────────
//
// ASSET_NUMBER_REGEX คือ "สคีมาที่บริษัทตั้งใจ" ไม่ใช่ "ทุกอย่างที่มีอยู่จริงใน SAP" —
// @common/asset-number บอกไว้เองว่าห้ามเอาไปคัดของทิ้ง และยกตัวอย่างของจริงที่ไม่เข้าสคีมา:
//   MAC-300-13-001.1   ชิ้นส่วนย่อย ใช้จุด
//   MAC-212-13-001/1   ถัง Silo ใช้ทับ
//   MAC-1-21/12-002    เครื่องบรรจุ คนละสคีมาไปเลย
// ตราบใดที่ pattern อยู่ตรงนี้ บัญชีพิมพ์เลขที่ SAP ออกให้จริงเข้า AMS ไม่ได้ — ติด 422
// ทั้งที่ค่าที่พิมพ์ถูกต้อง ซึ่งเป็นอาการเดียวกับที่เคยทำให้สินทรัพย์ 396 ชิ้นตกหล่นทั้งชุด
//
// หลักเดียวกับ assetByNumberQuery ใน asset.schema.ts ที่ถอด pattern ออกไปก่อนแล้วด้วย
// เหตุผลเดียวกัน — regex ยังทำหน้าที่ "ติดธง" ต่อไป (isAssetNumber ฝั่ง sync) แต่ไม่ใช่
// ด่านที่ปฏิเสธค่าที่คนกรอก
//
// maxLength 100 = ความกว้างจริงของคอลัมน์ asset.assetNumber (varchar(100)) ไม่ใช่ตัวเลข
// ที่เดาจากรูปแบบ — ตัวที่กันของยาวเกินคือ DB ไม่ใช่สคีมาที่นี่
//
// ไม่มี lifecycle/requestId ใน body: สองอย่างนั้น service เป็นคนตัดสินจาก state ปัจจุบัน
export const assignNumberBody = t.Object({
    assetNumber: t.String({
        // transform ใน routes trim ให้ก่อน validation แล้ว — minLength 1 จึงกันช่องว่างล้วนได้จริง
        minLength: 1,
        maxLength: 100,
        error: 'ต้องกรอกเลขสินทรัพย์ และยาวได้ไม่เกิน 100 ตัวอักษร',
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
