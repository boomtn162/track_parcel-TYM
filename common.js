/* =====================================================================
   common.js — ใช้ร่วมกันทั้งหน้าลูกค้า (index.html) และหน้าเจ้าหน้าที่ (staff.html)
   ตั้งค่าหลัก — แก้ตรงนี้ได้เลย
   ===================================================================== */
const CONFIG = {
  // URL ของ Google Apps Script Web App (ลงท้ายด้วย /exec) ถ้ายังว่างไว้ ระบบจะทำงานแบบ "ทดลอง" เก็บข้อมูลในเครื่อง
  API_URL: '',
  STATION_NAME: 'ตันหยงมัส',
  STATION_CODE: '4419',
  STATION_PHONE: '',            // เช่น '073-xxx-xxx' จะแสดงในหน้าลูกค้า
  STATION_HOURS: '',            // เช่น 'เปิดรับฝากทุกวัน 07:00–16:00 น.'
  DEMO_PIN: '4419'              // PIN ของโหมดทดลองเท่านั้น (ระบบจริงใช้ PIN ที่ตั้งใน Apps Script)
};

/* ---------------- utils ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function fmtDate(iso, withTime = true) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return iso;
  let s = `${+m[3]} ${TH_MON[+m[2] - 1]} ${(+m[1] + 543) % 100}`;
  if (withTime && m[4]) s += ` ${m[4]}:${m[5]} น.`;
  return s;
}
function nowLocalISO() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const todayISO = () => nowLocalISO().slice(0, 10);
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
function store(key, val) {
  try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; }
}
const itemsText = (items) => (items || []).map((i) => `${i.desc} ${i.qty} ${i.unit}`).join(', ');

/* ---------------- สถานะ ---------------- */
const STEPS = ['received', 'loaded', 'arrived', 'delivered'];
const RANK = { problem: 0, received: 1, loaded: 2, arrived: 3, delivered: 4 };
const STATUS = {
  received: { label: 'รับฝากแล้ว', icon: '📦', now: (p) => `สถานี${CONFIG.STATION_NAME}รับพัสดุแล้ว กำลังรอขึ้นขบวนรถ${p.train ? ' ' + p.train : ''}` },
  loaded: { label: 'อยู่ระหว่างขนส่ง', icon: '🚆', now: (p) => `พัสดุขึ้นขบวนรถ${p.train ? ' ' + p.train : ''} แล้ว กำลังเดินทางไปสถานี${p.destName}${p.eta ? ' · คาดว่าจะถึง ' + fmtDate(p.eta) : ''}` },
  arrived: { label: 'ถึงสถานีปลายทาง', icon: '📍', now: (p) => `พัสดุถึงสถานี${p.destName}แล้ว ผู้รับสามารถไปรับได้ที่สถานี (นำบัตรประชาชนไปด้วย)` },
  delivered: { label: 'รับพัสดุแล้ว', icon: '✅', now: () => 'ผู้รับได้รับพัสดุเรียบร้อยแล้ว' },
  problem: { label: 'โปรดติดต่อสถานี', icon: '⚠️', now: () => 'พัสดุมีเรื่องต้องตรวจสอบ กรุณาติดต่อสถานี' }
};
const STEP_TITLE = { received: `รับฝากที่สถานี${CONFIG.STATION_NAME}`, loaded: 'ขึ้นขบวนรถ / ระหว่างทาง', arrived: 'ถึงสถานีปลายทาง', delivered: 'ผู้รับรับพัสดุแล้ว' };

/* ---------------- ข้อมูลที่ลูกค้าเห็นหลังเข้าระบบ (โหมดทดลอง — ระบบจริงทำที่ server ใน Code.gs) ---------------- */
const maskPhone = (p) => { p = String(p || '').replace(/\D/g, ''); return p.length >= 4 ? p.slice(0, 3) + '-xxx-' + p.slice(-4) : ''; };
function ownerView(r) {
  return { ...r, senderPhone: maskPhone(r.senderPhone), receiverPhone: maskPhone(r.receiverPhone), senderAddr: '', receiverAddr: '' };
}
const normId = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const normPhone = (s) => String(s || '').replace(/\D/g, '');
// เลขพัสดุตรงกันไหม (รับทั้งเลขเต็ม หรือพิมพ์แค่ท้ายเลข เช่น 00057 / 4419-00057)
const idMatches = (rid, q) => rid === q || (/^(\d{4}-)?\d{5}$/.test(q) && rid.endsWith('-' + q));

/* =====================================================================
   Backend: Cloud (Google Apps Script) หรือ Local (โหมดทดลอง localStorage)
   ===================================================================== */
const apiUrl = () => (store('tym_api_url') || CONFIG.API_URL || '').trim();
const isDemo = () => !apiUrl();

const Session = { pin: '' };   // PIN เจ้าหน้าที่ (หน้า staff.html)

const CONN_ERR = 'เชื่อมต่อ Google Apps Script ไม่ได้ — ตรวจว่า URL ถูกต้อง (ลงท้าย /exec) และตอน Deploy เลือก "ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน"';

