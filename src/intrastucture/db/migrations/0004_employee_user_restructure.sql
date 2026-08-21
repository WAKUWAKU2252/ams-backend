ALTER TABLE "department" RENAME COLUMN "costCenter" TO "departmentId";--> statement-breakpoint
ALTER TABLE "department" DROP CONSTRAINT "uq_department_cost_center";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "employee_id_seq" OWNED BY "employee"."id";--> statement-breakpoint
SELECT setval('employee_id_seq', COALESCE((SELECT MAX("id") FROM "employee"), 0) + 1, false);--> statement-breakpoint
ALTER TABLE "employee" ALTER COLUMN "id" SET DEFAULT nextval('employee_id_seq');--> statement-breakpoint
ALTER TABLE "employee" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN "ownerCode" integer;--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN "empId" integer;--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN "firstName" varchar(100);--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN "lastName" varchar(100);--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN "firstNameEn" varchar(100);--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN "lastNameEn" varchar(100);--> statement-breakpoint
CREATE INDEX "idx_employee_owner_code" ON "employee" USING btree ("ownerCode");--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "firstName";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "lastName";--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "uq_department_hr_id" UNIQUE("departmentId");--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "uq_employee_owner_code" UNIQUE("ownerCode");--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "uq_employee_emp_id" UNIQUE("empId");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "uq_user_employee" UNIQUE("employeeId");
