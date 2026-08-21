ALTER TABLE "asset_request" ADD COLUMN "completeNotifiedAt" timestamp;--> statement-breakpoint
ALTER TABLE "asset_request" ADD COLUMN "completeNotifyError" varchar(500);--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "ck_asset_registered_needs_number" CHECK ("asset"."lifecycle" <> 'REGISTERED' OR "asset"."assetNumber" IS NOT NULL);