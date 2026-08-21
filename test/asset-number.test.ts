// ═══ รูปแบบเลขสินทรัพย์ — กติกาที่ AMS กับ SAP ต้องมองตรงกัน ═══
//
// ไฟล์นี้มีอยู่เพราะเคยพลาดมาแล้ว: regex เดิมบังคับท่อนท้ายเป็นเลข 3 หลักตายตัว ทำให้
// สินทรัพย์จริง 396 ชิ้นจาก 2,726 ไม่เคยถูก sync เข้ามา และเป็นของแพงที่สุดในบริษัท
// (อาคารโรงงาน APC 27 ล้าน) ทั้งยังทำให้บัญชีพิมพ์เลขพวกนั้นเข้าระบบไม่ได้เพราะติด 422
//
// ตัวอย่างข้างล่างไม่ได้แต่งขึ้น — ทุกตัวคัดมาจาก OITM จริง (วัด 2026-08-20) ถ้าวันหลังมีใคร
// รัดกติกาให้แคบลงอีก เทสต์นี้จะล้มพร้อมชี้ว่าของจริงชิ้นไหนจะหลุดออกจากระบบ
import { describe, expect, test } from 'bun:test';
import {
  ASSET_NUMBER_MAX_LENGTH,
  ASSET_NUMBER_MIN_LENGTH,
  ASSET_NUMBER_REGEX,
  isAssetNumber,
  purchasingCodeSqlFilter,
} from '@common/asset-number';

/** ของจริงจาก OITM — ครบทั้ง 5 ทรงของท่อนท้ายที่มีอยู่ในบริษัท */
const REAL_ASSET_NUMBERS = [
  'COM-100-05-002', // 3 ตัว เลขล้วน (ทรงเดิมที่เคยรองรับอย่างเดียว)
  'FAB-200-14-B101', // 4 ตัว อักษรนำหน้าเลข — อาคารโรงงาน
  'COM-220-19-001BP', // 5 ตัว เลขตามด้วยอักษร
  'LRD-110-17-001VTL', // 6 ตัว
  'LRD-110-17-0010VTL', // 7 ตัว (ยาวสุดที่วัดเจอ)
  'LRD-110-17-010VTLQ', // 7 ตัว อีกทรง
];

describe('ASSET_NUMBER_REGEX', () => {
  test.each(REAL_ASSET_NUMBERS)('รับเลขจริงจาก SAP: %s', (code) => {
    expect(ASSET_NUMBER_REGEX.test(code)).toBe(true);
  });

  test('ความยาวของเลขจริงทุกตัวอยู่ในช่วง MIN..MAX ที่ schema ใช้บังคับ', () => {
    // ถ้าข้อนี้ล้ม แปลว่า regex กับ minLength/maxLength ของ assignNumberBody เล่าคนละเรื่อง
    // แล้วจะได้ 422 ทั้งที่รูปแบบถูก ซึ่งไล่หาสาเหตุยากมากเพราะข้อความ error ชี้ไปที่ pattern
    for (const code of REAL_ASSET_NUMBERS) {
      expect(code.length).toBeGreaterThanOrEqual(ASSET_NUMBER_MIN_LENGTH);
      expect(code.length).toBeLessThanOrEqual(ASSET_NUMBER_MAX_LENGTH);
    }
  });

  test.each([
    ['com-775-26-050', 'ตัวพิมพ์เล็ก — route เป็นคน uppercase ให้ก่อนถึง validator'],
    ['COM-775-26-05', 'ท่อนท้ายสั้นกว่า 3 ตัว'],
    ['COM-775-26-01234567', 'ท่อนท้ายยาวเกิน 7 ตัว'],
    ['COM-775-26-001-BP', 'มีขีดในท่อนท้าย (กลายเป็นห้าท่อน)'],
    ['COM-77-26-001', 'ท่อนที่สองไม่ใช่เลข 3 หลัก'],
    ['COMM-775-26-001', 'อักษรนำหน้าเกินสามตัว'],
    ['5320107', 'รหัสจัดซื้อ ไม่ใช่เลขสินทรัพย์'],
    ['Vortex Ring Blower ยี่ห้อ Hitachi รุ่น VB-004-DN', 'ชื่อสินค้าที่มีคนกรอกลงช่อง ItemCode'],
    [' COM-775-26-050', 'มีช่องว่างนำหน้า — anchored ทั้งสองด้านต้องปฏิเสธ'],
  ])('ปฏิเสธ %s (%s)', (code) => {
    expect(ASSET_NUMBER_REGEX.test(code)).toBe(false);
  });
});

/**
 * ของจริงที่ **ไม่เข้าสคีมา** แต่ต้องเข้าระบบ — เลขชิ้นส่วนย่อยและสคีมาเก่าของเครื่องจักร
 *
 * เทสต์ชุดนี้คือหลักประกันว่าไม่มีใครเอา regex ไปใช้เป็นตัวคัดของทิ้งอีก: มันต้องตอบ false
 * (ไม่เข้าสคีมา) แต่ connector ต้องยังดึงเข้าเป็นสินทรัพย์ตามปกติ — ดู asset-sync-po-flow.test.ts
 */
const REAL_BUT_OFF_SCHEME = [
  'MAC-300-13-001.1', // ชิ้นส่วนย่อยของ Day Tank #1 (มอเตอร์เกียร์)
  'MAC-212-13-001/1', // ถัง Silo — ใช้ทับแทนจุด
  'MAC-1-21/12-002', // เครื่องบรรจุกึ่งอัตโนมัติ — คนละสคีมาไปเลย
  'Vortex Ring Blower ยี่ห้อ Hitachi รุ่น VB-004-DN', // ชื่อสินค้าในช่อง ItemCode
];

describe('isAssetNumber — ใช้ติดธง ไม่ใช่คัดของทิ้ง', () => {
  test.each(REAL_ASSET_NUMBERS)('เข้าสคีมา: %s', (code) => {
    expect(isAssetNumber(code)).toBe(true);
  });

  test.each(REAL_BUT_OFF_SCHEME)('ไม่เข้าสคีมาแต่เป็นของจริง: %s', (code) => {
    expect(isAssetNumber(code)).toBe(false);
  });

  test('null / undefined ไม่ระเบิด', () => {
    expect(isAssetNumber(null)).toBe(false);
    expect(isAssetNumber(undefined)).toBe(false);
  });
});

describe('ตัวกรองฝั่ง SQL', () => {
  test('รหัสจัดซื้อนิยามว่า "ตัวเลขล้วน" ไม่ใช่ "ไม่ใช่เลขสินทรัพย์"', () => {
    // นิยามแบบหลังเคยทำให้อาคารโรงงาน APC 27 ล้านถูกจัดเป็นรหัสจัดซื้อ
    // และเป็นตัวกรองเดียวที่เหลืออยู่ฝั่ง SQL — ที่เหลือย้ายมาตัดสินด้วย isAssetNumber แล้ว
    expect(purchasingCodeSqlFilter('i.ItemCode')).toBe(`i.ItemCode NOT LIKE '%[^0-9]%'`);
  });
});
