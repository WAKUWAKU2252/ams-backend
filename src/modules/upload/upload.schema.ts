// ═══ upload.schema.ts — ประตูตรวจ request ═══
// หน้าที่: ประกาศ TypeBox schema ให้ Elysia validate body/params ให้
// request ที่ผิด form โดน 422 ตั้งแต่ตรงนี้ — service ไม่ต้องกันเอง

// STEP 1: import { t } from 'elysia'
import {t} from 'elysia'

export const uploadBody = t.Object({
    entityKind: t.Union([t.Literal('INVOICE'),t.Literal('ASSET_IMG')]),

    files: t.Files({maxSize:'10m',minItems:1,maxItem:10})
})

export const attachementIdParams = t.Object({
    id: t.String({format:'uuid'})
})



// STEP 2: export const uploadBody = t.Object({ ... })
//   - entityKind: t.Union ของ t.Literal('INVOICE') กับ t.Literal('ASSET_IMG')
//     (ต้องตรงกับ pgEnum entity_kind ใน db/schema.ts)
//   - files: t.Files({ maxSize: '10m', minItems: 1, maxItems: 10 })
//     maxSize ตรงนี้คือ "เพดานรวม" — เพดานจริงต่อชนิด (5MB รูป) เช็คใน service
//     เพราะ whitelist ขึ้นกับค่า entityKind ซึ่ง TypeBox มองข้าม field ไม่ได้

// STEP 3: export const attachmentIdParams = t.Object({ ... })
//   - id: t.String({ format: 'uuid' }) — ใช้กับ GET /:id/file และ DELETE /:id

// กฎโปรเจกต์: ห้ามประกาศ interface ซ้ำ — ถ้าต้องการ type ให้ใช้ typeof uploadBody.static
