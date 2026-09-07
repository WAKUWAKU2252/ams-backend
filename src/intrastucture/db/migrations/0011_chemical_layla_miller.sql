ALTER TABLE "asset_location" ADD COLUMN "sapLocationId" integer;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "code" varchar(20) NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "uom" varchar(20);--> statement-breakpoint
ALTER TABLE "asset_location" ADD CONSTRAINT "uq_asset_location_sap_id" UNIQUE("sapLocationId");--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "uq_category_code" UNIQUE("code");--> statement-breakpoint
-- ── หมวดสินทรัพย์ = รหัสบัญชี (ท่อนแรกของ OITM.AssetClass)
--
-- อยู่ใน migration ไม่ใช่สคริปต์ seed แยก ด้วยเหตุผลเดียวกับแถว 'ยังไม่ระบุที่ตั้ง' ใน 0010:
-- asset.connector.ts พึ่งแถวพวกนี้จริง — ไม่มีแล้ว categoryId ของทั้ง 2,325 ชิ้นจะเป็น NULL เงียบ ๆ
--
-- 9 รหัสนี้คือค่าที่พบจริงทั้งหมดใน OITM กลุ่ม 117 (นับได้ 44 ค่าเต็มของ AssetClass
-- แต่ท่อนแรกมีแค่ 9 แบบ) ชื่อไทยตั้งจากตัวอย่างสินทรัพย์ในแต่ละหมวด แก้ผ่านหน้าจอได้
-- ภายหลังโดยไม่กระทบ sync เพราะ connector จับคู่ด้วย code ไม่ใช่ name
--
-- ON CONFLICT: รันซ้ำได้ และไม่ทับชื่อที่ผู้ใช้แก้ไปแล้ว
INSERT INTO "category" ("code", "name") VALUES
  ('1215101', 'ที่ดิน'),
  ('1215102', 'ส่วนปรับปรุงที่ดิน'),
  ('1216101', 'ที่ดิน (2)'),
  ('1216120', 'ส่วนปรับปรุงที่ดิน (2)'),
  ('1216201', 'อาคารและสิ่งปลูกสร้าง'),
  ('1216301', 'เครื่องจักรและอุปกรณ์'),
  ('1216401', 'เครื่องใช้สำนักงาน'),
  ('1216402', 'ส่วนปรับปรุงอาคาร'),
  ('1216501', 'ยานพาหนะ')
ON CONFLICT ON CONSTRAINT "uq_category_code" DO NOTHING;--> statement-breakpoint
-- ── ผูก asset_location กลับไปหา OLCT ของ SAP
--
-- 52 แถวนี้ import มาจาก OLCT โดยรักษาลำดับไว้ id จึงตรงกับ OLCT.Code พอดีทุกแถว
-- (ตรวจครบทั้ง 52 แถวแล้วว่า id ตรงกับ OLCT.Code — สุ่มเทียบหัว/กลาง/ท้ายชุดทั้งหมด)
-- คัดลอกได้ครั้งนี้ครั้งเดียวเพราะรู้ที่มา — หลังจากนี้ connector ต้องอ่านจากคอลัมน์นี้เท่านั้น
-- ห้ามกลับไปใช้ id เทียบตรง ๆ: id เป็น serial ที่บนเครื่องอื่นหรือหลัง import รอบใหม่จะไม่ตรง
--
-- ยกเว้นแถวพัก UNASSIGNED ที่ AMS สร้างเองใน 0010 — ไม่มีคู่ใน SAP จึงต้องเป็น NULL
-- ไม่งั้น sync จะมองว่าเป็นที่ตั้งจริงแล้วเอาไปจับคู่กับ OLCT.Code = 53 ที่เป็นคนละที่
UPDATE "asset_location" SET "sapLocationId" = "id" WHERE "code" <> 'UNASSIGNED';