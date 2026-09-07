-- ═══════════════════════════════════════════════════════════════════════════
-- 0024 — รองรับบริษัท SAP ตัวที่สาม: MIG (META INK GOLD, SBO_PRD_MIG)
--
-- ⚠️ ไฟล์นี้ถูกแก้ด้วยมือหลัง drizzle-kit generate ไม่ใช่ผลดิบ
--    drizzle รู้แค่ "โครงต่างจากเดิมยังไง" ไม่รู้ว่าข้อมูลเดิมต้องถูกเติมยังไง
--    ผลดิบสั่ง `ADD COLUMN "companyCode" varchar(20) NOT NULL` ตรง ๆ ซึ่ง **ล้มทันที**
--    บนตาราง department ที่มีแถวอยู่แล้ว (pg: column contains null values)
--    → ใส่ DEFAULT 'UBA' ให้ backfill แล้ว DROP DEFAULT ทิ้ง (หลักเดียวกับ 0021)
--      คง DEFAULT ไว้ไม่ได้: แถวใหม่ของบริษัทอื่นจะกลายเป็น UBA เงียบ ๆ ตอนลืมใส่ค่า
--
-- ทั้งไฟล์รันในทรานแซกชันเดียว (drizzle migrator ครอบให้) — พังกลางทาง rollback ทั้งชุด
--
-- ── ทำไมต้องมี department.companyCode ─────────────────────────────────────
--
-- วัดจาก docs/MIG.xlsx เทียบกับ docs/department-sap.csv ที่ import ไปแล้ว:
--   departmentId ชนกัน  32 จาก 33 รหัส   (ไม่ชนแค่ 'General')
--   ชื่อแผนกตรงกันเป๊ะ   18 ชื่อ           (Information Technology / Human Resources /
--                                          Finance / Executive / Legal / Maintenance ...)
-- ทั้งเครือใช้ผังรหัส cost center ชุดเดียวกัน รหัสจึงไม่ใช่เลขที่ไม่ซ้ำทั้งเครือ
--
-- ★ ถ้าปล่อยให้สองบริษัทใช้แถวเดียวกันจะไม่ใช่แค่ "ข้อมูลปนกัน": department.managerId
--   คือคนที่ระบบส่งการ์ดขออนุมัติเข้า Teams ไปหา แผนก 110 แถวเดียวมีหัวหน้าได้คนเดียว
--   คำขอของ MIG จึงจะวิ่งไปหาหัวหน้าของ UBA ทุกใบ — ส่งออกไปแล้วเรียกคืนไม่ได้
--
-- ── ข้อมูลเดิมเป็นของ UBA ทั้งหมด ─────────────────────────────────────────
--
-- ยืนยันด้วยเหตุผลเดียวกับ 0021: ก่อนหน้านี้ AMS ต่อ SBO_PRD_UBA ฐานเดียวมาตลอด
-- และ department ถูก import จาก docs/department-sap.csv ซึ่งเป็นชุดของ UBA ล้วน
--
-- ── employee.ownerCodeMig ─────────────────────────────────────────────────
--
-- คอลัมน์ที่สามต่อจาก ownerCodeUba/ownerCodeUbp — ฝั่ง SBO_PRD_MIG เก็บเลขนี้ในช่อง
-- ที่ SAP เรียกว่า empID (ยืนยันจากผู้ใช้) ★ คนละตัวกับ employee.empId ซึ่งเป็นรหัส
-- พนักงานของระบบ HR
--
-- ปล่อย NULL ทั้งคอลัมน์หลัง apply — ต้องนำเข้าจาก OHEM ของ MIG ก่อนเปิด sync
-- ไม่งั้น PO ของ MIG จะ resolve ผู้ขอไม่เจอทุกใบ (ownerPrId เป็น NULL ทั้งชุด)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ถอด unique เดิมที่เป็นคีย์เดี่ยว ──────────────────────────────────────
-- ต้องมาก่อนการเติมข้อมูล MIG เสมอ ไม่งั้นแถวที่ 33 ของ MIG ชนตั้งแต่แถวแรก
ALTER TABLE "department" DROP CONSTRAINT "uq_department_hr_id";--> statement-breakpoint
ALTER TABLE "department" DROP CONSTRAINT "uq_department_name";--> statement-breakpoint

-- ── 2. เพิ่มคอลัมน์พร้อม backfill แล้วถอด DEFAULT ทิ้ง ────────────────────────
ALTER TABLE "department" ADD COLUMN "companyCode" varchar(20) NOT NULL DEFAULT 'UBA';--> statement-breakpoint
ALTER TABLE "department" ALTER COLUMN "companyCode" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "employee" ADD COLUMN "ownerCodeMig" integer;--> statement-breakpoint

-- ── 3. FK + index ───────────────────────────────────────────────────────────
-- ไม่ cascade: ลบบริษัทที่ยังมีแผนกอยู่ไม่ได้ (หลักเดียวกับ purchase_order/grpo/asset)
ALTER TABLE "department" ADD CONSTRAINT "fk_department_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_department_company_code" ON "department" USING btree ("companyCode");--> statement-breakpoint
CREATE INDEX "idx_employee_owner_code_mig" ON "employee" USING btree ("ownerCodeMig");--> statement-breakpoint

-- ── 4. คีย์ธรรมชาติชุดใหม่ — ผูกบริษัทเข้าไปด้วย ─────────────────────────────
ALTER TABLE "department" ADD CONSTRAINT "uq_department_hr_id" UNIQUE("companyCode","departmentId");--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "uq_department_name" UNIQUE("companyCode","name");--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "uq_employee_owner_code_mig" UNIQUE("ownerCodeMig");
