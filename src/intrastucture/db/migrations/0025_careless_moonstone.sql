-- ═══════════════════════════════════════════════════════════════════════════
-- 0025 — employee_company: "คนคนนี้ ในบริษัทนี้ คือใคร อยู่แผนกไหน"
--
-- ⚠️ ไฟล์นี้ถูกเรียงลำดับใหม่ + เติม backfill ด้วยมือ ไม่ใช่ผลดิบจาก drizzle-kit
--    ผลดิบวาง `uq_department_id_company` ไว้บรรทัด**สุดท้าย** ทั้งที่ FK คู่
--    (departmentId, companyCode) ต้องการมันก่อน → ล้มด้วย
--    "there is no unique constraint matching given keys for referenced table"
--
-- ทั้งไฟล์รันในทรานแซกชันเดียว (drizzle migrator ครอบให้) — พังกลางทาง rollback ทั้งชุด
--
-- ── ปัญหาที่แก้ ────────────────────────────────────────────────────────────
--
-- เส้นทางหาผู้อนุมัติคือ  PO.ownerPrId → employee.departmentId → department.managerId
-- ขั้นแรกรู้จักบริษัท แต่ขั้นที่สองไม่รู้ — employee.departmentId มีค่าเดียวต่อคน
-- ขณะที่ department กลายเป็นของบริษัทไปแล้วตั้งแต่ 0024
--
-- วัดจาก ams_db จริงเมื่อ 2026-09-02:
--   241 จาก 288 คนที่มีตัวตนใน SAP อยู่สองบริษัท (84%)
--   พนักงานทั้ง 394 คนผูกกับแผนกของ UBA ทั้งหมด
-- ผลคือ PO ของ UBP/MIG ไม่ว่าใครเปิด ก็ไต่ไปจบที่หัวหน้าฝั่ง UBA เสมอ
-- = การ์ดขออนุมัติใน Teams วิ่งไปหาคนผิด ซึ่งส่งออกไปแล้วเรียกคืนไม่ได้
--
-- การย้าย employee.departmentId ให้ชี้บริษัทตัวเองแก้ได้แค่ 47 คนที่อยู่บริษัทเดียว
-- อีก 241 คนไม่มีคำตอบเดียวที่ถูก จึงต้องเป็นตารางแยก
--
-- ── ยังไม่ลบ ownerCodeUba/Ubp/Mig ในใบนี้ ─────────────────────────────────
--
-- สามคอลัมน์นั้นถูกยุบมาเป็นแถวในตารางใหม่แล้ว และ **ไม่มีโค้ดไหนอ่านมันอีก**
-- (ownerCodeColumn() ถูกแทนด้วย ownerCodeMap() ที่อ่าน employee_company)
-- แต่คงไว้ก่อนหนึ่งรอบเพื่อให้ย้อนกลับได้ถ้า backfill เพี้ยน — ลบใน migration ถัดไป
-- หลังยืนยันว่า sync ของ UBA ยังทำงานปกติ
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ปลายทางของ composite FK (ต้องมาก่อน CREATE TABLE) ────────────────────
ALTER TABLE "department" ADD CONSTRAINT "uq_department_id_company" UNIQUE("id","companyCode");--> statement-breakpoint

-- ── 2. ตารางใหม่ ────────────────────────────────────────────────────────────
CREATE TABLE "employee_company" (
	"employeeId" integer NOT NULL,
	"companyCode" varchar(20) NOT NULL,
	"ownerCode" integer,
	"departmentId" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pk_employee_company" PRIMARY KEY("employeeId","companyCode"),
	CONSTRAINT "uq_employee_company_owner_code" UNIQUE("companyCode","ownerCode")
);
--> statement-breakpoint

