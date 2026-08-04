CREATE EXTENSION IF NOT EXISTS "uuid-ossp";--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REGISTERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."asset_lifecycle" AS ENUM('DRAFT', 'REGISTERED');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('Active', 'Inactive', 'Under Maintenance', 'Lost', 'Disposed');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('INVOICE', 'ASSET_IMG');--> statement-breakpoint
CREATE TABLE "asset_request_line" (
	"requestId" integer NOT NULL,
	"grpoLineId" uuid NOT NULL,
	"declaredQty" integer NOT NULL,
	"reason" varchar(500) NOT NULL,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" integer NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pk_asset_request_line" PRIMARY KEY("requestId","grpoLineId"),
	CONSTRAINT "ck_asset_request_line_declared_qty" CHECK ("asset_request_line"."declaredQty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "asset_request_opener" (
	"requestId" integer NOT NULL,
	"userId" integer NOT NULL,
	"firstOpenedAt" timestamp DEFAULT now() NOT NULL,
	"lastOpenedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pk_asset_request_opener" PRIMARY KEY("requestId","userId")
);
--> statement-breakpoint
CREATE TABLE "asset_request" (
	"id" serial PRIMARY KEY NOT NULL,
	"poNumber" varchar(50) NOT NULL,
	"status" "request_status" DEFAULT 'DRAFT' NOT NULL,
	"submittedAt" timestamp,
	"approvedBy" integer,
	"approvedAt" timestamp,
	"rejectedBy" integer,
	"rejectedAt" timestamp,
	"rejectReason" varchar(500),
	"completeDate" timestamp,
	"createdBy" integer NOT NULL,
	"assignedManagerId" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"deletedBy" integer
);
--> statement-breakpoint
CREATE TABLE "asset" (
	"id" serial PRIMARY KEY NOT NULL,
	"requestId" integer NOT NULL,
	"grpoLineId" uuid NOT NULL,
	"poItemId" uuid NOT NULL,
	"unitNo" integer NOT NULL,
	"acquisitionCost" numeric NOT NULL,
	"isSplitItem" boolean DEFAULT false NOT NULL,
	"assetNumber" varchar(100),
	"description" varchar(100),
	"serialNumber" varchar(100),
	"categoryId" integer NOT NULL,
	"assetClass" varchar(50),
	"qrCode" varchar(255),
	"lifecycle" "asset_lifecycle" DEFAULT 'DRAFT' NOT NULL,
	"status" "asset_status" DEFAULT 'Active',
	"uomId" integer NOT NULL,
	"employeeId" integer,
	"locationId" integer NOT NULL,
	"subLocationId" integer,
	"warrantyStartDate" timestamp,
	"warrantyEndDate" timestamp,
	"imageId" uuid,
	"imageDocType" "doc_type" GENERATED ALWAYS AS ('ASSET_IMG'::doc_type) STORED,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"createdBy" integer NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" integer NOT NULL,
	"deletedAt" timestamp,
	"deletedBy" integer
);
--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"docType" "doc_type" NOT NULL,
	"originalName" varchar(255) NOT NULL,
	"storedName" varchar(100) NOT NULL,
	"mimeType" varchar(100) NOT NULL,
	"size" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "uq_attachment_id_doc_type" UNIQUE("id","docType")
);
--> statement-breakpoint
CREATE TABLE "grpo" (
	"id" serial PRIMARY KEY NOT NULL,
	"grpoNo" varchar(50) NOT NULL,
	"grpoDate" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grpo_invoice" (
	"grpoId" integer NOT NULL,
	"attachmentId" uuid NOT NULL,
	"attachmentDocType" "doc_type" GENERATED ALWAYS AS ('INVOICE'::doc_type) STORED,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pk_grpo_invoice" PRIMARY KEY("grpoId","attachmentId")
);
--> statement-breakpoint
CREATE TABLE "grpo_line" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"grpoId" integer NOT NULL,
	"poItemId" uuid NOT NULL,
	"receivedQty" integer NOT NULL,
	CONSTRAINT "uq_grpo_line_id_po_item" UNIQUE("id","poItemId")
);
--> statement-breakpoint
CREATE TABLE "migrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"timestamp" bigint NOT NULL,
	"name" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order" (
	"poNumber" varchar(50) PRIMARY KEY NOT NULL,
	"vendorName" varchar(100),
	"poDate" date,
	"requesterName" varchar(100),
	"requesterEmpId" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_item" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"poLine" integer NOT NULL,
	"itemDescription" varchar NOT NULL,
	"quantity" integer NOT NULL,
	"unitPrice" numeric NOT NULL,
	"poNumber" varchar(50) NOT NULL,
	"lineTotal" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_location" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"mapUrl" varchar(500),
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_sub_location" (
	"id" serial PRIMARY KEY NOT NULL,
	"locationId" integer NOT NULL,
	"floor" varchar(100),
	"room" varchar(100),
	"remark" varchar(255),
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_asset_sub_location" UNIQUE("locationId","floor","room")
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_category_name" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "department" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"shortName" varchar(20),
	"costCenter" varchar(100),
	"managerId" integer,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_department_cost_center" UNIQUE("costCenter")
);
--> statement-breakpoint
CREATE TABLE "employee" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"email" varchar(100) NOT NULL,
	"departmentId" integer NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_employee_email" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "uom" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_uom_name" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"description" varchar(255),
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_role_name" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(100) NOT NULL,
	"email" varchar(100),
	"displayName" varchar(100) NOT NULL,
	"firstName" varchar(100),
	"lastName" varchar(100),
	"passwordHash" varchar(255),
	"roleId" integer NOT NULL,
	"employeeId" integer,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "uq_user_username" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "asset_request_line" ADD CONSTRAINT "fk_asset_request_line_request" FOREIGN KEY ("requestId") REFERENCES "public"."asset_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request_line" ADD CONSTRAINT "fk_asset_request_line_grpo_line" FOREIGN KEY ("grpoLineId") REFERENCES "public"."grpo_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request_line" ADD CONSTRAINT "fk_asset_request_line_created_by" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request_line" ADD CONSTRAINT "fk_asset_request_line_updated_by" FOREIGN KEY ("updatedBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request_opener" ADD CONSTRAINT "fk_asset_request_opener_request" FOREIGN KEY ("requestId") REFERENCES "public"."asset_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request_opener" ADD CONSTRAINT "fk_asset_request_opener_user" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request" ADD CONSTRAINT "fk_asset_request_po_number" FOREIGN KEY ("poNumber") REFERENCES "public"."purchase_order"("poNumber") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request" ADD CONSTRAINT "fk_asset_request_created_by" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request" ADD CONSTRAINT "fk_asset_request_approved_by" FOREIGN KEY ("approvedBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request" ADD CONSTRAINT "fk_asset_request_rejected_by" FOREIGN KEY ("rejectedBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request" ADD CONSTRAINT "fk_asset_request_deleted_by" FOREIGN KEY ("deletedBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request" ADD CONSTRAINT "fk_asset_request_assigned_manager" FOREIGN KEY ("assignedManagerId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_request" FOREIGN KEY ("requestId") REFERENCES "public"."asset_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_grpo_line" FOREIGN KEY ("grpoLineId","poItemId") REFERENCES "public"."grpo_line"("id","poItemId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_image" FOREIGN KEY ("imageId","imageDocType") REFERENCES "public"."attachment"("id","docType") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_category" FOREIGN KEY ("categoryId") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_uom" FOREIGN KEY ("uomId") REFERENCES "public"."uom"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_location" FOREIGN KEY ("locationId") REFERENCES "public"."asset_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_sub_location" FOREIGN KEY ("subLocationId") REFERENCES "public"."asset_sub_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_employee" FOREIGN KEY ("employeeId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_created_by" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_updated_by" FOREIGN KEY ("updatedBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_deleted_by" FOREIGN KEY ("deletedBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grpo_invoice" ADD CONSTRAINT "fk_grpo_invoice_grpo" FOREIGN KEY ("grpoId") REFERENCES "public"."grpo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grpo_invoice" ADD CONSTRAINT "fk_grpo_invoice_attachment" FOREIGN KEY ("attachmentId","attachmentDocType") REFERENCES "public"."attachment"("id","docType") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grpo_line" ADD CONSTRAINT "fk_grpo_line_grpo" FOREIGN KEY ("grpoId") REFERENCES "public"."grpo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grpo_line" ADD CONSTRAINT "fk_grpo_line_po_item" FOREIGN KEY ("poItemId") REFERENCES "public"."purchase_order_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "fk_purchase_order_requester_emp" FOREIGN KEY ("requesterEmpId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "fk_purchase_order_item_po_number" FOREIGN KEY ("poNumber") REFERENCES "public"."purchase_order"("poNumber") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_sub_location" ADD CONSTRAINT "fk_asset_sub_location_location" FOREIGN KEY ("locationId") REFERENCES "public"."asset_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_managerId_employee_id_fk" FOREIGN KEY ("managerId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "fk_employee_department" FOREIGN KEY ("departmentId") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "fk_user_role" FOREIGN KEY ("roleId") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "fk_user_employee" FOREIGN KEY ("employeeId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_asset_request_line_grpo_line_id" ON "asset_request_line" USING btree ("grpoLineId");--> statement-breakpoint
CREATE INDEX "idx_asset_request_line_created_by" ON "asset_request_line" USING btree ("createdBy");--> statement-breakpoint
CREATE INDEX "idx_asset_request_line_updated_by" ON "asset_request_line" USING btree ("updatedBy");--> statement-breakpoint
CREATE INDEX "idx_asset_request_opener_user_id" ON "asset_request_opener" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_asset_request_po_number" ON "asset_request" USING btree ("poNumber");--> statement-breakpoint
CREATE INDEX "idx_asset_request_assigned_manager_id" ON "asset_request" USING btree ("assignedManagerId");--> statement-breakpoint
CREATE INDEX "idx_asset_request_created_by" ON "asset_request" USING btree ("createdBy");--> statement-breakpoint
CREATE INDEX "idx_asset_request_approved_by" ON "asset_request" USING btree ("approvedBy");--> statement-breakpoint
CREATE INDEX "idx_asset_request_rejected_by" ON "asset_request" USING btree ("rejectedBy");--> statement-breakpoint
CREATE INDEX "idx_asset_request_deleted_by" ON "asset_request" USING btree ("deletedBy");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_asset_request_active" ON "asset_request" USING btree ("poNumber") WHERE "asset_request"."status" NOT IN ('REGISTERED', 'CANCELLED') AND "asset_request"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_asset_category_id" ON "asset" USING btree ("categoryId");--> statement-breakpoint
CREATE INDEX "idx_asset_location_id" ON "asset" USING btree ("locationId");--> statement-breakpoint
CREATE INDEX "idx_asset_employee_id" ON "asset" USING btree ("employeeId");--> statement-breakpoint
CREATE INDEX "idx_asset_request_id" ON "asset" USING btree ("requestId");--> statement-breakpoint
CREATE INDEX "idx_asset_grpo_line_id" ON "asset" USING btree ("grpoLineId");--> statement-breakpoint
CREATE INDEX "idx_asset_created_by" ON "asset" USING btree ("createdBy");--> statement-breakpoint
CREATE INDEX "idx_asset_updated_by" ON "asset" USING btree ("updatedBy");--> statement-breakpoint
CREATE INDEX "idx_asset_deleted_by" ON "asset" USING btree ("deletedBy");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_asset_number" ON "asset" USING btree ("assetNumber");--> statement-breakpoint
CREATE INDEX "idx_asset_po_item_id" ON "asset" USING btree ("poItemId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_asset_po_item_unit_no" ON "asset" USING btree ("poItemId","unitNo") WHERE "asset"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_asset_image" ON "asset" USING btree ("imageId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_grpo_no" ON "grpo" USING btree ("grpoNo");--> statement-breakpoint
CREATE INDEX "idx_grpo_invoice_attachment_id" ON "grpo_invoice" USING btree ("attachmentId");--> statement-breakpoint
CREATE INDEX "idx_grpo_line_grpo_id" ON "grpo_line" USING btree ("grpoId");--> statement-breakpoint
CREATE INDEX "idx_grpo_line_po_item_id" ON "grpo_line" USING btree ("poItemId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_grpo_line" ON "grpo_line" USING btree ("grpoId","poItemId");--> statement-breakpoint
CREATE INDEX "idx_purchase_order_requester_emp_id" ON "purchase_order" USING btree ("requesterEmpId");--> statement-breakpoint
CREATE INDEX "idx_purchase_order_item_po_number" ON "purchase_order_item" USING btree ("poNumber");--> statement-breakpoint
CREATE INDEX "idx_asset_sub_location_location_id" ON "asset_sub_location" USING btree ("locationId");--> statement-breakpoint
CREATE INDEX "idx_department_manager_id" ON "department" USING btree ("managerId");--> statement-breakpoint
CREATE INDEX "idx_employee_department_id" ON "employee" USING btree ("departmentId");--> statement-breakpoint
CREATE INDEX "idx_user_role_id" ON "user" USING btree ("roleId");--> statement-breakpoint
CREATE INDEX "idx_user_employee_id" ON "user" USING btree ("employeeId");