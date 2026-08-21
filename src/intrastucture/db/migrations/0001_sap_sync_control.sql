CREATE TYPE "public"."sync_mode" AS ENUM('BACKFILL', 'INCREMENTAL');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('IDLE', 'RUNNING', 'SUCCESS', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."sync_trigger" AS ENUM('BUTTON', 'SCHEDULED');--> statement-breakpoint
CREATE TABLE "sap_grpo_sync" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"lastUpdateDate" timestamp,
	"lastDocEntry" integer,
	"backfillCursor" timestamp,
	"backfillFloor" timestamp,
	"mode" "sync_mode" DEFAULT 'BACKFILL' NOT NULL,
	"lastRunAt" timestamp,
	"lastStatus" "sync_status" DEFAULT 'IDLE' NOT NULL,
	"lastError" text,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_sap_grpo_sync_singleton" CHECK ("sap_grpo_sync"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sap_grpo_sync_event" (
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
	"status" "sync_status" NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sap_purchase_order_sync" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"lastUpdateDate" timestamp,
	"lastDocEntry" integer,
	"backfillCursor" timestamp,
	"backfillFloor" timestamp,
	"mode" "sync_mode" DEFAULT 'BACKFILL' NOT NULL,
	"lastRunAt" timestamp,
	"lastStatus" "sync_status" DEFAULT 'IDLE' NOT NULL,
	"lastError" text,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_sap_purchase_order_sync_singleton" CHECK ("sap_purchase_order_sync"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sap_purchase_order_sync_event" (
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
	"status" "sync_status" NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "idx_sap_grpo_sync_event_started_at" ON "sap_grpo_sync_event" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "idx_sap_grpo_sync_event_status" ON "sap_grpo_sync_event" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sap_purchase_order_sync_event_started_at" ON "sap_purchase_order_sync_event" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "idx_sap_purchase_order_sync_event_status" ON "sap_purchase_order_sync_event" USING btree ("status");--> statement-breakpoint
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "uq_purchase_order_item_po_line" UNIQUE("poNumber","poLine");