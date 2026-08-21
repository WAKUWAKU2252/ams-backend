-- ── ถอดตาราง uom ทิ้ง — หน่วยนับย้ายไปเป็นคอลัมน์ asset.uom (เพิ่มใน 0011)
--
-- ปลอดภัยเต็มที่ ณ เวลาที่เขียน: uom มี 0 แถว และ asset.uomId ไม่มีค่าสักแถวจาก 2,334
-- (ตรวจก่อนเขียน migration นี้) การถอดจึงไม่ทำให้ข้อมูลของใครหาย
--
-- ลำดับคำสั่งสำคัญ: ต้องถอด FK ก่อนแล้วค่อย DROP TABLE แบบไม่ใส่ CASCADE
-- ถ้า DROP TABLE ... CASCADE มาก่อน มันจะลบ fk_asset_uom ไปด้วย แล้วบรรทัด
-- DROP CONSTRAINT ที่ตามมาจะล้มด้วย "constraint does not exist" ทั้ง migration จึง rollback
-- และการใส่ CASCADE ก็แปลว่ายอมให้ลบอะไรก็ได้ที่บังเอิญอ้างตารางนี้อยู่โดยไม่ได้ดู
ALTER TABLE "asset" DROP CONSTRAINT IF EXISTS "fk_asset_uom";--> statement-breakpoint
ALTER TABLE "asset" DROP COLUMN IF EXISTS "uomId";--> statement-breakpoint
DROP TABLE IF EXISTS "uom";
