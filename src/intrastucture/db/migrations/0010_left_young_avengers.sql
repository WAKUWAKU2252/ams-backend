CREATE TYPE "public"."asset_origin" AS ENUM('PO_FLOW', 'SAP_LEGACY');--> statement-breakpoint
CREATE TABLE "sap_asset_sync" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"lastUpdateDate" timestamp,
	"backfillCursor" timestamp,
	"backfillFloor" timestamp,
	"mode" "sync_mode" DEFAULT 'BACKFILL' NOT NULL,
	"lastRunAt" timestamp,
	"lastStatus" "sync_status" DEFAULT 'IDLE' NOT NULL,
	"lastError" text,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_sap_asset_sync_singleton" CHECK ("sap_asset_sync"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sap_asset_sync_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"trigger" "sync_trigger" NOT NULL,
	"triggeredBy" integer,
	"mode" "sync_mode" NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"finishedAt" timestamp,
	"watermarkFrom" timestamp,
	"watermarkTo" timestamp,
	"rowsHeader" integer DEFAULT 0 NOT NULL,
	"rowsLine" integer DEFAULT 0 NOT NULL,
	"rowsSkipped" integer DEFAULT 0 NOT NULL,
	"sapMs" integer,
	"txMs" integer,
	"status" "sync_status" NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "requestId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "grpoLineId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "poItemId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "unitNo" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "acquisitionCost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "createdBy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "updatedBy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "origin" "asset_origin" DEFAULT 'PO_FLOW' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sap_asset_sync_event_started_at" ON "sap_asset_sync_event" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "idx_sap_asset_sync_event_status" ON "sap_asset_sync_event" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_asset_origin" ON "asset" USING btree ("origin");--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "ck_asset_origin_chain" CHECK (("asset"."origin" = 'PO_FLOW'
             AND "asset"."requestId" IS NOT NULL
             AND "asset"."grpoLineId" IS NOT NULL
             AND "asset"."poItemId" IS NOT NULL
             AND "asset"."unitNo" IS NOT NULL
             AND "asset"."acquisitionCost" IS NOT NULL
             AND "asset"."createdBy" IS NOT NULL
             AND "asset"."updatedBy" IS NOT NULL)
          OR ("asset"."origin" = 'SAP_LEGACY'
             AND "asset"."requestId" IS NULL
             AND "asset"."grpoLineId" IS NULL
             AND "asset"."poItemId" IS NULL
             AND "asset"."unitNo" IS NULL
             AND "asset"."assetNumber" IS NOT NULL));--> statement-breakpoint
-- ที่ตั้งตั้งต้นของสินทรัพย์เก่าที่ดึงมาจาก SAP — asset.locationId เป็น NOT NULL
-- และ connector ยังไม่รู้ว่าของจริงวางอยู่ห้องไหน (ดู UNASSIGNED_LOCATION ใน asset.connector.ts)
--
-- อยู่ใน migration ไม่ใช่สคริปต์ seed แยก เพราะ connector พึ่งพาแถวนี้จริง ๆ ถ้าไม่มีมันจะ
-- ล้มทั้งรอบ — ของที่โค้ดต้องมีถึงจะทำงานได้ ต้องมาพร้อมกับ migration ที่ทำให้โค้ดนั้นใช้ได้
-- ON CONFLICT: รันซ้ำได้ และไม่ทับแถวที่ผู้ใช้อาจตั้งชื่อนี้ไว้เองอยู่แล้ว
INSERT INTO "asset_location" ("code", "name")
VALUES ('UNASSIGNED', 'ยังไม่ระบุที่ตั้ง')
ON CONFLICT ON CONSTRAINT "uq_asset_location_name" DO NOTHING;