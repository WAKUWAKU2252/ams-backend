ALTER TABLE "purchase_order_item" ADD COLUMN "itemCode" varchar(50);--> statement-breakpoint
ALTER TABLE "purchase_order_item" ADD COLUMN "itemGroup" integer;--> statement-breakpoint
CREATE INDEX "idx_purchase_order_item_item_code" ON "purchase_order_item" USING btree ("itemCode");