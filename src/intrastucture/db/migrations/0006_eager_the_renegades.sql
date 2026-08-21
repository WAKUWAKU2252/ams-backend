
ALTER TABLE "employee" ALTER COLUMN "empId" SET DATA TYPE varchar(20) USING "empId"::varchar(20);--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "uq_department_name" UNIQUE("name");
