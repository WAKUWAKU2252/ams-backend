ALTER TABLE "asset" ADD COLUMN "registeredAt" timestamp;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "registeredBy" integer;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "fk_asset_registered_by" FOREIGN KEY ("registeredBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;