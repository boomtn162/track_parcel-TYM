/**
 * ระบบติดตามพัสดุ สถานีรถไฟตันหยงมัส — Backend (Google Apps Script + Google Sheets)
 *
 * วิธีติดตั้ง (ทำครั้งเดียว) ดูรายละเอียดใน README.md
 *   1. สร้าง Google Sheet ใหม่ > ส่วนขยาย > Apps Script > วางโค้ดไฟล์นี้ทั้งหมด
 *   2. แก้ค่า STAFF_PIN_DEFAULT ด้านล่าง แล้วกดรันฟังก์ชัน setup() หนึ่งครั้ง (อนุญาตสิทธิ์)
 *   3. ทำให้ใช้งานได้ > การทำให้ใช้งานได้รายการใหม่ > เว็บแอป
 *        - เรียกใช้ในฐานะ: ฉัน   - ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน
 *   4. คัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ในหน้า "ตั้งค่า" ของหน้าเจ้าหน้าที่ (หรือในตัวแปร API_URL ใน index.html)
 *
 * ความปลอดภัย:
 *   - ลูกค้า (GET action=track) จะเห็นเฉพาะสถานะ ปลายทาง และชื่อ/เบอร์ที่ถูกปิดบังบางส่วนเท่านั้น
 *     ไม่มีที่อยู่ ไม่มีเบอร์โทรเต็ม
 *   - งานของเจ้าหน้าที่ทุกอย่าง (ดูรายการ/เพิ่ม/แก้/ลบ) ต้องส่ง PIN ที่ถูกต้องมาด้วย ตรวจที่ฝั่ง server
 */

const STAFF_PIN_DEFAULT = '4419';      // <-- เปลี่ยนก่อนรัน setup()  (หลังจากนั้นเปลี่ยนได้ที่ Project Settings > Script Properties)
const SHEET_NAME = 'Parcels';
const COLS = ['id', 'sendDate', 'issuedAt', 'train', 'loadDate', 'originCode', 'originName',
  'destCode', 'destName', 'senderName', 'senderPhone', 'senderAddr', 'receiverName',
  'receiverPhone', 'receiverAddr', 'items', 'weight', 'fee', 'eta', 'status', 'events', 'updatedAt'];
const JSON_COLS = { items: true, events: true };
const STATUS_ORDER = { received: 1, loaded: 2, arrived: 3, delivered: 4, problem: 0 };

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('STAFF_PIN')) props.setProperty('STAFF_PIN', STAFF_PIN_DEFAULT);
  sheet_();
}

/* ---------------- HTTP ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'track') return json_({ ok: true, results: track_(p.q || '') });
    if (p.action === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  const pin = PropertiesService.getScriptProperties().getProperty('STAFF_PIN') || STAFF_PIN_DEFAULT;
  if (String(body.pin || '') !== String(pin)) {
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

/* ---------------- ค้นหาสำหรับลูกค้า (ข้อมูลถูกปิดบังบางส่วน) ---------------- */

function track_(q) {
  q = String(q).trim().toUpperCase().replace(/\s+/g, '');
  if (!q) return [];
  const all = readAll_();
  let hits = [];
  if (/^PAN[\d-]+$/.test(q) || /^\d{4}-\d{5}$/.test(q) || /^\d{5}$/.test(q)) {
    // ค้นด้วยเลขที่ใบส่งของ (เต็ม หรือ 5 หลักท้าย/รหัสสถานี-เลขท้าย)
    hits = all.filter(function (r) { return r.id === q || r.id.slice(-q.length) === q; });
  } else {
    const phone = q.replace(/\D/g, '');
    if (phone.length !== 10) return []; // ต้องใส่เบอร์ครบ 10 หลัก
    hits = all.filter(function (r) { return r.senderPhone === phone || r.receiverPhone === phone; });
  }
  hits.sort(function (a, b) { return String(b.issuedAt || b.sendDate).localeCompare(String(a.issuedAt || a.sendDate)); });
  return hits.slice(0, 30).map(publicView_);
}

function publicView_(r) {
  return {
    id: r.id, sendDate: r.sendDate, issuedAt: r.issuedAt, train: r.train, loadDate: r.loadDate,
    originName: r.originName || 'ตันหยงมัส', destCode: r.destCode, destName: r.destName,
    senderName: maskName_(r.senderName), receiverName: maskName_(r.receiverName),
    receiverPhone: maskPhone_(r.receiverPhone),
    items: (r.items || []).map(function (i) { return { qty: i.qty, unit: i.unit, desc: i.desc }; }),
    weight: r.weight, eta: r.eta, status: r.status,
    events: (r.events || []).map(function (ev) { return { s: ev.s, t: ev.t, note: ev.note || '' }; })
  };
}

function maskName_(name) {
  name = String(name || '').replace(/^(นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.)\s*/, '').trim();
  if (!name) return '';
  return name.split(/\s+/).map(function (w) {
    const chars = Array.from(w);
    return chars.slice(0, Math.min(2, chars.length)).join('') + '***';
  }).join(' ');
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
    if (index[p.id]) sh.getRange(index[p.id], 1, 1, COLS.length).setValues([row]);
    else { append.push(row); index[p.id] = -1; }
  });
  if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, COLS.length).setValues(append);
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
