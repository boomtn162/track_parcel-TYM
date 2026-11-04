/**
 * ระบบติดตามพัสดุ สถานีรถไฟตันหยงมัส — Backend (Google Apps Script + Google Sheets)
 *
 * วิธีติดตั้ง (ทำครั้งเดียว) ดูรายละเอียดใน README.md
 *   1. สร้าง Google Sheet ใหม่ > ส่วนขยาย > Apps Script > วางโค้ดไฟล์นี้ทั้งหมด
 *   2. แก้ค่า STAFF_PIN_DEFAULT ด้านล่าง แล้วกดรันฟังก์ชัน setup() หนึ่งครั้ง (อนุญาตสิทธิ์)
 *      ต้องการเปลี่ยน PIN ภายหลัง: แก้ STAFF_PIN_DEFAULT แล้วรัน setup() อีกครั้ง (ไม่ต้อง Deploy ใหม่)
 *      หรือแก้ค่า STAFF_PIN ที่ Project Settings (รูปเฟือง) > Script Properties ก็ได้
 *   3. ทำให้ใช้งานได้ > การทำให้ใช้งานได้รายการใหม่ > เว็บแอป
 *        - เรียกใช้ในฐานะ: ฉัน   - ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน
 *   4. คัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ในตัวแปร API_URL ใน common.js
 *
 * ความปลอดภัย:
 *   - ลูกค้าเข้าระบบด้วย เลขที่พัสดุ (username) + เบอร์โทรผู้ส่งหรือผู้รับ (password) ผ่าน POST action=track
 *     จะเห็นเฉพาะพัสดุที่ตรงทั้งสองอย่าง ไม่มีที่อยู่ และเบอร์โทรถูกปิดบังบางส่วน
 *   - ใส่รหัสผิดเกิน MAX_FAILS ครั้ง เลขที่พัสดุนั้นจะถูกล็อก LOCK_MINUTES นาที
 *   - งานของเจ้าหน้าที่ทุกอย่าง (ดูรายการ/เพิ่ม/แก้/ลบ) ต้องส่ง PIN ที่ถูกต้องมาด้วย ตรวจที่ฝั่ง server
 */

const STAFF_PIN_DEFAULT = '4419';      // <-- เปลี่ยนแล้วกดรัน setup() เพื่อใช้ PIN ใหม่
const SHEET_NAME = 'Parcels';
const COLS = ['id', 'sendDate', 'issuedAt', 'train', 'loadDate', 'originCode', 'originName',
  'destCode', 'destName', 'senderName', 'senderPhone', 'senderAddr', 'receiverName',
  'receiverPhone', 'receiverAddr', 'items', 'weight', 'fee', 'eta', 'status', 'events', 'updatedAt'];
const JSON_COLS = { items: true, events: true };
const MAX_FAILS = 8;
const LOCK_MINUTES = 15;

// รันทุกครั้งที่เปลี่ยน STAFF_PIN_DEFAULT: บันทึก PIN ใหม่ทับของเดิม และสร้างชีตถ้ายังไม่มี
function setup() {
  const pin = String(STAFF_PIN_DEFAULT).trim();
  if (!pin) throw new Error('STAFF_PIN_DEFAULT ว่างไม่ได้');
  PropertiesService.getScriptProperties().setProperty('STAFF_PIN', pin);
  sheet_();
  Logger.log('ตั้ง PIN เจ้าหน้าที่เป็น "' + pin + '" แล้ว (มีผลทันที ไม่ต้อง Deploy ใหม่)');
}

// ดูว่าตอนนี้ระบบใช้ PIN อะไรอยู่ (กดรันแล้วดูใน "บันทึกการดำเนินการ")
function showPin() {
  Logger.log('PIN ที่ใช้อยู่: "' + currentPin_() + '"');
}

function currentPin_() {
  return String(PropertiesService.getScriptProperties().getProperty('STAFF_PIN') || STAFF_PIN_DEFAULT).trim();
}

/* ---------------- HTTP ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  if (body.action === 'track') {          // ลูกค้า: ไม่ต้องใช้ PIN
    try { return json_(track_(body.id, body.phone)); } catch (err) { return json_({ ok: false, error: String(err) }); }
  }
  if (String(body.pin || '').trim() !== currentPin_()) {
    Utilities.sleep(800); // ชะลอการเดา PIN
    return json_({ ok: false, error: 'PIN ไม่ถูกต้อง' });
  }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    switch (body.action) {
      case 'login': return json_({ ok: true });
      case 'list': return json_({ ok: true, parcels: readAll_() });
      case 'upsert': return json_({ ok: true, saved: upsert_(body.parcels || []) });
      case 'delete': return json_({ ok: true, deleted: delete_(body.ids || []) });
      default: return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- ลูกค้าเข้าระบบ: เลขที่พัสดุ + เบอร์โทร ---------------- */

