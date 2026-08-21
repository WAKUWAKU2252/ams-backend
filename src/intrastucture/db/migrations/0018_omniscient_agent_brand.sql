ALTER TABLE "asset_request" ADD COLUMN "rejectNotifiedAt" timestamp;--> statement-breakpoint
ALTER TABLE "asset_request" ADD COLUMN "rejectNotifyError" varchar(500);