ALTER TABLE "employee_company" ADD CONSTRAINT "fk_employee_company_employee" FOREIGN KEY ("employeeId") REFERENCES "public"."employee"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_company" ADD CONSTRAINT "fk_employee_company_company" FOREIGN KEY ("companyCode") REFERENCES "public"."company"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ★ FK คู่ — แผนกที่ผูกไว้ต้องเป็นของบริษัทเดียวกับแถวนี้ ยัดข้ามบริษัท DB ปฏิเสธเอง
ALTER TABLE "employee_company" ADD CONSTRAINT "fk_employee_company_department" FOREIGN KEY ("departmentId","companyCode") REFERENCES "public"."department"("id","companyCode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "idx_employee_company_owner" ON "employee_company" USING btree ("companyCode","ownerCode");--> statement-breakpoint
CREATE INDEX "idx_employee_company_department" ON "employee_company" USING btree ("departmentId");--> statement-breakpoint

-- ── 3. backfill: UBA ────────────────────────────────────────────────────────
--
-- ยกแผนกเดิมมาได้เฉพาะคนที่ employee.departmentId ชี้แผนกของ UBA จริง ๆ
--
-- ⚠️ ไม่ใช่ทุกคน: มีพนักงาน 3 คนที่สังกัดแผนก 'บริหารโรงงาน-แผนก R&T NON BOI'
--    ซึ่งเป็นแผนกรหัส 331 ของ **UBP** (ยืนยันจาก OUDP ของ SBO_PRD_UBP)
--
--    ★ ไม่มีใครย้ายแผนกให้พวกเขา — พวกเขาอยู่แผนกนี้มาตลอด สิ่งที่เปลี่ยนคือ "แถว"
--      ที่เขาชี้: แผนกนี้เคยถูกสร้างไว้ตอน import UBP รอบแรกโดยยังไม่มีคอลัมน์
--      companyCode แล้ว backfill ของ 0024 เดาให้เป็น UBA (ของเดิมทั้งฐานเป็น UBA)
--      พอ import ชุด UBP เข้ามาจริงจึงมีแถวที่ถูกต้อง (companyCode = UBP, รหัส 331)
--      แล้วแถวเดาผิดถูกยุบเข้าแถวที่ถูก
--
--    พวกเขายังมี ownerCodeUba = มีตัวตนในฐาน UBA ด้วยจริง เราแค่ไม่รู้ว่าเขาอยู่
--    แผนกไหน "ในฝั่ง UBA" ซึ่งเป็นคนละคำถามกับแผนกที่เขาสังกัดอยู่จริง
--
-- ★ CASE ตรงนี้จึงไม่ใช่การเลี่ยง FK แต่เป็นการบันทึกความจริง: ตัวตนฝั่ง UBA มีอยู่
--   (ownerCode ยังเก็บ) แต่แผนกยังไม่รู้ (NULL) — หลักเดียวกับฝั่ง UBP ข้างล่าง
--   ถ้ายัด departmentId ของ UBP ลงแถว UBA คือการบอกว่าเขาอยู่แผนกของอีกบริษัท
--   ซึ่ง FK คู่ปฏิเสธถูกแล้ว (เจอจริงตอน apply ครั้งแรก — migration rollback ทั้งใบ)
--
-- ผลของ NULL: คนสามคนนี้เปิด PO ฝั่ง UBA แล้วจะส่งคำขอไม่ได้จนกว่าจะมีคนระบุแผนก
-- ซึ่งดังและแก้ได้ ต่างจากการเดาแผนกให้แล้วส่งการ์ดไปหาหัวหน้าผิดคน
INSERT INTO employee_company ("employeeId", "companyCode", "ownerCode", "departmentId")
SELECT e.id, 'UBA', e."ownerCodeUba",
       CASE WHEN d."companyCode" = 'UBA' THEN e."departmentId" ELSE NULL END
FROM employee e
LEFT JOIN department d ON d.id = e."departmentId"
WHERE e."ownerCodeUba" IS NOT NULL;--> statement-breakpoint

-- ── 4. backfill: UBP — ownerCode ยกมาได้ แต่แผนกต้องเป็น NULL ────────────────
--
-- ★ ห้ามใส่ employee.departmentId ลงไป: มันคือแผนกของ UBA ทั้งหมด ใส่แล้วคือเขียน
--   บั๊กเดิมลงตารางใหม่ (และ FK คู่จะปฏิเสธอยู่แล้วเพราะแผนกนั้นเป็นของ UBA)
--
-- NULL = "รู้ว่ามีตัวตนใน UBP แต่ยังไม่รู้ว่าอยู่แผนกไหน" ซึ่งเป็นความจริง ณ ตอนนี้
-- ผลคือส่งคำขอของ UBP ไม่ได้จนกว่าจะเติม — เติมด้วย docs/import-employee-company-ubp.sql
INSERT INTO employee_company ("employeeId", "companyCode", "ownerCode", "departmentId")
SELECT id, 'UBP', "ownerCodeUbp", NULL
FROM employee
WHERE "ownerCodeUbp" IS NOT NULL;--> statement-breakpoint

-- ── 5. MIG ยังไม่มีอะไรให้ backfill ─────────────────────────────────────────
-- employee.ownerCodeMig ว่างทั้งตาราง (ยังไม่ได้นำเข้า) — แถวของ MIG จะถูกสร้างโดย
-- docs/import-employee-mig.sql ซึ่งเขียนลง employee_company ตรง ๆ
