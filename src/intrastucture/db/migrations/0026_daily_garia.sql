-- ═══════════════════════════════════════════════════════════════════════════
-- 0026 — ปิดงาน multi-company: บังคับแผนกให้ตรงบริษัท + เก็บคอลัมน์ ownerCode เดิมทิ้ง
--
-- รวมสองเรื่องไว้ใบเดียวตามกติกาโปรเจกต์ (รวม schema change ไม่ generate ทีละใบ)
-- ทั้งคู่ยังไม่เคยถูก apply จึงยุบรวมได้โดยไม่กระทบฐานที่ไหน
--
-- ═══ 1. asset.departmentId ต้องเป็นแผนกของบริษัทเดียวกับตัวชิ้น ═══
--
-- fk_asset_department เปลี่ยนจาก (departmentId) เดี่ยว เป็นคีย์คู่
-- (departmentId, companyCode) → department(id, companyCode)
--
-- ก่อนหน้านี้ไม่มีอะไรบังคับให้ asset.companyCode กับ department.companyCode ตรงกัน
-- ของ UBP จึงชี้แผนกของ UBA ได้เงียบ ๆ ผลที่ตามมาไม่ใช่แค่ "ข้อมูลปนกัน":
--
--   1. ตารางสรุปรายแผนกบน dashboard ต้องเลือกอย่างใดอย่างหนึ่งระหว่าง
--      "กรองบริษัทให้ถูก" กับ "sum(byDepartment) กระทบกับ totals"
--      (เจอจริงตอนทำ filter — summarizeByDepartment เคยต้องเขียน OR เผื่อกรณีนี้ไว้
--       และเอาออกได้เพราะ FK ตัวนี้ทำให้สาขานั้นเข้าไม่ถึงแล้ว)
--   2. รายงานรายแผนกของแต่ละบริษัทจะนับของบริษัทอื่นปนเข้ามาโดยไม่มีอะไรฟ้อง
--
-- แพทเทิร์นเดียวกับ fk_asset_grpo_line, fk_asset_image และ employee_company —
-- ทำให้ค่าที่ไม่ควรเป็นไปได้ insert ไม่ผ่านตั้งแต่ DB ไม่ใช่หวังให้ service จำได้
--
-- ตรวจ ams_db ก่อน generate (2026-09-02): asset ที่ผูกแผนกข้ามบริษัท 0 แถว ·
-- UBA→UBA 2,782 แถว · ไม่ระบุแผนก 2 แถว (NULL ผ่านตามกติกา MATCH SIMPLE ของ pg)
--
-- ⚠️ ถ้า apply แล้วล้มด้วย "violates foreign key constraint" แปลว่ามีแถวข้ามบริษัท
--    เกิดขึ้นหลังวันที่ตรวจ — หาด้วยคิวรีนี้ก่อนแก้ (read-only):
--      SELECT a.id, a."companyCode", a."departmentId", d."companyCode" AS dept_company
--      FROM asset a JOIN department d ON d.id = a."departmentId"
--      WHERE d."companyCode" <> a."companyCode" LIMIT 100;
--    อย่าแก้ด้วยการถอด constraint ทิ้ง — ให้ย้ายของไปแผนกที่ถูกบริษัทแทน
--
-- ═══ 2. ลบ employee.ownerCodeUba / ownerCodeUbp / ownerCodeMig ═══
--
-- สามคอลัมน์นี้ถูกยุบเป็นแถวใน employee_company ตั้งแต่ 0025 และไม่มีโค้ดไหนอ่านหรือ
-- เขียนมันแล้ว (ownerCodeColumn() ถูกแทนด้วย ownerCodeMap() · user.service และสคริปต์
-- import เขียนลง employee_company แทน · employee-ubp.ts โยน error ก่อนถึงบรรทัดที่อ้างถึง)
--
-- ⚠️ ก่อนกดต้องยืนยันว่า employee_company มีครบแล้ว (read-only):
--      SELECT "companyCode", count(*), count("ownerCode")
--      FROM employee_company GROUP BY 1 ORDER BY 1;
--    ตรวจแล้ว 2026-09-02: UBA 264/264 · UBP 265/265 · MIG 20/20 ครบทุกบริษัท
--
-- ★ ลบแล้วกู้จากฐานนี้ไม่ได้ — ถ้าต้องการค่าเดิมต้องดึงจาก OHEM ของ SAP ใหม่
--   (ซึ่งเป็นแหล่งความจริงอยู่แล้ว ค่าในคอลัมน์นี้ก็คัดลอกมาจากที่นั่น)
--
-- คีย์ที่มาแทน: uq_employee_company_owner_code (companyCode, ownerCode)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "employee" DROP CONSTRAINT "uq_employee_owner_code_uba";--> statement-breakpoint
ALTER TABLE "employee" DROP CONSTRAINT "uq_employee_owner_code_ubp";--> statement-breakpoint
ALTER TABLE "employee" DROP CONSTRAINT "uq_employee_owner_code_mig";--> statement-breakpoint
ALTER TABLE "asset" DROP CONSTRAINT "fk_asset_department";
--> statement-breakpoint
DROP INDEX "idx_employee_owner_code_uba";--> statement-breakpoint
DROP INDEX "idx_employee_owner_code_ubp";--> statement-breakpoint
DROP INDEX "idx_employee_owner_code_mig";--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_department" FOREIGN KEY ("departmentId","companyCode") REFERENCES "public"."department"("id","companyCode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" DROP COLUMN "ownerCodeUba";--> statement-breakpoint
ALTER TABLE "employee" DROP COLUMN "ownerCodeUbp";--> statement-breakpoint
ALTER TABLE "employee" DROP COLUMN "ownerCodeMig";