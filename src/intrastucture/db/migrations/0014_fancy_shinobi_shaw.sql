-- ⚠️ ไฟล์นี้เรียงลำดับใหม่ด้วยมือ ของที่ drizzle-kit generate ให้รันไม่ผ่าน
--
-- ที่ generate มาวาง DROP INDEX ไว้ท้าย ๆ แล้วแปลงชนิดคอลัมน์ก่อน ซึ่งพังทันที:
--   ERROR: operator does not exist: text <> request_status
-- เพราะ uq_asset_request_active เป็น partial index ที่ predicate อ้าง status
-- (WHERE status NOT IN ('REGISTERED','CANCELLED')) พอคอลัมน์กลายเป็น text
-- Postgres ต้องประเมิน predicate เดิมใหม่แล้วหา operator เทียบ text กับ enum ไม่เจอ
--
-- ลำดับที่ถูกคือ ปลดของที่อ้างคอลัมน์ออกก่อน (index + default) → แปลงชนิด → ใส่กลับ
-- ถ้ามีการ generate ทับไฟล์นี้ ต้องเรียงใหม่แบบเดียวกันอีก

-- ค่าใหม่ของ lifecycle ฝั่งชิ้น — ADD VALUE รันใน transaction ได้ตั้งแต่ PG 12
-- (ห้ามใช้ค่านี้ใน migration เดียวกัน ซึ่งไฟล์นี้ก็ไม่ได้ใช้)
ALTER TYPE "public"."asset_lifecycle" ADD VALUE 'CANCELLED';--> statement-breakpoint

-- ── ปลดของที่อ้าง asset_request.status ออกก่อนแปลงชนิด
DROP INDEX "uq_asset_request_active";--> statement-breakpoint
ALTER TABLE "asset_request" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint

-- ── แคบ enum: ถอด REGISTERED/CANCELLED (ย้ายไปเป็น lifecycle ของชิ้น)
-- ปลอดภัยเพราะไม่มีแถวไหนใช้สองค่านั้น — ตรวจก่อนเขียน migration แล้ว
ALTER TABLE "asset_request" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."request_status";--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');--> statement-breakpoint
ALTER TABLE "asset_request" ALTER COLUMN "status" SET DATA TYPE "public"."request_status" USING "status"::"public"."request_status";--> statement-breakpoint
ALTER TABLE "asset_request" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"public"."request_status";--> statement-breakpoint

-- ── ร่องรอยการตัดของทิ้งโดยบัญชี (คู่กับ lifecycle = 'CANCELLED')
ALTER TABLE "asset" ADD COLUMN "cancelReason" varchar(500);--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "cancelledAt" timestamp;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "cancelledBy" integer;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_cancelled_by" FOREIGN KEY ("cancelledBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── ล็อกใหม่: กันเฉพาะ "รอบที่ยังเปิดค้าง" ไม่ใช่ "PO ที่ยังไม่จบ"
-- APPROVED หลุดออกจากล็อก → GRPO รอบถัดไปเปิดใบใหม่ได้โดยไม่ต้องรอบัญชีออกเลขให้ครบ
CREATE UNIQUE INDEX "uq_asset_request_open_round" ON "asset_request" USING btree ("poNumber") WHERE "asset_request"."status" IN ('DRAFT', 'PENDING_APPROVAL', 'REJECTED') AND "asset_request"."deletedAt" IS NULL;
