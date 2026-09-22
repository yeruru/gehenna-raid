/**
 * 공대 스크린샷 → 클랜원 이름 인식 (Tesseract.js)
 *
 * 순서
 *  1. 사진 전체를 영어로 읽어서 "Lv." 글자 위치를 찾음 (레벨 줄은 인식이 잘 됨)
 *  2. 각 "Lv." 바로 위 줄 = 이름 칸 → 잘라서 크게 키우고 흑백으로 바꿔 한 줄씩 읽음
 *  3. 읽은 글자에서 클랜 태그(We)를 떼고, 클랜원 명단 · 게임 닉네임과 자모 단위로 비교
 *     - 똑같으면 auto (자동 선택) / 한두 자모 차이면 check (확인 필요) / 그 외 unknown (못 찾음)
 *
 * 사용 : const result = await RaidOCR.read(fileOrBlob, { members, aliases, onProgress })
 */
(function(){
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

  /* ---------- Tesseract 불러오기 (처음 쓸 때 한 번) ---------- */
  let libPromise = null;
  function loadLib(){
    if(window.Tesseract) return Promise.resolve(window.Tesseract);
    if(!libPromise){
      libPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = TESSERACT_URL;
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => {
          libPromise = null;
          reject(new Error(navigator.onLine === false
            ? "인터넷에 연결되어 있지 않습니다. 글자 인식은 처음 한 번 인터넷이 필요합니다."
            : "글자 인식 도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요."));
        };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  /* 워커는 사진을 여러 장 연달아 읽을 때를 위해 잠시 살려 두고, 5분 동안 쓰지 않으면 정리한다.
     (언어 × 인식모드마다 하나씩 떠 있어서 그냥 두면 계속 메모리를 차지함) */
  const workers = {};
  const IDLE_MS = 5 * 60 * 1000;
  let idleTimer = null, busy = 0;

  function keepAlive(){
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if(!busy) terminate(); }, IDLE_MS);
  }

  async function terminate(){
    clearTimeout(idleTimer);
    const pending = Object.keys(workers).map(k => { const p = workers[k]; delete workers[k]; return p; });
    await Promise.all(pending.map(p => p.then(w => w.terminate()).catch(() => {})));
  }

  async function getWorker(lang, psm){
    const key = lang + psm;
    if(!workers[key]){
      workers[key] = (async () => {
        const T = await loadLib();
        const w = await T.createWorker(lang, 1, {});
        await w.setParameters({ tessedit_pageseg_mode: String(psm) });
        return w;
      })();
      workers[key].catch(() => { delete workers[key]; });
    }
    return workers[key];
  }

  /* ---------- 이미지 ---------- */
  /* 사진 준비 : img.decode() 는 환경에 따라 영영 끝나지 않는 경우가 있어
     (일부 내장 브라우저 · 웹뷰) load 이벤트를 기다리는 방식으로 읽는다 */
  function waitImage(img){
    return new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("사진을 열지 못했습니다. 다른 사진으로 다시 시도해 보세요."));
    });
  }

  async function toImage(src){
    if(src instanceof HTMLImageElement){
      if(!src.complete) await waitImage(src);
      return src;
    }
    const url = URL.createObjectURL(src);
    try{
      const img = new Image();
      const done = waitImage(img);
      img.src = url;
      return await done;
    }finally{
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  // 잘라서 키우고 → 밝은 글씨는 검정, 나머지는 흰색 (어두운 배경의 흰 글씨 / 금색 글씨 모두 대응)
  function prepare(img, sx, sy, sw, sh, scale, threshold, pad){
    sx = Math.max(0, Math.floor(sx)); sy = Math.max(0, Math.floor(sy));
    sw = Math.min(img.naturalWidth - sx, Math.ceil(sw)); sh = Math.min(img.naturalHeight - sy, Math.ceil(sh));
    const W = Math.max(1, Math.round(sw * scale)), H = Math.max(1, Math.round(sh * scale));
    const t = document.createElement("canvas");
    t.width = W; t.height = H;
    const tx = t.getContext("2d", { willReadFrequently: true });
    tx.imageSmoothingQuality = "high";
    tx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
    const d = tx.getImageData(0, 0, W, H), p = d.data;
    for(let i = 0; i < p.length; i += 4){
      const l = 0.299 * p[i] + 0.587 * p[i+1] + 0.114 * p[i+2];
      const v = l > threshold ? 0 : 255;
      p[i] = p[i+1] = p[i+2] = v;
    }
    tx.putImageData(d, 0, 0);
    const c = document.createElement("canvas");
    c.width = W + pad * 2; c.height = H + pad * 2;
    const cx = c.getContext("2d");
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(t, pad, pad);
    return c;
  }

  // 이름 칸의 글자 밝기 (상위 2% 밝기) : 흰 글씨 ≈ 255, 금색 글씨 ≈ 170
  function textBrightness(img, sx, sy, sw, sh){
    sx = Math.max(0, Math.floor(sx)); sy = Math.max(0, Math.floor(sy));
    sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.ceil(sw))); sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.ceil(sh)));
    const c = document.createElement("canvas");
    c.width = sw; c.height = sh;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const p = x.getImageData(0, 0, sw, sh).data;
    const hist = new Array(256).fill(0);
    for(let i = 0; i < p.length; i += 4) hist[Math.round(0.299 * p[i] + 0.587 * p[i+1] + 0.114 * p[i+2])]++;
    let need = Math.max(1, Math.round(sw * sh * 0.02));
    for(let v = 255; v >= 0; v--){ need -= hist[v]; if(need <= 0) return Math.max(v, 60); }
    return 255;
  }

  // 확인 화면에 보여줄 원본 이름 칸 (색 그대로)
  function snapshot(img, sx, sy, sw, sh){
    sx = Math.max(0, Math.floor(sx)); sy = Math.max(0, Math.floor(sy));
    sw = Math.min(img.naturalWidth - sx, Math.ceil(sw)); sh = Math.min(img.naturalHeight - sy, Math.ceil(sh));
    const scale = Math.max(1, Math.min(4, 40 / sh));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }

  function flatWords(data){
    const out = [];
    (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => (l.words || []).forEach(w => out.push(w)))));
    return out;
  }

  /* ---------- 1. 이름 칸 위치 찾기 ---------- */
  async function findCells(img){
    const scale = Math.max(1, Math.min(5, 2700 / img.naturalWidth));
    const eng = await getWorker("eng", 11);
    const r = await eng.recognize(prepare(img, 0, 0, img.naturalWidth, img.naturalHeight, scale, 110, 0), {}, { blocks: true });
    const words = flatWords(r.data).map(w => ({
      text: w.text,
      x0: w.bbox.x0 / scale, x1: w.bbox.x1 / scale,
      y0: w.bbox.y0 / scale, y1: w.bbox.y1 / scale
    }));

    // "Lv." (가끔 "Lv.104" 처럼 붙어서 읽힘) + 바로 오른쪽 숫자
    const lvs = words.filter(w => /^[LI1l|][vVyu][.,]?\d*$/.test(w.text) || /^Lv/i.test(w.text));
    let cells = lvs.map(lv => {
      const h = lv.y1 - lv.y0;
      const num = words.find(w => w !== lv && /^\d{1,3}$/.test(w.text) &&
        w.x0 >= lv.x1 - 2 && w.x0 - lv.x1 < h * 2 && Math.abs((w.y0 + w.y1) / 2 - (lv.y0 + lv.y1) / 2) < h);
      const x1 = num ? num.x1 : lv.x1;
      return { cx: (lv.x0 + x1) / 2, top: Math.min(lv.y0, num ? num.y0 : lv.y0), h: Math.max(6, Math.min(h, num ? num.y1 - num.y0 : h)) };
    });

    // 다른 칸보다 눈에 띄게 작게 잡힌 건 진짜 'Lv.' 글자가 아니라 잘못 읽은 잡음이다 (높이가 중간값의 절반 미만)
    if(cells.length > 2){
      const heights = cells.map(c => c.h).sort((a, b) => a - b);
      const medianH = heights[Math.floor(heights.length / 2)];
      cells = cells.filter(c => c.h >= medianH * 0.6);
    }

    // 같은 줄끼리 간격 → 칸 너비
    const gaps = [];
    cells.forEach(a => {
      let best = Infinity;
      cells.forEach(b => {
        if(a !== b && Math.abs(a.top - b.top) < a.h && b.cx > a.cx) best = Math.min(best, b.cx - a.cx);
      });
      if(best < Infinity) gaps.push(best);
    });
    gaps.sort((a, b) => a - b);
    const cellW = gaps.length ? gaps[Math.floor(gaps.length / 2)] : img.naturalWidth / 5;

    /* "Lv." 를 못 읽은 칸 채우기 : 같은 줄에서 실제 칸 사이에 하나가 비어 있으면 추가한다.
       단, 정렬된 열 기준으로 바로 왼쪽 · 오른쪽에 실제 칸이 '둘 다' 있을 때만 채운다.
       공대 한 조가 5명을 다 못 채운 경우(3명만 있는 등) 남는 빈 자리까지 사람으로 채워버리면
       잡음(다른 아이콘 · 여백)을 이름 칸으로 잘못 인식하게 된다 */
    const rows = [];
    cells.slice().sort((a, b) => a.top - b.top).forEach(c => {
      const row = rows.find(r => Math.abs(r.top - c.top) < c.h);
      if(row) row.cells.push(c); else rows.push({ top: c.top, h: c.h, cells: [c] });
    });
    const cols = [];
    cells.forEach(c => {
      const col = cols.find(x => Math.abs(x - c.cx) < cellW / 3);
      if(col === undefined) cols.push(c.cx);
    });
    cols.sort((a, b) => a - b);
    rows.forEach(r => {
      const xs = r.cells.map(c => c.cx);
      const has = x => x !== undefined && xs.some(v => Math.abs(v - x) < cellW / 3);
      cols.forEach((x, i) => {
        if(has(x) || !has(cols[i - 1]) || !has(cols[i + 1])) return;
        const others = cells.filter(c => Math.abs(c.cx - x) < cellW / 3);
        const cx = others.reduce((s, c) => s + c.cx, 0) / others.length;
        cells.push({ cx, top: r.top, h: r.h });
      });
    });

    return cells
      .sort((a, b) => (Math.abs(a.top - b.top) < a.h ? a.cx - b.cx : a.top - b.top))
      .map(c => ({
        x: c.cx - cellW / 2,
        y: c.top - c.h * 1.95,
        w: cellW,
        h: c.h * 1.8
      }));
  }

  /* ---------- 2. 한글 자모 비교 ---------- */
  const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
  const JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
  function jamo(str){
    let out = "";
    for(const ch of str.toLowerCase()){
      const code = ch.charCodeAt(0) - 0xAC00;
      if(code >= 0 && code <= 11171){
        out += CHO[Math.floor(code / 588)] + JUNG[Math.floor(code / 28) % 21];
        const j = code % 28;
        if(j) out += JONG[j];
      }else{
        out += ch;
      }
    }
    return out;
  }
  function distance(a, b){
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
    for(let j = 1; j <= n; j++) dp[0][j] = j;
    for(let i = 1; i <= m; i++){
      for(let j = 1; j <= n; j++){
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
      }
    }
    return dp[m][n];
  }

  /* OCR이 작은 글씨 · 게임 특유의 글꼴에서 자주 헷갈리는 자모 : 된소리↔예사소리, 이중모음↔단모음.
     (예: 뽕→봉/붕, 쵸파→초파, 뀨우→꾸우로 잘못 읽는 일이 흔함)
     '자동 선택 / 확인 필요' 를 가르는 판정에만 쓰고, 화면에 보여 주는 글자 · 실제로 고르는 이름은
     그대로 둔다 — 판정용 자모만 하나로 묶어서 비교한다 */
  const FOLD = {
    "ㄲ":"ㄱ", "ㄸ":"ㄷ", "ㅃ":"ㅂ", "ㅆ":"ㅅ", "ㅉ":"ㅈ",
    "ㅑ":"ㅏ", "ㅕ":"ㅓ", "ㅛ":"ㅗ", "ㅠ":"ㅜ", "ㅖ":"ㅔ", "ㅒ":"ㅐ"
  };
  function foldJamo(j){
    let out = "";
    for(const ch of j) out += FOLD[ch] || ch;
    return out;
  }

  // 읽은 글자 → 비교할 후보 문자열들 (클랜 태그 · 잡음 제거)
  function readVariants(korText, engText, prefix){
    const out = new Set();
    const hangul = (korText.match(/[가-힣]+/g) || []);
    if(hangul.length){
      const joined = hangul.join("");
      out.add(joined);
      out.add(hangul[hangul.length - 1]);
      out.add(hangul.reduce((a, b) => b.length > a.length ? b : a, ""));
      // "We" 가 한글로 잘못 읽힌 경우 (웨훈이 → 훈이)
      if(/^[웨위워외왜베]/.test(joined) && joined.length > 1) out.add(joined.slice(1));
    }
    const pre = (prefix || "").toLowerCase();
    [engText, korText].forEach(t => {
      let latin = (t || "").replace(/[^A-Za-z0-9]/g, "");
      if(latin.length >= 3){
        if(pre && latin.toLowerCase().startsWith(pre)) latin = latin.slice(pre.length);
        else latin = latin.replace(/^(vv|w)[e3c]/i, "");
        if(latin.length >= 2) out.add(latin.toLowerCase());
      }
    });
    return [...out].filter(Boolean);
  }

  function bestMatch(variants, members, aliases){
    const targets = [];
    members.forEach(m => targets.push({ key: m.toLowerCase(), member: m }));
    Object.keys(aliases || {}).forEach(a => {
      if(members.includes(aliases[a])) targets.push({ key: a.toLowerCase(), member: aliases[a], alias: a });
    });
    let best = null;
    variants.forEach(v => {
      const vf = foldJamo(jamo(v));
      targets.forEach(t => {
        const tf = foldJamo(jamo(t.key));
        const d = distance(vf, tf);
        const ratio = d / Math.max(vf.length, tf.length);
        if(!best || d < best.dist || (d === best.dist && ratio < best.ratio)){
          best = { member: t.member, alias: t.alias || null, read: v, dist: d, ratio, len: tf.length };
        }
      });
    });
    return best;
  }

  function judge(best){
    if(!best) return "unknown";
    if(best.dist === 0) return "auto";
    const allowed = best.len <= 3 ? 1 : Math.max(1, Math.floor(best.len * 0.3));
    return best.dist <= allowed ? "check" : "unknown";
  }

  /* ---------- 3. 전체 실행 ---------- */
  async function read(src, opts){
    busy++;
    try{ return await readOne(src, opts); }
    finally{ busy--; keepAlive(); }
  }

  async function readOne(src, opts){
    opts = opts || {};
    const members = opts.members || [];
    const aliases = opts.aliases || {};
    const prefix = opts.prefix === undefined ? "We" : opts.prefix;
    const progress = opts.onProgress || function(){};

    progress({ step: "load", text: "글자 인식 도구 준비 중… (처음 한 번은 조금 걸립니다)" });
    const img = await toImage(src);
    await loadLib();

    progress({ step: "find", text: "이름 위치 찾는 중…" });
    const cells = await findCells(img);
    if(!cells.length) return { cells: 0, items: [] };

    const kor = await getWorker("kor", 7);
    const eng = await getWorker("eng", 7);
    const hasLatinMember = members.some(m => /[A-Za-z]/.test(m)) || Object.keys(aliases).some(a => /[A-Za-z]/.test(a));

    const items = [];
    for(let i = 0; i < cells.length; i++){
      progress({ step: "read", done: i, total: cells.length, text: "이름 읽는 중… (" + (i + 1) + " / " + cells.length + ")" });
      const c = cells[i];
      const scale = Math.max(2, Math.min(8, 44 / (c.h / 1.8)));
      let best = null, raw = "";

      // 글자 밝기에 맞춘 임계값 여러 개로 읽어보고 명단과 가장 가까운 결과 사용 (정확히 맞으면 바로 멈춤)
      const bright = textBrightness(img, c.x, c.y, c.w, c.h);
      const thresholds = [...new Set([Math.round(bright * 0.45), 110, Math.round(bright * 0.33), Math.round(bright * 0.56)])]
        .filter(t => t < bright - 10);
      for(const th of thresholds){
        const canvas = prepare(img, c.x, c.y, c.w, c.h, scale, th, 20);
        const k = (await kor.recognize(canvas)).data.text.trim();
        let e = "";
        if(hasLatinMember && !/[가-힣]{2,}/.test(k)) e = (await eng.recognize(canvas)).data.text.trim();
        const m = bestMatch(readVariants(k, e, prefix), members, aliases);
        if(m && (!best || m.dist < best.dist || (m.dist === best.dist && m.ratio < best.ratio))){
          best = m;
          raw = (e && /[A-Za-z]{3,}/.test(e) ? e : k);
        }
        if(best && best.dist === 0) break;
      }

      items.push({
        index: i,
        raw: raw.replace(/\s+/g, " ").slice(0, 30),
        read: best ? best.read : "",
        member: best ? best.member : null,
        dist: best ? best.dist : null,
        status: judge(best),
        image: snapshot(img, c.x, c.y, c.w, c.h)
      });
    }

    // 같은 사람이 두 번 잡히면 더 정확한 쪽만 자동 · 나머지는 확인 필요
    const byMember = {};
    items.forEach(it => {
      if(!it.member || it.status === "unknown") return;
      const prev = byMember[it.member];
      if(!prev){ byMember[it.member] = it; return; }
      const [keep, drop] = it.dist < prev.dist ? [it, prev] : [prev, it];
      byMember[it.member] = keep;
      drop.status = "check";
      drop.duplicate = true;
    });

    progress({ step: "done", done: cells.length, total: cells.length, text: "완료" });
    return { cells: cells.length, items };
  }

  window.RaidOCR = { read, terminate, _jamo: jamo, _distance: distance };
})();
