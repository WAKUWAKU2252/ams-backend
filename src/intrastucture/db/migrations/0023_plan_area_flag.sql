ALTER TABLE "asset_location" ADD COLUMN "isPlanArea" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- ตั้งค่าให้แถวที่มีอยู่แล้ว (เติมมือ drizzle-kit generate ให้ไม่ได้ มันออกแต่ DDL)
--
-- ยึด "แถวที่มีห้องห้อยอยู่" ไม่ใช่ code LIKE 'UBIS-%' — ตอน 0022 ตึกทั้งสี่ถูกสร้างขึ้นมา
-- เพื่อเป็นที่ห้อยของ asset_sub_location โดยเฉพาะ ส่วน 52 แถวของ SAP ไม่มีห้องสักแถวเดียว
-- เงื่อนไขนี้จึงตรงกับความหมายจริงและไม่ผูกกับ prefix ของชื่อไซต์
--
-- ที่ควรได้: 4 แถว (UBIS-B1, UBIS-B2, UBIS-B3, UBIS-OUT)
UPDATE "asset_location" l
SET "isPlanArea" = true, "updatedAt" = now()
WHERE EXISTS (SELECT 1 FROM "asset_sub_location" sl WHERE sl."locationId" = l.id);
