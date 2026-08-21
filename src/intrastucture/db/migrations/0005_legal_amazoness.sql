-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — purchase_order: requesterEmpId -> requesterId + เพิ่ม docStatus
--        employee: เรียงคอลัมน์ใหม่ + ถอด name
--        ถอดตาราง user_email (อีเมลเหลือแหล่งเดียวที่ employee.email)
--
-- ⚠️ ไฟล์นี้ไม่ใช่ผลดิบจาก drizzle-kit generate — แก้สองจุดโดยตั้งใจ:
--
--   1) เรื่องเปลี่ยนชื่อคอลัมน์ drizzle มองเป็น "ลบตัวเก่า + เพิ่มตัวใหม่" ซึ่ง
--      ทำให้ requesterEmpId ที่ sync สะสมมาหายทั้งคอลัมน์ — เปลี่ยนเป็น RENAME
--      ที่รักษาข้อมูลและตัว constraint เดิมไว้
--
--   2) PostgreSQL ไม่มีคำสั่งย้ายลำดับคอลัมน์ (ไม่มี ALTER COLUMN ... POSITION)
--      การจัดลำดับ employee ใหม่ทำได้ทางเดียวคือสร้างตารางใหม่แล้วย้ายข้อมูล
--      drizzle มองไม่เห็นความต้องการนี้ มันออกให้แค่ DROP COLUMN "name"
--
-- ทั้งไฟล์รันในทรานแซกชันเดียว (drizzle migrator ครอบให้) — พังกลางทาง = rollback หมด
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1) purchase_order: เปลี่ยนชื่อ requesterEmpId -> requesterId ═══════════
-- RENAME ไม่ใช่ DROP+ADD: คอลัมน์นี้เก็บผลการ resolve OwnerCode -> employee.id
-- ของทุกใบที่ sync มาแล้ว ถ้า drop ทิ้งต้องรอ sync รอบใหม่กวาดใหม่ทั้งหมด
-- และช่วงคาบเกี่ยวนั้นการ route คำขออนุมัติจะหาหัวหน้าไม่เจอทุกใบ
ALTER TABLE "purchase_order" RENAME COLUMN "requesterEmpId" TO "requesterId";--> statement-breakpoint
ALTER TABLE "purchase_order" RENAME CONSTRAINT "fk_purchase_order_requester_emp" TO "fk_purchase_order_requester";--> statement-breakpoint
ALTER INDEX "idx_purchase_order_requester_emp_id" RENAME TO "idx_purchase_order_requester_id";--> statement-breakpoint

-- ═══ 2) purchase_order: เพิ่ม docStatus ═══════════════════════════════════
-- nullable ไม่มี default โดยตั้งใจ: แถวที่ sync มาก่อนหน้านี้ไม่มีใครรู้สถานะจริง
-- ใส่ default 'OPEN' = ใบที่ปิดไปแล้วจะโกหกว่ายังเปิด / NULL = "ยังไม่เคยดึงค่ามา"
CREATE TYPE "public"."po_doc_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "docStatus" "po_doc_status";--> statement-breakpoint

-- ═══ 3) ถอดตาราง user_email ═══════════════════════════════════════════════
-- ⚠️ ทำลายข้อมูล: อีเมลทุกแถวในตารางนี้หายถาวร
-- ถ้ามีอีเมลที่ไม่ได้อยู่ใน employee.email ให้ย้ายก่อนรัน (ดู SELECT ตรวจท้ายไฟล์)
DROP TABLE "user_email" CASCADE;--> statement-breakpoint
DROP TYPE "public"."email_status";--> statement-breakpoint

-- ═══ 4) employee: สร้างตารางใหม่เพื่อจัดลำดับคอลัมน์ + ถอด name ═════════════

-- 4.1 กันข้อมูลชื่อหาย — แถวที่มีแต่ name (ชื่อเต็มก้อนเดียว) ยังไม่เคยแตกลงสองช่อง
--     ต้องแตกก่อนถอด name ทิ้ง ไม่งั้นคนกลุ่มนั้นจะไม่เหลือชื่ออยู่เลย
--     ไม่มีช่องว่างในชื่อ -> strpos คืน 0 -> substring คืนทั้งก้อน -> NULLIF ตัดเป็น NULL
--     (ได้ firstName = ชื่อเต็ม, lastName = NULL ซึ่งถูกต้องกว่าการเดา)
UPDATE "employee"
SET "firstName" = NULLIF(TRIM(split_part("name", ' ', 1)), ''),
    "lastName"  = NULLIF(NULLIF(TRIM(substring("name" FROM strpos("name", ' ') + 1)), ''), TRIM("name"))
WHERE "firstName" IS NULL
  AND "lastName" IS NULL
  AND "name" IS NOT NULL;--> statement-breakpoint

