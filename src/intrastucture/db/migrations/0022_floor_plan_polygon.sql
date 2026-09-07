ALTER TABLE "asset_sub_location" ADD COLUMN "planKey" varchar(50);--> statement-breakpoint
ALTER TABLE "asset_sub_location" ADD COLUMN "polygon" jsonb;--> statement-breakpoint
ALTER TABLE "asset_sub_location" ADD CONSTRAINT "ck_asset_sub_location_polygon_needs_plan" CHECK ("asset_sub_location"."polygon" IS NULL OR "asset_sub_location"."planKey" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "asset_sub_location" ADD CONSTRAINT "ck_asset_sub_location_polygon_shape" CHECK ("asset_sub_location"."polygon" IS NULL OR (
            jsonb_typeof("asset_sub_location"."polygon") = 'array'
            AND jsonb_array_length("asset_sub_location"."polygon") >= 3
            AND NOT "asset_sub_location"."polygon" @? 'strict $[*] ? (@.type() != "array" || @.size() != 2)'
            AND NOT "asset_sub_location"."polygon" @? 'strict $[*][*] ? (@.type() != "number" || @ < 0 || @ > 1)'
          ));