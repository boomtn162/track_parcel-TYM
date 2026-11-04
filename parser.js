/*
 * ตัวอ่านไฟล์ PDF ของระบบรถไฟ (ใบส่งของ/ใบเสร็จรับเงิน และ ใบนำมอบสินค้าห่อวัตถุ)
 * ทำงานได้ทั้งในเบราว์เซอร์ (window.TYMParser) และใน Node (module.exports) เพื่อใช้ทดสอบ
 *
 * ข้อความที่รับเข้ามาคือ "บรรทัด" ที่ได้จาก pdf.js โดยแต่ละช่องในบรรทัดเดียวกันคั่นด้วย " | "
 * (ดูฟังก์ชัน pdfToLines ใน index.html)
 */
(function (root) {
  const TH_MONTHS = {
    'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6,
    'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12
  };

  // "03 พ.ย. 69" หรือ "3 พ.ย. 2569" (+ เวลา "08:38:58" ถ้ามี) -> "2026-11-03" / "2026-11-03T08:38:58"
  function thaiDateToISO(s) {
    if (!s) return '';
    const m = String(s).match(/(\d{1,2})\s*([ก-๙.]+)\s*(\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
    if (!m) return '';
    const mon = TH_MONTHS[m[2]];
    if (!mon) return '';
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2500;            // 69 -> 2569
    if (y > 2400) y -= 543;            // พ.ศ. -> ค.ศ.
    const d = String(parseInt(m[1], 10)).padStart(2, '0');
    const date = `${y}-${String(mon).padStart(2, '0')}-${d}`;
    if (!m[4]) return date;
    const t = m[4].length === 5 ? m[4] + ':00' : m[4];
    return `${date}T${t.padStart(8, '0')}`;
  }

  const num = (s) => {
    const n = parseFloat(String(s || '').replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const cleanPhone = (s) => String(s || '').replace(/\D/g, '');

  // ---------- ใบส่งของ/ใบเสร็จรับเงิน (1 ไฟล์ = 1 พัสดุ) ----------
  function parseReceipt(text) {
    const flat = text.replace(/\n/g, ' | ');
    const pick = (re) => { const m = flat.match(re); return m ? clean(m[1]) : ''; };

    const id = pick(/เลขที่\s*:\s*(PAN[\d-]+)/);
    if (!id) return null;

    const cells = (label) => {
      // คืนค่าในช่องหลัง "label :" จนถึง " | " ถัดไป
      const re = new RegExp(label + '\\s*:\\s*([^|]*)', 'g');
      const out = []; let m;
      while ((m = re.exec(flat))) out.push(clean(m[1]));
      return out;
    };

    const phones = cells('โทรศัพท์');
    const destRaw = pick(/สถานีรับ\s*:\s*([^|]+)/);
    const origRaw = pick(/สถานีส่ง\s*:\s*([^|]+)/);
    const dest = destRaw.match(/^(\d{4})\s*(.*)$/) || [null, '', destRaw];
    const orig = origRaw.match(/^(\d{4})\s*(.*)$/) || [null, '', origRaw];

    // รายการสินค้า: "1. | เครื่องบริโภค(ของกิน) อาหารแช่แข็ง จำนวน 5 กล่อง | 322.00 | ค่าระวาง"
    const items = [];
    const itemRe = /(?:^|\|)\s*\d+\.\s*\|\s*([^|]*?)\s*จำนวน\s*(\d+)\s*([^\s|]+)/g;
    let im;
    while ((im = itemRe.exec(flat))) {
      items.push({ desc: clean(im[1]), qty: parseInt(im[2], 10), unit: im[3] });
    }
    const w = flat.match(/น้ำหนัก\s*([\d.,]+)\s*\/\s*([\d.,]+)\s*กิโลกรัม/);
    const total = flat.match(/([\d,]+\.\d{2})\s*\|\s*รวมเงินทั้งสิ้น/);

    return {
      id,
      source: 'receipt',
      express: /(?:^|\|)\s*ด่วน\s*(?:\||$)/.test(flat),
      sendDate: thaiDateToISO(pick(/วันที่ส่ง\s*:\s*\|?\s*([^|]+)/)),
      issuedAt: thaiDateToISO(pick(/วันเวลาที่ออกใบส่งของ\s*:\s*([^|]+)/)),
      train: pick(/ขบวนรถ\s*:\s*(\d+)/),
      originCode: orig[1], originName: clean(orig[2]),
      destCode: dest[1], destName: clean(dest[2]),
      senderName: cells('ชื่อผู้ส่ง')[0] || '',
      receiverName: (cells('ชื่อผู้รับ')[0] || '').replace(/\(รอรับที่สถานี\)/, '').trim(),
      senderAddr: cells('ที่อยู่ผู้ส่ง')[0] || '',
      receiverAddr: cells('ที่อยู่ผู้รับ')[0] || '',
      senderPhone: cleanPhone(phones[0]),
      receiverPhone: cleanPhone(phones[1]),
      items,
      weight: w ? num(w[1]) : 0,
      chargedWeight: w ? num(w[2]) : 0,
      fee: total ? num(total[1]) : 0
    };
  }

  // ---------- ใบนำมอบสินค้าห่อวัตถุ (รวม) (1 ไฟล์ = ทุกพัสดุที่ขึ้นขบวนเดียวกัน) ----------
  function parseManifest(text) {
    const train = (text.match(/ขบวน\s*(\d+)/) || [])[1] || '';
    const loadDate = thaiDateToISO((text.match(/วันที่ขึ้นขบวนรถ\s*([^|\n]+)/) || [])[1]);
    const parcels = [];
    let station = { code: '', name: '' };
    let last = null;

    text.split('\n').forEach((raw) => {
      const line = raw.trim();
      let m;
      if ((m = line.match(/^(\d{4})\s+([^|\d][^|]*)$/))) {           // หัวกลุ่มสถานีปลายทาง
        station = { code: m[1], name: clean(m[2]) };
        last = null;
        return;
      }
      const cols = line.split('|').map(clean);
      const idIdx = cols.findIndex((c) => /^PAN[\d-]+$/.test(c));
      if (idIdx >= 0) {                                               // แถวที่มีเลขที่พัสดุ
        const q = (cols[idIdx + 1] || '').match(/^(\d+)\s*(.+)$/);
        last = {
          id: cols[idIdx],
          source: 'manifest',
          train, loadDate,
          destCode: station.code, destName: station.name,
          items: [], fee: 0, weight: 0
        };
        addItem(last, q, cols[idIdx + 2], cols[idIdx + 3], cols[idIdx + 4]);
        parcels.push(last);
        return;
      }
      if (last && cols.length >= 3 && (m = cols[0].match(/^(\d+)\s*(\S+)$/))) {   // รายการย่อยของพัสดุก่อนหน้า
        addItem(last, m, cols[1], cols[2], cols[3]);
      }
    });

    function addItem(p, q, desc, fee, weight) {
      if (!q) return;
      p.items.push({ desc: clean(desc), qty: parseInt(q[1], 10), unit: clean(q[2]) });
      p.fee += num(fee);
      p.weight += num(weight);
    }
    return { train, loadDate, parcels };
  }

  function parseLines(text) {
    if (/ใบนำมอบสินค้าห่อวัตถุ/.test(text)) return { type: 'manifest', ...parseManifest(text) };
    if (/ใบส่งของ\s*\/\s*ใบเสร็จรับเงิน/.test(text) || /PAN[\d-]+/.test(text)) {
      const r = parseReceipt(text);
      return r ? { type: 'receipt', parcel: r } : { type: 'unknown' };
    }
    return { type: 'unknown' };
  }

  const api = { parseLines, parseReceipt, parseManifest, thaiDateToISO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TYMParser = api;
})(typeof window !== 'undefined' ? window : this);
