/*
 * นำเข้ารายการพัสดุจาก "ตารางรายการใบส่งของ" ของระบบรถไฟ
 *   1) ข้อความที่คัดลอก (ลากคลุมตารางบนหน้าเว็บ แล้ว Ctrl+C / Ctrl+V)  -> parseListText()   แม่นยำที่สุด
 *   2) รูปภาพหน้าจอ (OCR ด้วย tesseract.js ในเบราว์เซอร์ ไม่ส่งรูปไปที่ไหน) -> ocrListImage()
 *
 * ผลลัพธ์: [{ id, sendDate, fee, status, senderName, senderPhone, receiverName, receiverPhone, warn: [] }]
 * เลขบัตรประชาชน 13 หลักใต้ชื่อ: อ่านเฉพาะจาก "ข้อความที่คัดลอก" (OCR ไม่แม่นพอ) และส่งให้ server แฮชเก็บ ไม่เก็บเลขจริง
 */
(function (root) {
  const TESS_VER = '5.1.1';
  const TESS_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VER}/dist/tesseract.min.js`;
  const LANG_URL = (lang) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int`;

  const PHONE_RE = /(?<!\d)0\d{8,9}(?!\d)/g;
  const ID_RE = /PAN\s*(\d{4})\s*-\s*(\d{4})\s*-\s*(\d{5})/g;
  const AMOUNT_RE = /(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?!\d)/;
  const TITLE_RE = /^(นาย|นาง|นางสาว|น\.?ส\.?|คุณ|ด\.?ช\.?|ด\.?ญ\.?|ร\.?ต\.?.*|จ\.?ส\.?.*|พระ.*)$/;

  const thaiDate = (s) => (root.TYMParser ? root.TYMParser.thaiDateToISO(s) : '');

  function statusFromText(t) {
    if (/ถึงสถานี|ปลายทาง|สถานีปลาย/.test(t)) return 'arrived';
    if (/จ่ายผู้รับ|จ่ายแล้ว|รับของแล้ว|รับพัสดุแล้ว|ผู้รับรับ/.test(t)) return 'delivered';
    if (/ระหว่าง|ะหว่า|ว่างการ|การขนส|ขนส่ง/.test(t)) return 'loaded';
    if (/รับฝาก/.test(t)) return 'received';
    return '';
  }

  // ตัดเลขบัตร/ตัวเลข/คำสถานะ/สัญลักษณ์ ออกจากช่วงข้อความ เหลือแต่ชื่อ
  function cleanName(seg) {
    const toks = String(seg || '').split(/[\s|\t]+/).map((t) => t.replace(/^[^ก-๙A-Za-z]+|[^ก-๙A-Za-z.)]+$/g, ''))
      .filter((t) => t && /[ก-๙A-Za-z]/.test(t) && !/\d/.test(t) && !statusFromText(t) && !/ห่อวัตถุ|^แล้ว$/.test(t));
    if (!toks.length) return '';
    // เริ่มที่คำนำหน้าชื่อตัวแรก (นาย/นาง/น.ส./คุณ…) ถ้าไม่มี ใช้ 3 คำสุดท้าย (OCR มักมีเศษตัวอักษรนำหน้า)
    const start = toks.findIndex((t) => TITLE_RE.test(t));
    const out = start >= 0 ? toks.slice(start, start + 4) : toks.slice(-3);
    return out.join(' ').replace(/^น\.?ส\.?(?=\s|$)/, 'น.ส.').trim();
  }

  // แยกชื่อ/เบอร์ ของผู้ส่งและผู้รับ จากข้อความหลังยอดเงิน: [ชื่อผู้ส่ง] เบอร์1 [ชื่อผู้รับ] เบอร์2
  const ID13_RE = /(?<!\d)\d{13}(?!\d)/g;
  const idIn = (seg) => (String(seg || '').match(ID13_RE) || []).find((d) => validId(d)) || '';
  function validId(d) { let s = 0; for (let i = 0; i < 12; i++) s += +d[i] * (13 - i); return (11 - (s % 11)) % 10 === +d[12]; }

  function splitPeople(rest, withIds) {
    const phones = []; let m; PHONE_RE.lastIndex = 0;
    while ((m = PHONE_RE.exec(rest))) phones.push({ v: m[0], i: m.index, e: m.index + m[0].length });
    const p1 = phones[0], p2 = phones[1];
    const segS = p1 ? rest.slice(0, p1.i) : rest, segR = p1 ? rest.slice(p1.e, p2 ? p2.i : undefined) : '';
    const ids = withIds ? { senderIdNo: idIn(segS), receiverIdNo: idIn(segR) } : {};
    return {
      ...ids,
      senderName: cleanName(p1 ? rest.slice(0, p1.i) : rest),
      senderPhone: p1 ? p1.v : '',
      receiverName: p1 ? cleanName(rest.slice(p1.e, p2 ? p2.i : undefined)) : '',
      receiverPhone: p2 ? p2.v : ''
    };
  }

  function check(r) {
    r.warn = [];
    if (!/^PAN\d{4}-\d{4}-\d{5}$/.test(r.id)) r.warn.push('id');
    if (!/^0\d{9}$/.test(r.senderPhone || '')) r.warn.push('senderPhone');
    if (r.receiverPhone && !/^0\d{9}$/.test(r.receiverPhone)) r.warn.push('receiverPhone');
    return r;
  }

  /* ---------------- 1) ข้อความที่คัดลอก ---------------- */
  function parseListText(text) {
    text = String(text || '').replace(/\r/g, '');
    const hits = []; let m; ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(text))) hits.push({ id: `PAN${m[1]}-${m[2]}-${m[3]}`, i: m.index, e: m.index + m[0].length });
    const rows = [];
    hits.forEach((h, k) => {
      // ช่วงของแถวนี้ = หลังเลขที่ จนถึงเลขลำดับ/เลขที่ของแถวถัดไป
      let block = text.slice(h.e, k + 1 < hits.length ? hits[k + 1].i : undefined);
      block = block.replace(/\n\s*\d{1,3}\s*[\t ]*[⋮:]*\s*$/, '');            // ตัดเลขลำดับแถวถัดไปที่ติดมาท้าย
      const dm = block.match(/\d{1,2}\s*[ก-๙]{1,3}\.\s*[ก-๙]{1,2}\.?\s*\d{2,4}/);
      const am = block.match(AMOUNT_RE);
      const rest = am ? block.slice(am.index + am[0].length) : block;
      rows.push(check({
        id: h.id, sendDate: dm ? thaiDate(dm[0]) : '', fee: am ? parseFloat(am[0].replace(/,/g, '')) : 0,
        status: statusFromText(block), ...splitPeople(rest, true)
      }));
    });
    return dedupe(rows);
  }

  function dedupe(rows) {
    const seen = {};
    return rows.filter((r) => (seen[r.id] ? false : (seen[r.id] = true)));
  }

  /* ---------------- 2) รูปภาพ (OCR) ---------------- */
  let tessLoading = null;
  function loadTesseract() {
    if (root.Tesseract) return Promise.resolve();
    if (!tessLoading) tessLoading = new Promise((ok, bad) => {
      const s = document.createElement('script'); s.src = TESS_URL; s.onload = ok;
      s.onerror = () => { tessLoading = null; bad(new Error('โหลดตัวอ่านรูปภาพ (OCR) ไม่สำเร็จ ตรวจอินเทอร์เน็ต')); };
      document.head.appendChild(s);
    });
    return tessLoading;
  }

  async function fileToImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }

  // ภาพขาวดำจาก "ช่องสีที่เข้มที่สุด" ของแต่ละจุด: ตัวหนังสือสีฟ้า/ส้ม/ม่วง จะกลายเป็นสีดำชัด
  function prep(src, scale, thr) {
    const c = document.createElement('canvas'); c.width = src.width * scale; c.height = src.height * scale;
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      let v = Math.min(a[i], a[i + 1], a[i + 2]);
      if (thr) v = v < thr ? 0 : 255;
      a[i] = a[i + 1] = a[i + 2] = v;
    }
    x.putImageData(d, 0, 0);
    return c;
  }

  // วิเคราะห์สีป้ายสถานะ: ม่วง = อยู่ระหว่างการขนส่ง, ส้มมาก = ถึงสถานีปลายทางแล้ว
  // คืนสถานะรายแถว และขอบขวาของคอลัมน์สถานะ (ใช้แยกชื่อผู้ส่งออกจากเศษ OCR ของป้าย)
  function colorInfo(src) {
    const a = src.getContext('2d').getImageData(0, 0, src.width, src.height).data, W = src.width;
    const isPurple = (i) => a[i + 2] > a[i] + 30 && a[i + 2] > a[i + 1] + 60 && a[i] > 70;
    const isOrange = (i) => a[i] > 200 && a[i + 1] > 90 && a[i + 1] < 190 && a[i + 2] < 120;
    const xs = [];
    for (let y = 0; y < src.height; y += 2) for (let x = 0; x < W; x += 2) if (isPurple((y * W + x) * 4)) xs.push(x);
    xs.sort((p, q) => p - q);
    const purpleRight = xs.length > 200 ? xs[Math.floor(xs.length * 0.98)] : 0;
    const k = W / 1300;
    return {
      purpleRight,
      statusAt(y0, y1) {
        let purple = 0, orange = 0;
        for (let y = Math.max(0, y0); y < Math.min(src.height, y1); y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4; if (isPurple(i)) purple++; else if (isOrange(i)) orange++;
        }
        if (purple > 150 * k) return 'loaded';
        if (orange > 250 * k) return 'arrived';
        return '';
      }
    };
  }

  // แบ่งตำแหน่ง x ของเบอร์โทรเป็น 2 คอลัมน์ (ผู้ส่ง / ผู้รับ) ด้วยช่องว่างที่กว้างที่สุด
  function phoneColumns(xs) {
    xs = xs.slice().sort((p, q) => p - q);
    if (!xs.length) return null;
    let gap = 0, at = -1;
    for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap) { gap = xs[i] - xs[i - 1]; at = i; }
    if (gap < 60) return { sender: xs[0], receiver: null, split: Infinity };
    const mean = (v) => v.reduce((p, q) => p + q, 0) / v.length;
    const sx = mean(xs.slice(0, at)), rx = mean(xs.slice(at));
    return { sender: sx, receiver: rx, split: (sx + rx) / 2 };
  }

  const digitsOf = (t) => String(t || '').replace(/[๐-๙]/g, (c) => '0123456789'['๐๑๒๓๔๕๖๗๘๙'.indexOf(c)]).replace(/\D/g, '');
  const asPhone = (t) => { const d = digitsOf(t); return /^0\d{9}$/.test(d) && !/[ก-๙A-Za-z]{2}/.test(t) ? d : ''; };
  const words = (lines, scale) => lines.map((l) => ({
    y0: l.bbox.y0 / scale, y1: l.bbox.y1 / scale, text: l.text,
    w: (l.words || []).map((w) => ({ t: w.text, x: (w.bbox.x0 + w.bbox.x1) / 2 / scale, x0: w.bbox.x0 / scale, x1: w.bbox.x1 / scale }))
  }));

  // เลขลำดับ 5 หลักท้ายเลขที่: เอาตัวเลขกลุ่มแรกที่ยาว 9–14 หลัก (ก่อนยอดเงิน/เบอร์) แล้วใช้ 5 หลักท้าย
  function serialOf(ws, maxX) {
    const head = ws.filter((w) => w.x < maxX).map((w) => w.t).join(' ');
    const re = /[0-9๐-๙][0-9๐-๙\-–“”"'.:\s]{6,}[0-9๐-๙]/g; let m;
    while ((m = re.exec(head))) { const d = digitsOf(m[0]); if (d.length >= 9 && d.length <= 14) return d.slice(-5); }
    const d = head.match(/(\d{5})(?!\d)/); return d ? d[1] : '';
  }

  async function ocrListImage(file, opts = {}) {
    const station = opts.stationCode || '4419';
    const progress = opts.onProgress || (() => {});
    progress('กำลังโหลดตัวอ่านรูปภาพ…');
    await loadTesseract();
    const src = await fileToImage(file);
    const imgTha = prep(src, 2, 0), imgEng = prep(src, 3, 165);
    progress('กำลังโหลดข้อมูลภาษา (ครั้งแรกประมาณ 4 MB)…');
    const tha = await root.Tesseract.createWorker('tha', 1, { langPath: LANG_URL('tha') });
    const eng = await root.Tesseract.createWorker('eng', 1, { langPath: LANG_URL('eng') });
    let A, B;
    try {
      await eng.setParameters({ tessedit_char_whitelist: 'PAN0123456789-.,: ' });
      progress('กำลังอ่านชื่อและเบอร์โทร (1/2)…');
      A = (await tha.recognize(imgTha)).data;
      progress('กำลังอ่านเลขที่และยอดเงิน (2/2)…');
      B = (await eng.recognize(imgEng)).data;
    } finally { await tha.terminate(); await eng.terminate(); }
    progress('');

    const TL = words(A.lines, 2), EL = words(B.lines, 3), color = colorInfo(src);
    const phoneXs = [];
    TL.concat(EL).forEach((l) => l.w.forEach((w) => { if (asPhone(w.t)) phoneXs.push(w.x); }));
    const cols = phoneColumns(phoneXs);
    if (!cols) return [];
    const slot = (x) => (x < cols.split ? 'senderPhone' : 'receiverPhone');

    // prefix ปี+เดือน (เช่น 6911) จากแถวที่อ่านเลขที่ได้ครบ
    const pref = {};
    (A.text + '\n' + B.text).replace(/PAN(\d{4})-(\d{4})-\d{5}/g, (_, p, st) => { if (st === station) pref[p] = (pref[p] || 0) + 1; });
    const prefix = Object.keys(pref).sort((a, b) => pref[b] - pref[a])[0];

    const rows = [];
    TL.forEach((l, idx) => {
      const ph = {}, fromEng = {};
      l.w.forEach((w) => { const p = asPhone(w.t); if (p && !ph[slot(w.x)]) ph[slot(w.x)] = p; });
      const e = EL.reduce((best, x) => (!best || Math.abs(x.y0 - l.y0) < Math.abs(best.y0 - l.y0) ? x : best), null);
      const el = e && Math.abs(e.y0 - l.y0) < 15 ? e : null;
      if (el) el.w.forEach((w) => { const p = asPhone(w.t), k = slot(w.x); if (p && !ph[k]) { ph[k] = p; fromEng[k] = true; } });
      if (!ph.senderPhone && !ph.receiverPhone) return;                 // แถวข้อมูลต้องมีเบอร์อย่างน้อย 1 เบอร์

      const firstPhoneX = cols.sender - 60;
      const serial = (el && serialOf(el.w, firstPhoneX)) || serialOf(l.w, firstPhoneX);
      if (!serial) return;
      const next = TL[idx + 1];
      const dm = (l.text + ' ' + (next ? next.text : '')).match(/\d{1,2}\s*[ก-๙]{1,3}\.\s*[ก-๙]{1,2}\.?\s*\d{4}/);
      const sendDate = dm ? thaiDate(dm[0]) : '';
      let pfx = prefix;
      if (!pfx && sendDate) pfx = String(+sendDate.slice(0, 4) + 543).slice(2) + sendDate.slice(5, 7);

      // ยอดเงิน: คำแรกหลังเลขที่ที่เป็นรูปแบบ 1,234.00 (ถ้าจุดหาย เช่น 9000 ให้หาร 100 แล้วเตือน)
      let fee = 0, feeWarn = false;
      const feeWords = (el ? el.w : []).concat(l.w).filter((w) => w.x < firstPhoneX && !/\d{9,}/.test(digitsOf(w.t)));
      const fw = feeWords.find((w) => /^\d{1,3}(,\d{3})*\.\d{2}$|^\d+\.\d{2}$/.test(w.t.trim()));
      if (fw) fee = parseFloat(fw.t.replace(/,/g, ''));
      else { const g = feeWords.find((w) => /^\d{3,7}$/.test(w.t.trim()) && /00$/.test(w.t.trim())); if (g) { fee = +g.t / 100; feeWarn = true; } }

      // ชื่อ: คำภาษาไทยระหว่างคอลัมน์สถานะ (ขอบขวาป้ายสี) กับเบอร์ผู้ส่ง / ระหว่างเบอร์ผู้ส่งกับเบอร์ผู้รับ
      const left = color.purpleRight ? color.purpleRight + 4 : 0;
      // OCR ภาษาไทยแยกเป็นพยางค์: ต่อกันเลยถ้าชิดกัน เว้นวรรคเมื่อห่างกันจริง (ระหว่างชื่อกับนามสกุล)
      const nameIn = (x0, x1) => {
        const ws = l.w.filter((w) => w.x0 >= x0 && w.x1 <= x1 && !asPhone(w.t)).sort((p, q) => p.x0 - q.x0);
        const txt = ws.reduce((acc, w, i) => acc + (i && w.x0 - ws[i - 1].x1 > 3.5 ? ' ' : '') + w.t.trim(), '');
        return cleanName(txt);
      };
      const senderName = nameIn(left, cols.sender - 40);
      const receiverName = cols.receiver ? nameIn(cols.sender + 40, cols.receiver - 40) : '';

      const r = check({
        id: `PAN${pfx || '????'}-${station}-${serial}`, sendDate, fee,
        status: color.statusAt(Math.floor(l.y0 - 4), Math.ceil(l.y1 + 30)) || statusFromText(l.text),
        senderName, senderPhone: ph.senderPhone || '', receiverName, receiverPhone: ph.receiverPhone || '', ocr: true
      });
      ['senderPhone', 'receiverPhone'].forEach((k) => { if ((!r[k] || fromEng[k]) && !r.warn.includes(k)) r.warn.push(k); });
      if (feeWarn || !fee) r.warn.push('fee');
      rows.push(r);
    });

    // เลขที่ในตารางเรียงต่อกัน: ถ้าแถวไหนเลขลำดับไม่เข้าพวกกับแถวข้างเคียง ให้เดาจากแถวข้างเคียงและเตือน
    const n = (r) => parseInt(r.id.slice(-5), 10);
    rows.forEach((r, i) => {
      const prev = rows[i - 1], nxt = rows[i + 1];
      const step = prev && nxt ? (n(nxt) - n(prev)) / 2 : 0;
      const guess = prev && nxt && Math.abs(step) === 1 ? n(prev) + step : !prev && nxt && rows[i + 2] && Math.abs(n(rows[i + 2]) - n(nxt)) === 1 ? n(nxt) - (n(rows[i + 2]) - n(nxt))
        : prev && !nxt && rows[i - 2] && Math.abs(n(prev) - n(rows[i - 2])) === 1 ? n(prev) + (n(prev) - n(rows[i - 2])) : null;
      if (guess != null && guess !== n(r) && guess > 0) {
        r.id = r.id.slice(0, -5) + String(guess).padStart(5, '0');
        if (!r.warn.includes('id')) r.warn.push('id');
      }
    });
    return dedupe(rows);
  }

  const api = { parseListText, ocrListImage, statusFromText, cleanName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TYMList = api;
})(typeof window !== 'undefined' ? window : globalThis);
