ALTER TABLE "purchase_order" RENAME COLUMN "requesterName" TO "ownerPrName";--> statement-breakpoint
ALTER TABLE "purchase_order" RENAME COLUMN "requesterId" TO "ownerPrId";--> statement-breakpoint
ALTER TABLE "purchase_order" DROP CONSTRAINT "fk_purchase_order_requester";
--> statement-breakpoint
DROP INDEX "idx_purchase_order_requester_id";--> statement-breakpoint
ALTER TABLE "asset_request" ADD COLUMN "submittedBy" integer;--> statement-breakpoint
ALTER TABLE "asset_request" ADD COLUMN "notifiedAt" timestamp;--> statement-breakpoint
ALTER TABLE "asset_request" ADD COLUMN "notifyError" varchar(500);--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "fk_purchase_order_owner_pr" FOREIGN KEY ("ownerPrId") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_request" ADD CONSTRAINT "fk_asset_request_submitted_by" FOREIGN KEY ("submittedBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_purchase_order_owner_pr_id" ON "purchase_order" USING btree ("ownerPrId");--> statement-breakpoint
CREATE INDEX "idx_asset_request_submitted_by" ON "asset_request" USING btree ("submittedBy");