-- 4.2 ตารางใหม่ ลำดับคอลัมน์ตามที่ต้องการ: ชื่อทั้งสี่ช่องมาก่อน ต่อจาก id ทันที
CREATE TABLE "employee_new" (
	"id" serial PRIMARY KEY NOT NULL,
	"firstName" varchar(100),
	"lastName" varchar(100),
	"firstNameEn" varchar(100),
	"lastNameEn" varchar(100),
	"ownerCode" integer,
	"empId" integer,
	"email" varchar(100),
	"departmentId" integer NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- 4.3 ย้ายข้อมูล — ระบุคอลัมน์ทั้งสองฝั่งชัดเจน ไม่พึ่งลำดับ (ลำดับเปลี่ยนไปแล้ว)
--     id ถูกยกมาตามเดิม เพราะ FK 4 ตารางชี้ค่านี้อยู่ ห้ามให้เลขขยับเด็ดขาด
INSERT INTO "employee_new" (
	"id", "firstName", "lastName", "firstNameEn", "lastNameEn",
	"ownerCode", "empId", "email", "departmentId", "isActive", "createdAt", "updatedAt"
)
SELECT
	"id", "firstName", "lastName", "firstNameEn", "lastNameEn",
	"ownerCode", "empId", "email", "departmentId", "isActive", "createdAt", "updatedAt"
FROM "employee";--> statement-breakpoint

-- 4.4 ปลด FK ที่ชี้มาที่ employee.id ก่อน ไม่งั้น DROP TABLE ไม่ผ่าน
--     (fk_purchase_order_requester ใช้ชื่อใหม่แล้ว — ถูกเปลี่ยนไปในขั้นที่ 1)
ALTER TABLE "department" DROP CONSTRAINT "department_managerId_employee_id_fk";--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT "fk_user_employee";--> statement-breakpoint
ALTER TABLE "purchase_order" DROP CONSTRAINT "fk_purchase_order_requester";--> statement-breakpoint
ALTER TABLE "asset" DROP CONSTRAINT "fk_asset_employee";--> statement-breakpoint

-- 4.5 สลับตาราง — DROP ก่อนแล้วค่อย RENAME sequence
--     DROP TABLE ลบ sequence เดิม (employee_id_seq ที่ OWNED BY employee.id) ไปด้วย
--     ชื่อจึงว่างให้ตัวใหม่มาสวมได้ ถ้าสลับลำดับสองบรรทัดนี้จะชนกันเรื่องชื่อซ้ำ
DROP TABLE "employee";--> statement-breakpoint
ALTER TABLE "employee_new" RENAME TO "employee";--> statement-breakpoint
ALTER SEQUENCE "employee_new_id_seq" RENAME TO "employee_id_seq";--> statement-breakpoint
ALTER TABLE "employee" RENAME CONSTRAINT "employee_new_pkey" TO "employee_pkey";--> statement-breakpoint
SELECT setval('employee_id_seq', COALESCE((SELECT MAX("id") FROM "employee"), 0) + 1, false);--> statement-breakpoint

-- 4.6 คืน constraint/index ของ employee เอง (หายไปพร้อมตารางเดิม)
ALTER TABLE "employee" ADD CONSTRAINT "fk_employee_department" FOREIGN KEY ("departmentId") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "uq_employee_email" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "uq_employee_owner_code" UNIQUE("ownerCode");--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "uq_employee_emp_id" UNIQUE("empId");--> statement-breakpoint
CREATE INDEX "idx_employee_department_id" ON "employee" USING btree ("departmentId");--> statement-breakpoint
CREATE INDEX "idx_employee_owner_code" ON "employee" USING btree ("ownerCode");--> statement-breakpoint

-- 4.7 คืน FK ที่ปลดไปใน 4.4 — ชื่อและพฤติกรรมเดิมเป๊ะ (ไม่ cascade ทุกตัว: ประวัติต้องอยู่)
ALTER TABLE "department" ADD CONSTRAINT "department_managerId_employee_id_fk" FOREIGN KEY ("managerId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "fk_user_employee" FOREIGN KEY ("employeeId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "fk_purchase_order_requester" FOREIGN KEY ("requesterId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_employee" FOREIGN KEY ("employeeId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;

-- ═══════════════════════════════════════════════════════════════════════════
-- ตรวจก่อนรันบน server จริง (SELECT ล้วน ไม่แก้อะไร):
--
--   -- อีเมลใน user_email ที่จะหายไปโดยไม่มีที่ไปต่อ (ต้องได้ 0 แถว)
--   SELECT ue."userId", ue.email, u.username
--   FROM user_email ue
--   JOIN "user" u ON u.id = ue."userId"
--   LEFT JOIN employee e ON e.id = u."employeeId"
--   WHERE e.email IS DISTINCT FROM ue.email;
--
--   -- คนที่มีแต่ name ยังไม่มี firstName/lastName (4.1 จะแตกให้)
--   SELECT count(*) FROM employee WHERE "firstName" IS NULL AND "lastName" IS NULL;
--
--   -- จำนวนแถว employee ก่อน/หลังต้องเท่ากัน
--   SELECT count(*) FROM employee;
--
--   -- จำนวน PO ที่ resolve ผู้ขอได้ ก่อน/หลังต้องเท่ากัน (RENAME ไม่ควรทำให้หาย)
--   SELECT count(*) FROM purchase_order WHERE "requesterEmpId" IS NOT NULL;   -- ก่อน
--   SELECT count(*) FROM purchase_order WHERE "requesterId"    IS NOT NULL;   -- หลัง
-- ═══════════════════════════════════════════════════════════════════════════
