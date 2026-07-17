// ═══ asset-request.schema.ts — ประตูตรวจ request ═══
//
// [ภาพใหญ่ก่อนเขียน — request ทุกตัววิ่งผ่าน 3 ชั้นเสมอ]
//   routes (ท่อ) → schema (ประตูตรวจ "รูปทรง") → service (สมอง ตรวจ "ความหมาย")
//   ประตูนี้ตอบแค่: uuid หน้าตาเป็น uuid ไหม? เลขหน้าเป็นตัวเลขไหม?
//   ไม่ตอบ: po line นี้มีจริงไหม / มี GRPO หรือยัง — คำถามที่ต้อง query DB เป็นงาน service
//   แบ่งแบบนี้เพื่อให้ของปลอม form โดนตีตก (422) แบบถูกที่สุด ไม่เปลือง DB สักครั้ง

import {t} from 'elysia';
import { paginationQuery } from '../../common/pagination';

// STEP 1: imports
//   - { t } จาก 'elysia'
//   - { paginationQuery } จาก '../../common/pagination'


export const createDraftBody = t.Object({
    poNumber: t.String({minLength:1, maxLength:50}),
    createBy: t.String({minLength:1,maxLength:50})
})
// STEP 2: export const createDraftBody = t.Object({ ... })
//   - poNumber: t.String({ minLength: 1, maxLength: 50 })   ← ชี้เป้า PO "ทั้งใบ" (design A)
//     ตรงกับที่ assetRequestApi.ts ฝั่ง front ส่งมา: { poNumber }
//   - createBy: t.String({ minLength: 1, maxLength: 50 })
//     ★ ชั่วคราวจนกว่าจะมี auth — ดูเหตุผล+คำเตือนใน service STEP สุดท้าย
//   ข้อคิด: body ของการสร้าง draft มีแค่ "การชี้เป้า" ไม่มีข้อมูล asset เลย
//   เพราะข้อมูลรายชิ้นมาทีหลังตอนกด [+ ลงทะเบียน] — ถ้าเขียนไปแล้ว body เริ่มบวม
//   ให้เอะใจว่ากำลังลากงานของขั้นอื่นมายัดขั้นสร้างหรือเปล่า

export const requestIdParams = t.Object({id: t.Numeric()})

export const listQuery = t.Composite([ paginationQuery,t.Object({
    status: t.Optional(t.Union([t.Literal('DRAFT'),
        t.Literal('PENDING_APPROVAL'),
        t.Literal('APPROVED'),
        t.Literal('REJECTED'),
        t.Literal('REGISTERED'),
        t.Literal('CANCELLED')
    ],
    )),
    createBy: t.Optional(t.String())
})])

// STEP 3: export const requestIdParams = t.Object({ id: t.Numeric() })
//   ★ กับดัก: path param มาจาก URL เป็น string เสมอ ("12" ไม่ใช่ 12)
//   t.Numeric() ของ Elysia แปลง string -> number + validate ให้ในตัว
//   (เทียบกับ upload ที่ใช้ t.String({format:'uuid'}) — ตารางนี้ PK เป็น integer คนละชนิดกัน)



// STEP 4: export const listQuery = t.Composite([ paginationQuery, t.Object({ ... }) ])
//   - status: t.Optional(t.Union([t.Literal('DRAFT'), t.Literal('PENDING_APPROVAL'), ...]))
//     ค่าต้องตรงกับ pgEnum request_status ใน db/schema.ts เป๊ะ
//   - createBy: t.Optional(t.String())   ← ชั่วคราวเช่นกัน (อนาคตอ่านจาก token)
//   ★ reuse paginationQuery จาก common — อย่าประกาศ page/limit เอง
//   (ของกลางมี default 10 / เพดาน 100 ให้แล้ว ประกาศซ้ำ = สองมาตรฐานในระบบเดียว)



// กติกาโปรเจกต์: type ให้ derive จาก schema — typeof createDraftBody.static
// ห้ามประกาศ interface ซ้ำ (schema กับ type จะวิ่งคนละทางทันทีที่มีคนแก้ฝั่งเดียว)
