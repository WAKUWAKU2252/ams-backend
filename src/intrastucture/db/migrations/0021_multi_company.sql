-- ═══════════════════════════════════════════════════════════════════════════
-- 0021 — รองรับสองบริษัท (UBA + UBP) ใน ams_db เดียว
--
-- ⚠️ ไฟล์นี้ถูกเรียงลำดับใหม่ด้วยมือ ไม่ใช่ผลดิบจาก drizzle-kit
--    drizzle รู้แค่ "โครงต่างจากเดิมยังไง" แต่ไม่รู้ว่าข้อมูลเดิมต้องถูกย้าย/เติมยังไง
--    สามอย่างที่ต้องเติมเอง:
--      1. คอลัมน์ NOT NULL บนตารางที่มีข้อมูลอยู่แล้ว (102 PO / 154 GRPO / 2,748 asset)
--         → ใส่ DEFAULT 'UBA' ให้ backfill แล้วค่อย DROP DEFAULT ทิ้ง
--         (คงไว้ = แถวใหม่จะกลายเป็น UBA เงียบ ๆ ตอนลืมใส่ค่า)
--      2. employee.ownerCode → ownerCodeUba ต้อง UPDATE ก่อน DROP ไม่งั้นข้อมูล 173 แถวหาย
--      3. เติม prefix ลงเลขเอกสาร ซึ่งเป็นการ UPDATE ค่า PK → ต้องถอด FK ชั่วคราว
--
-- ทั้งไฟล์รันในทรานแซกชันเดียว (drizzle migrator ครอบให้) — พังกลางทางแล้ว rollback ทั้งชุด
--
-- ⚠️ ไฟล์นี้ถูกแก้ "หลัง" apply ไปแล้วครั้งหนึ่ง — เวอร์ชันแรกสร้างตาราง user_company
--    (ชั้นจำกัดสิทธิ์รายบริษัท) ซึ่งภายหลังตัดทิ้งเพราะไม่ใช่สิ่งที่ต้องการ: ทั้งสองบริษัท
--    ต้องเห็นข้อมูลของกันและกันได้ตามปกติ companyCode จึงเป็นตัวกรอง ไม่ใช่กำแพงสิทธิ์
--
--    ฐานที่ apply เวอร์ชันแรกไปแล้วจะมีตาราง user_company ค้างอยู่ — ต้อง DROP มือครั้งเดียว
--    (drizzle เทียบ migration ที่รันแล้วด้วยลำดับเวลา ไม่ได้ตรวจ hash ซ้ำ จึงไม่ฟ้องอะไร)
--    ฐานที่ migrate ใหม่จากศูนย์จะไม่มีตารางนี้ตั้งแต่แรก — ปลายทางตรงกันทั้งสองทาง
--
-- ข้อมูลเดิมทั้งหมดใน ams_db เป็นของ UBA (ยืนยันแล้ว: sync ต่อฐาน SAP ของ UBA ฐานเดียว
-- มาตลอด และ poNumber ทุกแถวเป็นตัวเลขล้วน = ไม่เคยมี prefix ของบริษัทอื่นปน)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ตาราง company ─────────────────────────────────────────────────────────
CREATE TABLE "company" (
	"code" varchar(20) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"sapDbName" varchar(50),
	"poPrefix" varchar(10),
	"grpoPrefix" varchar(10),
	"itemGroups" varchar(50),
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- seed ต้องมาก่อน FK ทุกตัวข้างล่าง ไม่งั้น ADD CONSTRAINT จะ fail เพราะแถวเดิมชี้ 'UBA' ที่ยังไม่มี
--
-- 7 บริษัทตามที่ระบบ HR ระบุ (docs/Book1.xlsx Sheet1) — 5 บริษัทล่างไม่มี SAP
-- sapDbName เป็น NULL จึงตอบในตัวว่าทำไมไม่มี prefix/itemGroups
--
-- ⚠️ ชื่อนิติบุคคลเต็มและชื่อฐาน SAP จริง **ถูกถอดออกจาก git โดยตั้งใจ** — ที่นี่ seed
--    ไว้แค่รหัสบริษัท ส่วนค่าจริงอยู่ใน docs/seed-company.sql ซึ่งไม่ขึ้น git
--    ฐานที่ apply ไฟล์นี้ไปแล้วมีค่าจริงอยู่ครบ ไม่ได้รับผลอะไร (drizzle เทียบด้วย
--    ลำดับเวลา ไม่ได้ตรวจ hash — ดูหมายเหตุข้อ 3 ข้างบน) แต่ฐานที่ migrate ใหม่
--    จากศูนย์ต้องรัน seed-company.sql ต่อท้าย ★ ไม่รัน = sapDbName เป็น NULL ทั้งชุด
--    แปลว่า sync จะข้ามทุกบริษัทแบบเงียบ ๆ (ดู sync.service.ts: กรอง isNotNull ทิ้ง)
-- ⚠️ itemGroups: UBA ใช้ 117 · UBP ใช้ 110 (ยืนยันจาก OITB: กลุ่ม 110 ของ UBP ชื่อ
--    'Fixed Asset' มี 544 ตัว AssetClass ครบ 541 ส่วนกลุ่ม 117 ไม่มีอยู่ใน UBP เลย)
INSERT INTO "company" ("code", "name", "sapDbName", "poPrefix", "grpoPrefix", "itemGroups") VALUES
  ('UBA', 'UBA', NULL, 'APO-', 'AGP-', '117'),
  ('UBP', 'UBP', NULL, 'PPO-', 'PGP-', '110'),
  ('MIG', 'MIG', NULL, NULL, NULL, NULL),
  ('KCC', 'KCC', NULL, NULL, NULL, NULL),
  ('TTC', 'TTC', NULL, NULL, NULL, NULL),
  ('KTN', 'KTN', NULL, NULL, NULL, NULL),
  ('VTA', 'VTA', NULL, NULL, NULL, NULL);--> statement-breakpoint

-- ── 2. ถอดกติกา singleton ของ sync ออก (คนละบริษัทต้องมี watermark ของตัวเอง) ──
ALTER TABLE "sap_asset_sync" DROP CONSTRAINT "ck_sap_asset_sync_singleton";--> statement-breakpoint
ALTER TABLE "sap_grpo_sync" DROP CONSTRAINT "ck_sap_grpo_sync_singleton";--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync" DROP CONSTRAINT "ck_sap_purchase_order_sync_singleton";--> statement-breakpoint

-- ── 3. เพิ่ม companyCode / docEntry ─────────────────────────────────────────
-- DEFAULT 'UBA' ทำหน้าที่ backfill แถวเดิมให้ในคำสั่งเดียว แล้วถอดทิ้งทันที
-- (drizzle ออกมาเป็น ADD COLUMN ... NOT NULL เปล่า ๆ ซึ่ง fail ทันทีบนตารางที่มีข้อมูล)
ALTER TABLE "purchase_order" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "purchase_order" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "docEntry" integer;--> statement-breakpoint

ALTER TABLE "grpo" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "grpo" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "grpo" ADD COLUMN "docEntry" integer;--> statement-breakpoint

ALTER TABLE "asset" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "sap_asset_sync" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "sap_asset_sync" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sap_asset_sync_event" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "sap_asset_sync_event" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sap_grpo_sync" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "sap_grpo_sync" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sap_grpo_sync_event" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "sap_grpo_sync_event" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync_event" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync_event" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint

-- sap_grpo_unlinked: companyCode ต้องอยู่ใน PK ด้วย เพราะ grpoDocEntry เป็นเลขภายใน
-- ของแต่ละฐาน — UBA กับ UBP เดินเลขอิสระกัน ไม่มีคอลัมน์นี้แถวของ UBP จะทับ UBA
ALTER TABLE "sap_grpo_unlinked" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "sap_grpo_unlinked" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sap_grpo_unlinked" DROP CONSTRAINT "pk_sap_grpo_unlinked";--> statement-breakpoint
ALTER TABLE "sap_grpo_unlinked" ADD CONSTRAINT "pk_sap_grpo_unlinked" PRIMARY KEY("companyCode","grpoDocEntry","grpoLineNum");--> statement-breakpoint

-- ── 4. employee: ownerCode → ownerCodeUba (ต้องย้ายข้อมูลก่อนลบ) ────────────
ALTER TABLE "employee" ADD COLUMN "ownerCodeUba" integer;--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN "ownerCodeUbp" integer;--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN "companyCode" varchar(20);--> statement-breakpoint

-- ★ ห้ามข้ามบรรทัดนี้ — ค่า 173 แถวที่มีอยู่มาจาก OHEM ของ UBA ฐานเดียว
--   (ยืนยันจากไฟล์ employee.csv: ownerCode ทั้ง 173 ตัวไม่ซ้ำกันเลย ซึ่งเป็นไปได้
--    เฉพาะเมื่อมาจาก OHEM ตารางเดียว — ถ้ามาจากสองฐานควรชนกัน ~11 ตัว)
--   ⚠️ ตัวตนฝั่ง UBP ยังไม่มีในระบบเลย ต้อง import OHEM ของ UBP เข้ามาแยกต่างหาก
--      พร้อมให้ HR ยืนยันการจับคู่คนก่อน (247 คนอยู่ทั้งสองฐาน จับด้วยชื่อล้วน)
UPDATE "employee" SET "ownerCodeUba" = "ownerCode" WHERE "ownerCode" IS NOT NULL;--> statement-breakpoint

DROP INDEX "idx_employee_owner_code";--> statement-breakpoint
ALTER TABLE "employee" DROP CONSTRAINT "uq_employee_owner_code";--> statement-breakpoint
ALTER TABLE "employee" DROP COLUMN "ownerCode";--> statement-breakpoint

-- ── 5. sync: PK จาก id (singleton) → companyCode (แถวละบริษัท) ───────────────
-- DROP COLUMN ก่อน ADD PRIMARY KEY: การลบคอลัมน์ที่เป็น PK จะลบ constraint ให้เอง
-- ถ้าสลับลำดับจะได้ error "multiple primary keys for table" เพราะ PK เดิมยังอยู่
ALTER TABLE "sap_asset_sync" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "sap_asset_sync" ADD PRIMARY KEY ("companyCode");--> statement-breakpoint
ALTER TABLE "sap_grpo_sync" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "sap_grpo_sync" ADD PRIMARY KEY ("companyCode");--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync" ADD PRIMARY KEY ("companyCode");--> statement-breakpoint

-- ── 6. เติม prefix ลงเลขเอกสาร ──────────────────────────────────────────────
-- เป็นการ UPDATE ค่า PK ซึ่ง FK ปัจจุบันเป็น ON UPDATE NO ACTION จะบล็อกทันที
-- → ถอด FK สองตัวออกชั่วคราว แก้ทั้งพ่อทั้งลูก แล้วใส่กลับเหมือนเดิมทุกอ็อพชัน
--
-- เงื่อนไข ~ '^[0-9]+$' ทำให้รันซ้ำได้ปลอดภัย: แถวที่มี prefix แล้วจะไม่โดนเติมซ้ำ
ALTER TABLE "purchase_order_item" DROP CONSTRAINT "fk_purchase_order_item_po_number";--> statement-breakpoint
ALTER TABLE "asset_request" DROP CONSTRAINT "fk_asset_request_po_number";--> statement-breakpoint

UPDATE "purchase_order"      SET "poNumber" = 'APO-' || "poNumber" WHERE "poNumber" ~ '^[0-9]+$';--> statement-breakpoint
UPDATE "purchase_order_item" SET "poNumber" = 'APO-' || "poNumber" WHERE "poNumber" ~ '^[0-9]+$';--> statement-breakpoint
UPDATE "asset_request"       SET "poNumber" = 'APO-' || "poNumber" WHERE "poNumber" ~ '^[0-9]+$';--> statement-breakpoint
UPDATE "grpo"                SET "grpoNo"   = 'AGP-' || "grpoNo"   WHERE "grpoNo"   ~ '^[0-9]+$';--> statement-breakpoint

-- สองตารางนี้เป็น varchar ลอย ไม่มี FK — ต้องเติมตามมือ ไม่งั้นเลขในรายงานจะอ้างถึงใบที่หาไม่เจอ
UPDATE "sap_asset_unknown_number" SET "poNumber"     = 'APO-' || "poNumber"     WHERE "poNumber"     ~ '^[0-9]+$';--> statement-breakpoint
UPDATE "sap_grpo_unlinked"        SET "basePoNumber" = 'APO-' || "basePoNumber" WHERE "basePoNumber" ~ '^[0-9]+$';--> statement-breakpoint
UPDATE "sap_grpo_unlinked"        SET "grpoNo"       = 'AGP-' || "grpoNo"       WHERE "grpoNo"       ~ '^[0-9]+$';--> statement-breakpoint

ALTER TABLE "purchase_order_item" ADD CONSTRAINT "fk_purchase_order_item_po_number" FOREIGN KEY ("poNumber") REFERENCES "public"."purchase_order"("poNumber") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request" ADD CONSTRAINT "fk_asset_request_po_number" FOREIGN KEY ("poNumber") REFERENCES "public"."purchase_order"("poNumber") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── 7. FK / index / unique ที่เหลือ (ทำท้ายสุด เพราะข้อมูลต้องพร้อมก่อน) ─────
ALTER TABLE "purchase_order" ADD CONSTRAINT "fk_purchase_order_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grpo" ADD CONSTRAINT "fk_grpo_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "fk_employee_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_asset_sync" ADD CONSTRAINT "fk_sap_asset_sync_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_grpo_sync" ADD CONSTRAINT "fk_sap_grpo_sync_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync" ADD CONSTRAINT "fk_sap_purchase_order_sync_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_grpo_unlinked" ADD CONSTRAINT "fk_sap_grpo_unlinked_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "idx_purchase_order_company_code" ON "purchase_order" USING btree ("companyCode");--> statement-breakpoint
CREATE INDEX "idx_grpo_company_code" ON "grpo" USING btree ("companyCode");--> statement-breakpoint
CREATE INDEX "idx_employee_owner_code_uba" ON "employee" USING btree ("ownerCodeUba");--> statement-breakpoint
CREATE INDEX "idx_employee_owner_code_ubp" ON "employee" USING btree ("ownerCodeUbp");--> statement-breakpoint
CREATE INDEX "idx_employee_company_code" ON "employee" USING btree ("companyCode");--> statement-breakpoint
CREATE INDEX "idx_asset_company_code" ON "asset" USING btree ("companyCode");--> statement-breakpoint

-- uq_asset_number ต้องสร้างหลัง asset.companyCode มีค่าครบแล้ว (ข้อ 4 เติมให้เป็น 'UBA')
-- เหตุผลที่ต้องเติม companyCode เข้าคีย์: เลขสินทรัพย์ของ UBP ชนกับของ UBA 24 ตัว
DROP INDEX "uq_asset_number";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_asset_number" ON "asset" USING btree ("companyCode","assetNumber") WHERE "asset"."deletedAt" IS NULL;--> statement-breakpoint

ALTER TABLE "purchase_order" ADD CONSTRAINT "uq_purchase_order_doc_entry" UNIQUE("companyCode","docEntry");--> statement-breakpoint
ALTER TABLE "grpo" ADD CONSTRAINT "uq_grpo_doc_entry" UNIQUE("companyCode","docEntry");--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "uq_employee_owner_code_uba" UNIQUE("ownerCodeUba");--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "uq_employee_owner_code_ubp" UNIQUE("ownerCodeUbp");