function track_(id, phone) {
  id = String(id || '').trim().toUpperCase().replace(/\s+/g, '');
  phone = String(phone || '').replace(/\D/g, '');
  if (!id || phone.length < 9) return { ok: false, error: 'กรุณาใส่เลขที่ใบส่งของและเบอร์โทรศัพท์' };
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + id.slice(-11);
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) return { ok: false, error: 'ใส่รหัสผ่านผิดหลายครั้ง กรุณารอ ' + LOCK_MINUTES + ' นาทีแล้วลองใหม่' };

  const short = /^(\d{4}-)?\d{5}$/.test(id);   // พิมพ์แค่ท้ายเลข เช่น 00057 หรือ 4419-00057
  const hits = readAll_().filter(function (r) {
    const idOk = r.id === id || (short && r.id.slice(-(id.length + 1)) === '-' + id);
    return idOk && (r.senderPhone === phone || r.receiverPhone === phone);
  });
  if (!hits.length) {
    cache.put(failKey, String(fails + 1), LOCK_MINUTES * 60);
    Utilities.sleep(1000);
    return { ok: true, results: [] };
  }
  cache.remove(failKey);
  hits.sort(function (a, b) { return String(b.issuedAt || b.sendDate).localeCompare(String(a.issuedAt || a.sendDate)); });
  return { ok: true, results: hits.slice(0, 10).map(ownerView_) };
}

// ผู้ที่เข้าระบบได้เป็นผู้ส่ง/ผู้รับของพัสดุนั้น: แสดงชื่อเต็ม แต่ปิดบังเบอร์ และไม่ส่งที่อยู่ออกไป
function ownerView_(r) {
  return {
    id: r.id, sendDate: r.sendDate, issuedAt: r.issuedAt, train: r.train, loadDate: r.loadDate,
    originName: r.originName || 'ตันหยงมัส', destCode: r.destCode, destName: r.destName,
    senderName: r.senderName, senderPhone: maskPhone_(r.senderPhone),
    receiverName: r.receiverName, receiverPhone: maskPhone_(r.receiverPhone),
    items: (r.items || []).map(function (i) { return { qty: i.qty, unit: i.unit, desc: i.desc }; }),
    weight: r.weight, fee: r.fee, eta: r.eta, status: r.status,
    events: (r.events || []).map(function (ev) { return { s: ev.s, t: ev.t, note: ev.note || '' }; })
  };
}

function maskPhone_(p) {
  p = String(p || '').replace(/\D/g, '');
  return p.length >= 4 ? p.slice(0, 3) + '-xxx-' + p.slice(-4) : '';
}

/* ---------------- Sheet I/O ---------------- */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@'); // เก็บเลขที่เป็นข้อความ
    sh.getRange(1, 1, sh.getMaxRows(), COLS.length).setNumberFormat('@');
  }
  return sh;
}

function readAll_() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const rows = sh.getRange(2, 1, n, COLS.length).getValues();
  return rows.filter(function (r) { return r[0]; }).map(rowToObj_);
}

function rowToObj_(row) {
  const o = {};
  COLS.forEach(function (c, i) {
    let v = row[i];
    if (JSON_COLS[c]) { try { v = v ? JSON.parse(v) : []; } catch (e) { v = []; } }
    else if (c === 'weight' || c === 'fee') v = Number(v) || 0;
    else v = String(v == null ? '' : v);
    // Google Sheets อาจแปลงเบอร์เป็นตัวเลขแล้วตัด 0 ข้างหน้าทิ้ง (เช่น 924023836) -> เติม 0 กลับ
    if ((c === 'senderPhone' || c === 'receiverPhone') && v) { v = v.replace(/\D/g, ''); if (/^[1-9]\d{7,8}$/.test(v)) v = '0' + v; }
    o[c] = v;
  });
  return o;
}

function objToRow_(o) {
  return COLS.map(function (c) {
    const v = o[c];
    if (JSON_COLS[c]) return JSON.stringify(v || []);
    return v == null ? '' : String(v);
  });
}

// บันทึกทั้งพัสดุ (ส่งมาเป็น object เต็มจากหน้าเจ้าหน้าที่ ซึ่งรวมข้อมูลเดิมไว้แล้ว)
function upsert_(parcels) {
  const sh = sheet_();
  const n = Math.max(sh.getLastRow() - 1, 0);
  const ids = n ? sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const index = {};
  ids.forEach(function (id, i) { if (id) index[id] = i + 2; });
  const now = new Date().toISOString();
  const append = [];
  parcels.forEach(function (p) {
    if (!p || !p.id) return;
    p.id = String(p.id).trim().toUpperCase();
    p.updatedAt = now;
    const row = objToRow_(p);
    if (index[p.id]) sh.getRange(index[p.id], 1, 1, COLS.length).setNumberFormat('@').setValues([row]);
    else { append.push(row); index[p.id] = -1; }
  });
  if (append.length) {
    const rng = sh.getRange(sh.getLastRow() + 1, 1, append.length, COLS.length);
    rng.setNumberFormat('@');   // เก็บเป็นข้อความ ไม่ให้ Sheets ตัด 0 หน้าเบอร์โทร
    rng.setValues(append);
  }
  return parcels.length;
}

function delete_(ids) {
  const sh = sheet_();
  const n = Math.max(sh.getLastRow() - 1, 0);
  if (!n) return 0;
  const want = {};
  ids.forEach(function (id) { want[String(id)] = true; });
  const col = sh.getRange(2, 1, n, 1).getValues();
  let count = 0;
  for (let i = col.length - 1; i >= 0; i--) {
    if (want[String(col[i][0])]) { sh.deleteRow(i + 2); count++; }
  }
  return count;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
