CREATE TABLE "asset_accounting" (
	"assetId" integer PRIMARY KEY NOT NULL,
	"fiscalYear" integer NOT NULL,
	"bookedCost" numeric,
	"bookedCostHistorical" numeric,
	"accumulatedDepreciation" numeric,
	"salvageValue" numeric,
	"usefulLifeMonths" integer,
	"remainingLifeMonths" integer,
	"depreciationMethod" varchar(50),
	"depreciationStart" date,
	"depreciationEnd" date,
	"syncedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sap_asset_unknown_number" (
	"assetId" integer PRIMARY KEY NOT NULL,
	"assetNumber" varchar(50) NOT NULL,
	"poNumber" varchar(50),
	"firstSeenAt" timestamp DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_accounting" ADD CONSTRAINT "fk_asset_accounting_asset" FOREIGN KEY ("assetId") REFERENCES "public"."asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_asset_unknown_number" ADD CONSTRAINT "fk_sap_asset_unknown_number_asset" FOREIGN KEY ("assetId") REFERENCES "public"."asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_asset_accounting_fiscal_year" ON "asset_accounting" USING btree ("fiscalYear");--> statement-breakpoint
CREATE INDEX "idx_sap_asset_unknown_number_first_seen" ON "sap_asset_unknown_number" USING btree ("firstSeenAt");--> statement-breakpoint
ALTER TABLE "asset" DROP COLUMN "usefulLifeYear";--> statement-breakpoint
ALTER TABLE "asset" DROP COLUMN "salvageValue";--> statement-breakpoint
ALTER TABLE "asset" DROP COLUMN "accumulatedDepreciation";--> statement-breakpoint
ALTER TABLE "asset" DROP COLUMN "netBookValue";