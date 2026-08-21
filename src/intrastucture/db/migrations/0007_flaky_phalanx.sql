ALTER TABLE "asset" ALTER COLUMN "categoryId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "uomId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_location" ADD COLUMN "code" varchar(50) NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_sub_location" ADD COLUMN "code" varchar(50) NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "posX" numeric(6, 5);--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "posY" numeric(6, 5);--> statement-breakpoint
ALTER TABLE "asset_location" ADD CONSTRAINT "uq_asset_location_code" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "asset_sub_location" ADD CONSTRAINT "uq_asset_sub_location_code" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "ck_asset_pos_pair" CHECK (("asset"."posX" IS NULL) = ("asset"."posY" IS NULL));--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "ck_asset_pos_range" CHECK (("asset"."posX" IS NULL OR "asset"."posX" BETWEEN 0 AND 1)
          AND ("asset"."posY" IS NULL OR "asset"."posY" BETWEEN 0 AND 1));--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "ck_asset_pos_needs_sub_location" CHECK ("asset"."posX" IS NULL OR "asset"."subLocationId" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "asset_location" DROP COLUMN "mapUrl";
