CREATE TYPE "public"."grpo_unlink_reason" AS ENUM('NOT_FROM_PO', 'BASE_PO_MISSING', 'PO_LINE_OUT_OF_SCOPE');--> statement-breakpoint
CREATE TABLE "sap_grpo_unlinked" (
	"grpoDocEntry" integer NOT NULL,
	"grpoLineNum" integer NOT NULL,
	"grpoNo" varchar(50) NOT NULL,
	"grpoDate" date,
	"itemCode" varchar(50),
	"itemDescription" varchar,
	"receivedQty" numeric NOT NULL,
	"basePoNumber" varchar(50),
	"baseLine" integer,
	"reason" "grpo_unlink_reason" NOT NULL,
	"sapUpdateDate" timestamp,
	"firstSeenAt" timestamp DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pk_sap_grpo_unlinked" PRIMARY KEY("grpoDocEntry","grpoLineNum")
);
--> statement-breakpoint
ALTER TABLE "grpo_line" ALTER COLUMN "receivedQty" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "purchase_order" ALTER COLUMN "requesterName" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "purchase_order_item" ALTER COLUMN "quantity" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "sap_grpo_sync_event" ADD COLUMN "sapMs" integer;--> statement-breakpoint
ALTER TABLE "sap_grpo_sync_event" ADD COLUMN "txMs" integer;--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync_event" ADD COLUMN "sapMs" integer;--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync_event" ADD COLUMN "txMs" integer;--> statement-breakpoint
CREATE INDEX "idx_sap_grpo_unlinked_reason" ON "sap_grpo_unlinked" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "idx_sap_grpo_unlinked_grpo_no" ON "sap_grpo_unlinked" USING btree ("grpoNo");--> statement-breakpoint
ALTER TABLE "sap_grpo_sync" DROP COLUMN "lastDocEntry";--> statement-breakpoint
ALTER TABLE "sap_purchase_order_sync" DROP COLUMN "lastDocEntry";