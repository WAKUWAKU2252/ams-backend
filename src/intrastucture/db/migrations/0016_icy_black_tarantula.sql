-- ── ตีกลับ "รายชิ้น" โดยบัญชี (finance) + บันทึกว่าการตีกลับมาจาก role ไหน
--
-- ก่อนหน้านี้การตีกลับมีระดับเดียวคือทั้งใบ (asset_request.rejectedBy/rejectReason) ซึ่งใช้กับ
-- ขั้นบัญชีไม่ได้เลย: ใบผ่านอนุมัติแล้ว บัญชีเจอ S/N ผิดชิ้นเดียวใน 20 ชิ้น ทางเลือกที่มีคือ
-- cancel ทิ้ง (ผิด — ของยังอยู่ แค่ข้อมูลผิด) หรือปล่อยผ่าน ไม่มีทางบอกให้ผู้ขอกลับมาแก้
--
-- rejectedRole เก็บเป็น varchar ไม่ใช่ FK ไปตาราง role — เป็น snapshot ณ ตอนกด ด้วยเหตุผล
-- เดียวกับ asset_request.assignedManagerId: role ของคนย้ายได้ ถ้าอ่าน role ปัจจุบันตอนแสดงผล
-- ประวัติจะเพี้ยนย้อนหลัง
--
-- ทั้งชุดเป็น nullable และไม่มี backfill: แถวเดิมทั้งหมด = "ไม่เคยถูกตีกลับ" ซึ่งเป็นความจริง
ALTER TABLE "asset_request" ADD COLUMN "rejectedRole" varchar(50);--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "rejectedAt" timestamp;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "rejectedBy" integer;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "rejectReason" varchar(500);--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "rejectedRole" varchar(50);--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_rejected_by" FOREIGN KEY ("rejectedBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "ck_asset_reject_trio" CHECK (("asset"."rejectedAt" IS NULL) = ("asset"."rejectedBy" IS NULL)
          AND ("asset"."rejectedAt" IS NULL) = ("asset"."rejectReason" IS NULL));--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "ck_asset_reject_only_draft" CHECK ("asset"."rejectedAt" IS NULL OR "asset"."lifecycle" = 'DRAFT');