const Cloud = {
  async get(params) {
    const u = new URL(apiUrl()); Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u.toString()); return r.json();
  },
  async post(body) {
    let r;
    try { r = await fetch(apiUrl(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, pin: Session.pin }) }); }
    catch (e) { throw new Error(CONN_ERR); }
    try { return await r.json(); } catch (e) { throw new Error(CONN_ERR); }
  },
  // ลูกค้าเข้าระบบ: เลขพัสดุ + เบอร์โทร (ไม่ต้องใช้ PIN)
  async track(id, phone) {
    const r = await fetch(apiUrl(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'track', id, phone }) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error); return r.results;
  },
  async login(pin) { Session.pin = pin; const r = await this.post({ action: 'login' }); if (!r.ok) throw new Error(r.error); },
  async list() { const r = await this.post({ action: 'list' }); if (!r.ok) throw new Error(r.error); return r.parcels; },
  async upsert(parcels) { const r = await this.post({ action: 'upsert', parcels }); if (!r.ok) throw new Error(r.error); },
  async del(ids) { const r = await this.post({ action: 'delete', ids }); if (!r.ok) throw new Error(r.error); }
};

const Local = {
  KEY: 'tym_parcels_demo',
  all() { let d = store(this.KEY); if (!Array.isArray(d)) { d = demoData(); store(this.KEY, d); } return d; },
  save(d) { store(this.KEY, d); },
  async track(id, phone) {
    id = normId(id); phone = normPhone(phone);
    return this.all().filter((r) => idMatches(r.id, id) && phone && (r.senderPhone === phone || r.receiverPhone === phone)).map(ownerView);
  },
  async login(pin) { if (pin !== CONFIG.DEMO_PIN) throw new Error('PIN ไม่ถูกต้อง'); Session.pin = pin; },
  async list() { return JSON.parse(JSON.stringify(this.all())); },
  async upsert(parcels) {
    const all = this.all(); const idx = Object.fromEntries(all.map((p, i) => [p.id, i]));
    parcels.forEach((p) => { p.updatedAt = new Date().toISOString(); if (p.id in idx) all[idx[p.id]] = p; else all.push(p); });
    this.save(all);
  },
  async del(ids) { this.save(this.all().filter((p) => !ids.includes(p.id))); }
};
const API = () => (isDemo() ? Local : Cloud);

// ข้อมูลตัวอย่าง (สมมติขึ้น ไม่ใช่ข้อมูลลูกค้าจริง)
function demoData() {
  const t = todayISO(), y = addDays(t, -1), y2 = addDays(t, -3);
  const mk = (n, date, train, dc, dn, item, qty, unit, w, fee, status, s, sp, r, rp) => {
    const id = `PAN0000-4419-${String(n).padStart(5, '0')}`;
    const ev = [{ s: 'received', t: `${date}T08:${String(10 + n).slice(-2)}:00`, note: '' }];
    if (RANK[status] >= 2) ev.push({ s: 'loaded', t: `${date}T14:05:00`, note: `ขึ้นขบวนรถ ${train}` });
    if (RANK[status] >= 3) ev.push({ s: 'arrived', t: `${addDays(date, 1)}T06:40:00`, note: `ถึงสถานี${dn}` });
    if (RANK[status] >= 4) ev.push({ s: 'delivered', t: `${addDays(date, 1)}T10:15:00`, note: '' });
    return { id, sendDate: date, issuedAt: ev[0].t, train, loadDate: RANK[status] >= 2 ? date : '', originCode: '4419', originName: 'ตันหยงมัส', destCode: dc, destName: dn,
      senderName: s, senderPhone: sp, senderAddr: 'ต.ตันหยงมัส อ.ระแงะ จ.นราธิวาส', receiverName: r, receiverPhone: rp, receiverAddr: 'รอรับที่สถานี',
      items: [{ desc: item, qty, unit }], weight: w, fee, eta: '', status, events: ev };
  };
  return [
    mk(1, t, '452', '4347', 'ชุมทางหาดใหญ่', 'เครื่องบริโภค(ของกิน) ลองกอง', 2, 'ลัง', 25, 120, 'received', 'นาย ทดลอง ส่งของ', '0800000001', 'สมหญิง ตัวอย่าง', '0800000002'),
    mk(2, t, '746', '1007', 'ชุมทางบางซื่อ', 'รถจักรยานยนต์ ไม่เกิน 124 ซีซี', 1, 'คัน', 100, 1212, 'loaded', 'นาง ตัวอย่าง ใจดี', '0800000003', 'สมชาย ทดสอบ', '0800000004'),
    mk(3, y, '746', '4009', 'ศาลายา', 'เครื่องบริโภค(ของกิน) อาหารแช่แข็ง', 5, 'กล่อง', 80, 483, 'arrived', 'นาย ทดลอง ส่งของ', '0800000001', 'มานี มีนา', '0800000005'),
    mk(4, y2, '452', '4308', 'นครศรีธรรมราช', 'เครื่องบริโภค(ของกิน) สะตอ', 3, 'ถุง', 32, 90, 'delivered', 'นาย สมมติ ขึ้นมา', '0800000006', 'สุดา', '0800000007')
  ];
}


function header(sub, rightLink) {
  return `<header class="top"><div class="wrap"><div class="row">
    <svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#fff" fill-opacity=".12"/><rect x="17" y="10" width="30" height="34" rx="7" fill="#fff"/><rect x="22" y="16" width="20" height="11" rx="2" fill="#123d6b"/><circle cx="25" cy="36" r="3" fill="#e8892b"/><circle cx="39" cy="36" r="3" fill="#e8892b"/><path d="M22 44l-5 9M42 44l5 9" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>
    <div><h1>ติดตามพัสดุ สถานีรถไฟ${esc(CONFIG.STATION_NAME)}</h1><div class="sub">${sub}</div></div>
    ${rightLink}
  </div></div><div class="rail"></div></header>`;
}
