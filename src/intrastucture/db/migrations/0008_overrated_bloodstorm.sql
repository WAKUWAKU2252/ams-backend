ALTER TABLE "asset" ADD COLUMN "departmentId" integer;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_department" FOREIGN KEY ("departmentId") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_asset_department_id" ON "asset" USING btree ("departmentId");