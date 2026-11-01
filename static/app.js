// 서초구 부동산 대시보드 - 홍길동부동산
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const TYPE_COLOR = { '매매': '#2a78d6', '전세': '#eb6834', '월세': '#1baf7a' };
const PYEONG = 3.3058;

const S = { dong: '전체', mode: 'month', from: '', to: '', type: '매매', sort: 'price', sel: null };
const DATA = { trade: [], rent: [], range: '' };
let GEO = {}, POI = null, ROAD = {}, RONE = null;
let LISTINGS = [];

// ---------- utils ----------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const addMonths = (s, n) => { const d = parse(s); d.setMonth(d.getMonth() + n); return ymd(d); };
const ym = s => s.slice(0, 4) + s.slice(5, 7);
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const median = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const py = area => (area / PYEONG).toFixed(1);

function money(man, compact) {           // 만원 → 한글 금액
  man = Math.round(man);
  if (man < 10000) return man.toLocaleString() + (compact ? '만' : '만원');
  const eok = Math.floor(man / 10000), rest = man % 10000;
  if (compact) return (man / 10000).toFixed(man >= 100000 ? 1 : 2).replace(/\.?0+$/, '') + '억';
  return rest ? `${eok}억 ${rest.toLocaleString()}` : `${eok}억`;
}
const val = d => d.t === '매매' ? d.price : d.deposit;   // 대표 금액
const priceText = (d, compact) => d.t === '월세' ? `${money(d.deposit, compact)}/${d.rent}` : money(val(d), compact);
const ppp = d => val(d) / (d.area / PYEONG);           // 평당가 (만원)
function pct(cur, prev) {
  if (!prev || !cur) return '<span>비교 데이터 없음</span>';
  const p = (cur - prev) / prev * 100, cls = p > 0.05 ? 'up' : p < -0.05 ? 'down' : '';
  const lag = S.to > addDays(ymd(new Date()), -30) ? ' <span title="계약 후 30일 내 신고되므로 최근 기간 수치는 늘어날 수 있습니다">· 신고 진행중*</span>' : '';
  return `<span class="${cls}">${p > 0 ? '▲' : p < 0 ? '▼' : ''} ${Math.abs(p).toFixed(1)}%</span> <span>직전 기간 대비</span>${lag}`;
}
function hav(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const distText = m => m < 1500 ? `${Math.round(m)}m · 도보 ${Math.max(1, Math.round(m / 67))}분` : `${(m / 1000).toFixed(1)}km`;

async function getJSON(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok || j?.error) throw new Error(j?.error || r.statusText);
  return j;
}

// ---------- 기간 ----------
function setMode(mode, keepDates) {
  S.mode = mode;
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  if (!keepDates) {
    if (mode === 'week') S.from = addDays(S.to, -6);
    if (mode === 'month') S.from = addDays(addMonths(S.to, -1), 1);
  }
  $('#dFrom').value = S.from; $('#dTo').value = S.to;
}
function prevPeriod() {
  const n = daysBetween(S.from, S.to) + 1;
  return [addDays(S.from, -n), addDays(S.from, -1)];
}
const inDong = d => S.dong === '전체' || d.dong === S.dong;
const inRange = (d, a, b) => d.date >= a && d.date <= b;
const all = () => DATA.trade.concat(DATA.rent);
const sel = (type, a = S.from, b = S.to, dongFilter = true) =>
  (type === '매매' ? DATA.trade : DATA.rent).filter(d => d.t === type && inRange(d, a, b) && (!dongFilter || inDong(d)));

// ---------- 데이터 로드 ----------
async function loadData() {
  const [pa] = prevPeriod();
  const start = [pa, addMonths(S.to, -12), S.from].sort()[0];
  const range = `${ym(start)}-${ym(S.to)}`;
  if (range === DATA.range) return;
  $('#loading').hidden = false;
  $('#loading').textContent = `국토교통부 실거래가 불러오는 중… (${ym(start)} ~ ${ym(S.to)}, 처음 조회 시 30초 정도 걸릴 수 있습니다)`;
  const [t, r] = await Promise.all([
    getJSON(`/api/deals?kind=trade&from=${ym(start)}&to=${ym(S.to)}`),
    getJSON(`/api/deals?kind=rent&from=${ym(start)}&to=${ym(S.to)}`),
  ]);
  DATA.trade = t.items; DATA.rent = r.items; DATA.range = range;
  ROAD = {};
  r.items.forEach(d => { if (d.road) ROAD[`${d.dong}|${d.apt}`] = d.road; });
  const errs = [...t.errors, ...r.errors];
  $('#errorBox').hidden = !errs.length;
  $('#errorBox').textContent = errs.length ? '일부 월 데이터를 불러오지 못했습니다: ' + errs.join(' / ') : '';
  $('#loading').hidden = true;
}

// ---------- 좌표 ----------
function aptPos(dong, apt) {
  const key = `${dong}|${apt}`;
  const g = GEO[key];
  if (g) return { lat: g.lat, lon: g.lon, approx: false };
  if (g === undefined) requestGeo(dong, apt);
  const c = DONG_CENTER[dong] || [37.4837, 127.0324];
  let h = 0; for (const ch of apt) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  return { lat: c[0] + ((h % 40) - 20) / 4000, lon: c[1] + ((h / 40 | 0) - 12) / 3000, approx: true };
}
const pendingGeo = new Set();
async function requestGeo(dong, apt) {
  const key = `${dong}|${apt}`;
  if (pendingGeo.has(key)) return;
  pendingGeo.add(key);
  const jibun = (DATA.trade.find(d => d.dong === dong && d.apt === apt) || {}).jibun || '';
  try {
    GEO[key] = await getJSON(`/api/geocode?apt=${encodeURIComponent(apt)}&dong=${encodeURIComponent(dong)}&road=${encodeURIComponent(ROAD[key] || '')}&jibun=${encodeURIComponent(jibun)}`);
  } catch { GEO[key] = null; }
  if (GEO[key]) { renderMap(); if (S.sel && S.sel.key === key) renderAnalysis(); }
}

// ---------- 필터 UI ----------
function renderDongChips() {
  const cnt = {};
  sel('매매', S.from, S.to, false).forEach(d => cnt[d.dong] = (cnt[d.dong] || 0) + 1);
  const total = Object.values(cnt).reduce((a, b) => a + b, 0);
  const dongs = DONG_ORDER.filter(d => cnt[d] || ['반포동', '잠원동', '서초동', '방배동', '양재동', '우면동', '내곡동'].includes(d));
  $('#dongChips').innerHTML = ['전체', ...dongs].map(d =>
    `<button data-dong="${d}" class="${S.dong === d ? 'on' : ''}">${d === '전체' ? '서초구 전체' : d}<span class="cnt">${d === '전체' ? total : (cnt[d] || 0)}</span></button>`).join('');
  $$('#dongChips button').forEach(b => b.onclick = () => { S.dong = b.dataset.dong; S.sel = null; renderAll(); });
  const n = daysBetween(S.from, S.to) + 1;
  $('#periodNote').innerHTML = `조회기간 <b>${S.from} ~ ${S.to}</b> (${n}일) · 칩 숫자 = 기간 내 매매 건수 · 최근 30일은 신고 진행 중`;
}

// ---------- KPI ----------
function renderKPIs() {
  const [pa, pb] = prevPeriod();
  const T = sel('매매'), Tp = sel('매매', pa, pb), J = sel('전세'), Jp = sel('전세', pa, pb), W = sel('월세'), Wp = sel('월세', pa, pb);
  // 전세가율: 기간 표본이 적으면 최근 3개월로 계산
  let tr = T, jr = J, jrNote = '선택 기간';
  if (T.length < 5 || J.length < 5) { const a = addMonths(S.to, -3); tr = sel('매매', a, S.to); jr = sel('전세', a, S.to); jrNote = '최근 3개월'; }
  const ratio = avg(tr.map(ppp)) ? avg(jr.map(ppp)) / avg(tr.map(ppp)) * 100 : 0;
  const k = [
    { c: TYPE_COLOR['매매'], l: '매매 거래량', v: `${T.length.toLocaleString()}<small> 건</small>`, d: pct(T.length, Tp.length) },
    { c: TYPE_COLOR['매매'], l: '매매 평균가', v: T.length ? money(avg(T.map(d => d.price)), true) : '-', d: pct(avg(T.map(d => d.price)), avg(Tp.map(d => d.price))) },
    { c: TYPE_COLOR['매매'], l: '매매 평균 평당가', v: T.length ? `${Math.round(avg(T.map(ppp))).toLocaleString()}<small> 만원</small>` : '-', d: pct(avg(T.map(ppp)), avg(Tp.map(ppp))) },
    { c: TYPE_COLOR['전세'], l: '전세 거래량 · 평균 보증금', v: `${J.length.toLocaleString()}<small> 건 · ${J.length ? money(avg(J.map(d => d.deposit)), true) : '-'}</small>`, d: pct(J.length, Jp.length) },
    { c: TYPE_COLOR['전세'], l: `전세가율 (평당가 기준, ${jrNote})`, v: ratio ? `${ratio.toFixed(1)}<small> %</small>` : '-', d: '<span>평균 전세 평당가 ÷ 평균 매매 평당가</span>' },
    { c: TYPE_COLOR['월세'], l: '월세 거래량 · 평균 월세', v: `${W.length.toLocaleString()}<small> 건 · ${W.length ? Math.round(avg(W.map(d => d.rent))) + '만' : '-'}</small>`, d: pct(W.length, Wp.length) },
  ];
  $('#kpis').innerHTML = k.map(x => `<div class="kpi" style="--c:${x.c}"><div class="k-label">${x.l}</div><div class="k-val">${x.v}</div><div class="k-delta">${x.d}</div></div>`).join('');
}

// ---------- TOP 10 ----------
let TOP = [];
function computeTop() {
  const groups = {};
  sel(S.type).forEach(d => {
    const k = `${d.dong}|${d.apt}`;
    (groups[k] ||= { key: k, apt: d.apt, dong: d.dong, deals: [] }).deals.push(d);
  });
  const metric = d => S.type === '월세' ? d.rent * 1e6 + d.deposit : val(d);
  const list = Object.values(groups).map(g => {
    g.deals.sort((a, b) => metric(b) - metric(a));
    g.top = g.deals[0];
    g.count = g.deals.length;
    g.latest = [...g.deals].sort((a, b) => b.date.localeCompare(a.date))[0];
    return g;
  });
  list.sort(S.sort === 'price' ? (a, b) => metric(b.top) - metric(a.top) : (a, b) => b.count - a.count || metric(b.top) - metric(a.top));
  TOP = list.slice(0, 10);
}
function renderTop() {
  const c = TYPE_COLOR[S.type];
  $('#topCard').style.setProperty('--tc', c);
  $('#typeTabs').style.setProperty('--tc', c);
  $('#topScope').textContent = `${S.dong === '전체' ? '서초구 전체' : S.dong} · ${S.from} ~ ${S.to}`;
  if (!TOP.length) { $('#topList').innerHTML = `<li class="empty" style="display:block">선택한 기간·지역에 ${S.type} 거래가 없습니다. 기간을 늘려보세요.</li>`; return; }
  $('#topList').innerHTML = TOP.map((g, i) => {
    const d = S.sort === 'price' ? g.top : g.latest;
    const right = S.sort === 'price'
      ? `${priceText(d)}<small>${S.type === '월세' ? '보증금/월세(만원)' : `평당 ${Math.round(ppp(d)).toLocaleString()}만`}</small>`
      : `${g.count}건<small>최근 ${priceText(d, true)}</small>`;
    return `<li data-key="${esc(g.key)}" class="${S.sel?.key === g.key ? 'sel' : ''}">
      <span class="rank">${i + 1}</span>
      <div><div class="t-name">${esc(g.apt)}</div>
        <div class="t-meta">${g.dong} · 전용 ${d.area}㎡(${py(d.area)}평) · ${d.floor}층 · ${d.date}${d.build ? ' · ' + d.build + '년식' : ''}</div></div>
      <div class="t-price">${right}</div></li>`;
  }).join('');
  $$('#topList li[data-key]').forEach(li => li.onclick = () => {
    const g = TOP.find(x => x.key === li.dataset.key);
    select({ key: g.key, apt: g.apt, dong: g.dong, src: 'top' });
  });
}

// ---------- 지도 ----------
let map, layer;
function initMap() {
  map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView([37.4837, 127.0324], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  $('#btnFitAll').onclick = () => fitAll();
}
const markers = {};
function latestDeal(dong, apt, type) {
  return all().filter(d => d.dong === dong && d.apt === apt && d.t === type).sort((a, b) => b.date.localeCompare(a.date))[0];
}
function popupHtml(dong, apt, extra = '') {
  const deals = all().filter(d => d.dong === dong && d.apt === apt).sort((a, b) => b.date.localeCompare(a.date));
  const build = deals.find(d => d.build)?.build;
  const rows = deals.slice(0, 6).map(d => `<tr><td>${d.date.slice(2)}</td><td>${d.t}</td><td>${d.area}㎡</td><td>${d.floor}층</td><td><b>${priceText(d)}</b></td></tr>`).join('');
  const pos = aptPos(dong, apt);
  return `<div class="pop"><h4>${esc(apt)}</h4><div class="meta">서초구 ${dong}${build ? ` · ${build}년 준공` : ''}${pos.approx ? ' · <span class="approx">위치 근사(동 중심)</span>' : ''}</div>${extra}
    ${rows ? `<table><tr><th>계약일</th><th>유형</th><th>전용</th><th>층</th><th>금액(만원)</th></tr>${rows}</table>` : '<div class="meta">최근 13개월 실거래 없음</div>'}</div>`;
}
function renderMap() {
  if (!map) return;
  layer.clearLayers();
  Object.keys(markers).forEach(k => delete markers[k]);
  const c = TYPE_COLOR[S.type];
  TOP.forEach((g, i) => {
    const p = aptPos(g.dong, g.apt);
    const isSel = S.sel?.key === g.key;
    const last = latestDeal(g.dong, g.apt, S.type);
    const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="mk ${isSel ? 'sel' : ''}" style="background:${c}">${i + 1}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: isSel ? 1000 : 0 })
      .bindTooltip(`<div class="mk-price">${esc(g.apt.length > 9 ? g.apt.slice(0, 9) + '…' : g.apt)} ${last ? priceText(last, true) : ''}</div>`, { permanent: true, direction: 'bottom', offset: [0, 14], className: 'mk-tip' })
      .bindPopup(popupHtml(g.dong, g.apt), { maxWidth: 360 })
      .on('click', () => select({ key: g.key, apt: g.apt, dong: g.dong, src: 'top' }, true));
    m.addTo(layer); markers[g.key] = m;
  });
  LISTINGS.forEach(l => {
    const key = 'L|' + l.id, p = listingPos(l), isSel = S.sel?.key === key;
    const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="mk star ${isSel ? 'sel' : ''}">★</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: isSel ? 1100 : 500 })
      .bindTooltip(`<div class="mk-price" style="border-color:#C79A35">추천 ${esc(l.apt)} ${l.type} ${listingPrice(l, true)}</div>`, { permanent: isSel, direction: 'top', offset: [0, -14], className: 'mk-tip' })
      .bindPopup(popupHtml(l.dong, l.apt, `<div style="margin:4px 0 8px;padding:6px 8px;background:#F6EBD0;border-radius:6px"><b>추천매물</b> ${l.type} ${listingPrice(l)} · 전용 ${l.area}㎡ · ${esc(l.floor || '')} ${esc(l.dir || '')}<br>${esc(l.note || '')}</div>`), { maxWidth: 360 })
      .on('click', () => select({ key, apt: l.apt, dong: l.dong, src: 'listing', listing: l }, true));
    m.addTo(layer); markers[key] = m;
  });
  $('#mapTitle').textContent = `${S.dong === '전체' ? '서초구' : S.dong} ${S.type} TOP 10 위치`;
}
function fitAll() {
  const pts = Object.values(markers).map(m => m.getLatLng());
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 });
}

function select(ent, fromMap) {
  S.sel = ent;
  $$('#topList li').forEach(li => li.classList.toggle('sel', li.dataset.key === ent.key));
  $$('.lst').forEach(el => el.classList.toggle('sel', 'L|' + el.dataset.id === ent.key));
  renderMap();
  const m = markers[ent.key];
  if (m) { map.flyTo(m.getLatLng(), 16, { duration: 0.6 }); setTimeout(() => m.openPopup(), 650); }
  renderAnalysis();
  if (!fromMap && window.innerWidth > 1200) $('#analysisCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- 추천매물 ----------
function loadListings() {
  try { LISTINGS = JSON.parse(localStorage.getItem('seocho_listings')) || null; } catch { LISTINGS = null; }
  if (!LISTINGS) LISTINGS = SAMPLE_LISTINGS.map(x => ({ ...x }));
}
function saveListings() { try { localStorage.setItem('seocho_listings', JSON.stringify(LISTINGS)); } catch {} }
const listingPrice = (l, c) => l.type === '월세' ? `${money(l.price, c)}/${l.rent}` : money(l.price, c);
function listingPos(l) {
  const g = GEO[`${l.dong}|${l.apt}`];
  if (g) return { lat: g.lat, lon: g.lon, approx: false };
  if (l.lat) return { lat: l.lat, lon: l.lon, approx: false };
  return aptPos(l.dong, l.apt);
}
function renderListings() {
  $('#listings').innerHTML = LISTINGS.map(l => {
    const last = latestDeal(l.dong, l.apt, l.type);
    return `<div class="lst ${S.sel?.key === 'L|' + l.id ? 'sel' : ''}" data-id="${l.id}">
      <div class="lst-top"><span class="lst-name">${esc(l.apt)}</span><span class="badge">${l.type}</span></div>
      <div class="lst-body">
        <div class="lst-price">${listingPrice(l)}${l.type === '월세' ? '<small> 보증금/월세(만원)</small>' : ''}</div>
        <div class="lst-spec">${l.dong} · 전용 ${l.area}㎡(${py(l.area)}평) · ${esc(l.floor || '-')} · ${esc(l.dir || '-')}</div>
        <div class="lst-spec">${last ? `최근 ${l.type} 실거래 ${priceText(last)} (${last.date}, ${last.area}㎡)` : '최근 13개월 동일유형 실거래 없음'}</div>
        <div class="lst-note">${esc(l.note || '')}</div>
      </div>
      <button class="lst-del" data-del="${l.id}" title="삭제">삭제</button></div>`;
  }).join('') || '<div class="empty">등록된 매물이 없습니다.</div>';
  $$('.lst').forEach(el => el.onclick = e => {
    if (e.target.dataset.del) {
      if (confirm('이 매물을 삭제할까요?')) { LISTINGS = LISTINGS.filter(x => x.id !== e.target.dataset.del); saveListings(); renderListings(); renderMap(); }
      return;
    }
    const l = LISTINGS.find(x => x.id === el.dataset.id);
    select({ key: 'L|' + l.id, apt: l.apt, dong: l.dong, src: 'listing', listing: l });
  });
}
function initListingDialog() {
  const dlg = $('#dlgListing'), f = $('#formListing');
  f.dong.innerHTML = DONG_ORDER.map(d => `<option>${d}</option>`).join('');
  $('#btnAddListing').onclick = () => { f.reset(); dlg.showModal(); };
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    const l = { id: 'u' + Date.now(), apt: f.apt.value.trim(), dong: f.dong.value, type: f.type.value, price: +f.price.value,
      rent: +f.rent.value || 0, area: +f.area.value, floor: f.floor.value, dir: f.dir.value, note: f.note.value };
    if (!GEO[`${l.dong}|${l.apt}`]) {
      try { const g = await getJSON(`/api/geocode?apt=${encodeURIComponent(l.apt)}&dong=${encodeURIComponent(l.dong)}&road=${encodeURIComponent(ROAD[l.dong + '|' + l.apt] || '')}`); GEO[`${l.dong}|${l.apt}`] = g; } catch {}
    }
    LISTINGS.push(l); saveListings(); renderListings(); renderMap();
    select({ key: 'L|' + l.id, apt: l.apt, dong: l.dong, src: 'listing', listing: l });
  });
}

// ---------- 입지분석 ----------
function nearest(list, lat, lon, n, filter) {
  return (list || []).filter(p => !filter || filter(p)).map(p => ({ ...p, m: hav(lat, lon, p.lat, p.lon) }))
    .sort((a, b) => a.m - b.m).filter((p, i, arr) => arr.findIndex(q => q.n === p.n) === i).slice(0, n);
}
const rowsHtml = list => list.map(p => `<div class="ana-row"><span>${esc(p.n)}${p.badge || ''}</span><span class="d">${distText(p.m)}</span></div>`).join('') || '<div class="ana-row"><span>정보 없음</span></div>';
const lineBadges = n => (STATION_LINES[n] || []).map(l => `<span class="line-badge" style="background:${LINE_COLOR[l] || '#666'}">${l}</span>`).join('');

function renderAnalysis() {
  const e = S.sel;
  if (!e) { $('#analysis').innerHTML = '<div class="empty" style="grid-column:1/-1">TOP 10 또는 추천매물을 클릭하면 교통·학군·상권·개발계획이 한 번에 표시됩니다.</div>'; $('#anaTitle').textContent = '— 아파트를 선택하세요'; return; }
  const pos = e.listing ? listingPos(e.listing) : aptPos(e.dong, e.apt);
  const { lat, lon } = pos;
  $('#anaTitle').innerHTML = `— ${esc(e.apt)} <span style="color:var(--muted)">(${e.dong})</span>${pos.approx ? ' <span class="approx">위치 근사</span>' : ''}`;

  // 요약
  const deals = all().filter(d => d.dong === e.dong && d.apt === e.apt).sort((a, b) => b.date.localeCompare(a.date));
  const lt = deals.find(d => d.t === '매매'), lj = deals.find(d => d.t === '전세');
  const yr = addMonths(S.to, -12);
  const tp = deals.filter(d => d.t === '매매' && d.date >= yr).map(ppp), jp = deals.filter(d => d.t === '전세' && d.date >= yr).map(ppp);
  const ratio = tp.length && jp.length ? median(jp) / median(tp) * 100 : 0;
  const build = deals.find(d => d.build)?.build;

  // 교통
  const subs = nearest(POI.subway, lat, lon, 4).map(s => ({ ...s, badge: lineBadges(s.n) }));
  const busAll = (POI.bus || []).map(b => hav(lat, lon, b[0], b[1]));
  const bus300 = busAll.filter(m => m <= 300).length, bus500 = busAll.filter(m => m <= 500).length, busMin = Math.min(...busAll);
  const hubs = HUBS.map(h => ({ ...h, m: hav(lat, lon, h.lat, h.lon) })).sort((a, b) => a.m - b.m);

  // 학군
  const el = nearest(POI.elem, lat, lon, 3), mi = nearest(POI.middle, lat, lon, 3), hi = nearest(POI.high, lat, lon, 3);

  // 상권
  const marts = nearest(POI.mart, lat, lon, 3);
  const depts = nearest(POI.dept, lat, lon, 3, p => /백화점|아울렛|몰|터미널|면세점|상가|NC|코엑스/.test(p.n));
  const cafes = (POI.cafe || []).map(p => ({ ...p, m: hav(lat, lon, p.lat, p.lon) })).filter(p => p.m <= 500).sort((a, b) => a.m - b.m);
  const govs = nearest(POI.gov, lat, lon, 4, p => /구청|주민센터|행정복지센터|우체국|경찰|파출소|지구대|도서관|법원|청사|등기/.test(p.n));
  const hosp = nearest(POI.hospital, lat, lon, 2), parks = nearest(POI.park, lat, lon, 3, p => !/어린이공원|소공원/.test(p.n));
  const devs = (DEV_PLANS[e.dong] || []).concat(DEV_COMMON);

  const near1 = subs[0];
  const rows = deals.slice(0, 8).map(d => `<tr><td>${d.date}</td><td>${d.t}</td><td>${d.area}㎡ (${py(d.area)}평)</td><td>${d.floor}층</td><td><b>${priceText(d)}</b></td><td>${d.t === '월세' ? '-' : Math.round(ppp(d)).toLocaleString()}</td></tr>`).join('');

  $('#analysis').innerHTML = `
    <div class="ana-summary">
      <div><div class="big">${esc(e.apt)}</div><div style="color:var(--text-2);font-size:12.5px">서울 서초구 ${e.dong}${build ? ` · ${build}년 준공 (${new Date().getFullYear() - build}년차)` : ''}</div></div>
      ${e.listing ? `<span class="pill" style="background:#C79A35;color:#1d1606;border-color:#C79A35">추천매물 ${e.listing.type} ${listingPrice(e.listing)}</span>` : ''}
      <span class="pill">최근 매매 ${lt ? `${money(lt.price)} (${lt.area}㎡, ${lt.date.slice(2)})` : '-'}</span>
      <span class="pill">최근 전세 ${lj ? `${money(lj.deposit)} (${lj.area}㎡, ${lj.date.slice(2)})` : '-'}</span>
      <span class="pill">전세가율 ${ratio ? ratio.toFixed(0) + '%' : '-'}</span>
      ${near1 ? `<span class="pill">${esc(near1.n)} ${distText(near1.m)}</span>` : ''}
    </div>
    <div class="ana-sec"><h4><span class="ic">🚇</span>교통</h4>
      <div class="sub">지하철</div>${rowsHtml(subs)}
      <div class="sub">버스</div>
      <div class="ana-row"><span>반경 300m 정류장</span><span class="d">${bus300}곳</span></div>
      <div class="ana-row"><span>반경 500m 정류장</span><span class="d">${bus500}곳</span></div>
      <div class="ana-row"><span>가장 가까운 정류장</span><span class="d">${isFinite(busMin) ? distText(busMin) : '-'}</span></div>
      <div class="sub">KTX·SRT·광역교통 (직선거리)</div>
      ${hubs.map(h => `<div class="ana-row"><span>${h.n} <small>${h.kind}</small></span><span class="d">${distText(h.m)}</span></div>`).join('')}
    </div>
    <div class="ana-sec"><h4><span class="ic">🏫</span>학군</h4>
      <div class="sub">초등학교</div>${rowsHtml(el)}
      <div class="sub">중학교</div>${rowsHtml(mi)}
      <div class="sub">고등학교</div>${rowsHtml(hi)}
      <p class="hint">※ 실제 배정 학교는 통학구역·학교군에 따라 다르므로 교육청 학구도안내서비스로 확인하세요.</p>
    </div>
    <div class="ana-sec"><h4><span class="ic">🛍️</span>상권·생활편의</h4>
      <div class="sub">대형마트·슈퍼</div>${rowsHtml(marts)}
      <div class="sub">백화점·쇼핑몰</div>${rowsHtml(depts)}
      <div class="sub">커피숍 (반경 500m ${cafes.length}곳)</div>${rowsHtml(cafes.slice(0, 3).map(c => ({ ...c, n: c.n || '카페' })))}
      <div class="sub">관공서</div>${rowsHtml(govs)}
      <div class="sub">병원·공원</div>${rowsHtml(hosp.concat(parks))}
    </div>
    <div class="ana-sec"><h4><span class="ic">🏗️</span>주변 개발계획</h4>
      ${devs.map(d => `<div class="dev-item"><b>${esc(d.t)}<span class="tag">${esc(d.tag)}</span></b><span class="desc">${esc(d.d)}</span></div>`).join('')}
      <p class="hint">※ 공개 보도·고시 기반 요약입니다. 사업 단계·일정은 서울시/서초구 고시로 최종 확인하세요.</p>
    </div>
    <div class="recent-tbl">
      <h3 style="margin-top:4px">최근 실거래 내역 <small>(최근 13개월, 매매·전월세)</small></h3>
      <div class="table-wrap"><table class="tbl"><tr><th>계약일</th><th>유형</th><th>전용면적</th><th>층</th><th>금액(만원)</th><th>평당가(만원)</th></tr>${rows || '<tr><td colspan="6">실거래 내역 없음</td></tr>'}</table></div>
    </div>`;
}

// ---------- 시장동향 차트 ----------
let charts = {};
function buckets() {
  const weekly = S.mode === 'week' || (S.mode === 'custom' && daysBetween(S.from, S.to) <= 92);
  const out = [];
  if (weekly) {
    let end = S.to;
    for (let i = 0; i < 16; i++) { const a = addDays(end, -6); out.unshift({ a, b: end, label: a.slice(5).replace('-', '/') }); end = addDays(a, -1); }
  } else {
    const startM = S.mode === 'custom' && daysBetween(S.from, S.to) > 365 ? S.from : addMonths(S.to, -11);
    let d = parse(startM.slice(0, 8) + '01');
    const last = parse(S.to.slice(0, 8) + '01');
    while (d <= last && out.length < 25) {
      const a = ymd(d), e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      out.push({ a, b: ymd(e) > S.to ? S.to : ymd(e), label: `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}` });
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
  }
  return { weekly, list: out };
}
const baseOpts = (unit) => ({
  responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
  plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
    tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? '-' : Math.round(c.parsed.y * 10) / 10 + (unit || '')}` } } },
  scales: { x: { grid: { display: false }, ticks: { font: { size: 10.5 }, maxRotation: 0, autoSkip: true } },
    y: { grid: { color: '#EEF1F5' }, border: { display: false }, ticks: { font: { size: 10.5 } } } },
});
function drawChart(id, cfg) { charts[id]?.destroy(); charts[id] = new Chart($('#' + id), cfg); }

function renderCharts() {
  const { weekly, list } = buckets();
  const scope = S.dong === '전체' ? '서초구 전체' : S.dong;
  $('#mktScope').textContent = `${scope} · ${weekly ? '주간(최근 16주)' : '월간'} 기준`;
  $('#volUnit').textContent = weekly ? '(주간, 건)' : '(월간, 건)';
  const labels = list.map(b => b.label);
  const series = t => list.map(b => sel(t, b.a, b.b));
  const [T, J, W] = ['매매', '전세', '월세'].map(series);
  drawChart('chVol', { type: 'bar', data: { labels, datasets: ['매매', '전세', '월세'].map((t, i) => ({ label: t, data: [T, J, W][i].map(a => a.length), backgroundColor: TYPE_COLOR[t], borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 14 })) }, options: baseOpts('건') });
  const pppSeries = arr => arr.map(a => a.length ? Math.round(avg(a.map(ppp))) : null);
  drawChart('chPpp', { type: 'line', data: { labels, datasets: [
    { label: '매매', data: pppSeries(T), borderColor: TYPE_COLOR['매매'], backgroundColor: TYPE_COLOR['매매'], borderWidth: 2, pointRadius: 3, tension: .25, spanGaps: true },
    { label: '전세', data: pppSeries(J), borderColor: TYPE_COLOR['전세'], backgroundColor: TYPE_COLOR['전세'], borderWidth: 2, pointRadius: 3, tension: .25, spanGaps: true },
  ] }, options: baseOpts('만원') });
  renderIndex();
}

function renderIndex() {
  if (RONE?.available && RONE.series?.sale?.['서초구']) {
    const s = RONE.series.sale['서초구'], j = RONE.series.jeonse?.['서초구'] || [];
    $('#idxTitle').textContent = '한국부동산원 주간 아파트가격지수 (서초구)';
    $('#idxNote').textContent = '자료: 한국부동산원 R-ONE 주간 아파트가격동향';
    drawChart('chIdx', { type: 'line', data: { labels: s.map(x => String(x[0]).slice(2)), datasets: [
      { label: '매매지수', data: s.map(x => x[1]), borderColor: TYPE_COLOR['매매'], backgroundColor: TYPE_COLOR['매매'], borderWidth: 2, pointRadius: 0, tension: .2 },
      { label: '전세지수', data: j.map(x => x[1]), borderColor: TYPE_COLOR['전세'], backgroundColor: TYPE_COLOR['전세'], borderWidth: 2, pointRadius: 0, tension: .2 },
    ] }, options: baseOpts('') });
    return;
  }
  // R-ONE 키가 없으면 실거래가 기반 자체 지수 (월별 평당가 중위값, 12개월 전 = 100)
  const months = [];
  for (let i = 11; i >= 0; i--) { const d = parse(addMonths(S.to, -i).slice(0, 8) + '01'); const e = new Date(d.getFullYear(), d.getMonth() + 1, 0); months.push({ a: ymd(d), b: ymd(e), label: `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}` }); }
  const idx = t => { const m = months.map(b => { const a = sel(t, b.a, b.b).map(ppp); return a.length >= 3 ? median(a) : null; }); const base = m.find(v => v); return m.map(v => v && base ? v / base * 100 : null); };
  $('#idxTitle').textContent = `실거래가 지수 (${S.dong === '전체' ? '서초구' : S.dong}, 기준=100)`;
  $('#idxNote').textContent = (RONE?.reason || '') + ' 현재는 월별 평당가 중위값으로 산출한 자체 지수입니다.';
  drawChart('chIdx', { type: 'line', data: { labels: months.map(m => m.label), datasets: [
    { label: '매매', data: idx('매매'), borderColor: TYPE_COLOR['매매'], backgroundColor: TYPE_COLOR['매매'], borderWidth: 2, pointRadius: 3, tension: .25, spanGaps: true },
    { label: '전세', data: idx('전세'), borderColor: TYPE_COLOR['전세'], backgroundColor: TYPE_COLOR['전세'], borderWidth: 2, pointRadius: 3, tension: .25, spanGaps: true },
  ] }, options: baseOpts('') });
}

function renderDongTable() {
  const rows = DONG_ORDER.map(dong => {
    const T = sel('매매', S.from, S.to, false).filter(d => d.dong === dong), J = sel('전세', S.from, S.to, false).filter(d => d.dong === dong);
    const tp = avg(T.map(ppp)), jp = avg(J.map(ppp));
    return { dong, tn: T.length, tp, tavg: avg(T.map(d => d.price)), jn: J.length, jp, ratio: T.length >= 5 && J.length >= 5 ? jp / tp * 100 : 0 };   // 표본 5건 미만은 표시 안 함
  }).filter(r => r.tn || r.jn).sort((a, b) => b.tp - a.tp);
  const max = Math.max(...rows.map(r => r.tp), 1);
  $('#dongTable').innerHTML = `<tr><th>법정동</th><th>매매 평균 평당가(만원)</th><th>매매 건수</th><th>매매 평균가</th><th>전세 건수</th><th>전세 평당가</th><th>전세가율</th></tr>` +
    (rows.map(r => `<tr class="${S.dong === r.dong ? 'hl' : ''}"><td>${r.dong}</td>
      <td><div class="bar-cell">${r.tp ? Math.round(r.tp).toLocaleString() : '-'}<i style="width:${r.tp / max * 90}px"></i></div></td>
      <td>${r.tn}</td><td>${r.tn ? money(r.tavg, true) : '-'}</td><td>${r.jn}</td><td>${r.jp ? Math.round(r.jp).toLocaleString() : '-'}</td><td>${r.ratio ? r.ratio.toFixed(1) + '%' : '-'}</td></tr>`).join('') || '<tr><td colspan="7">데이터 없음</td></tr>');
}

function bars(el, items, color) {
  const tot = items.reduce((a, b) => a + b.v, 0) || 1;
  $(el).innerHTML = items.map(x => `<div class="ab"><span>${x.l}</span><div class="track"><div class="fill" style="width:${x.v / tot * 100}%;background:${x.c || color}"></div></div><span class="v">${x.v}건 · ${(x.v / tot * 100).toFixed(0)}%</span></div>`).join('');
}
function renderAreaBars() {
  const T = sel('매매');
  const bands = [['60㎡ 이하 (~18평)', 0, 60], ['60~85㎡ (18~25평)', 60, 85.0001], ['85~102㎡ (26~31평)', 85.0001, 102], ['102~135㎡ (31~41평)', 102, 135], ['135㎡ 초과 (41평~)', 135, 1e9]];
  bars('#areaBars', bands.map(([l, a, b]) => ({ l, v: T.filter(d => d.area > a && d.area <= b || (a === 0 && d.area <= b)).length })), TYPE_COLOR['매매']);
  const R = sel('전세').length, W = sel('월세').length;
  bars('#typeBars', [
    { l: '매매 중개거래', v: T.filter(d => d.gbn !== '직거래').length, c: TYPE_COLOR['매매'] },
    { l: '매매 직거래', v: T.filter(d => d.gbn === '직거래').length, c: '#8fb6e8' },
  ]);
  $('#typeBars').insertAdjacentHTML('beforeend', `<div class="ab"><span>전세 : 월세</span><div class="track" style="display:flex"><div class="fill" style="width:${R / ((R + W) || 1) * 100}%;background:${TYPE_COLOR['전세']};border-radius:0"></div><div class="fill" style="flex:1;background:${TYPE_COLOR['월세']}"></div></div><span class="v">${R} : ${W}건</span></div>`);
}

async function renderApply() {
  try {
    const list = await getJSON('/api/apply');
    const sorted = [...list.filter(d => (d.HSSPLY_ADRES || '').includes('서초')), ...list.filter(d => !(d.HSSPLY_ADRES || '').includes('서초'))].slice(0, 15);
    $('#applyTable').innerHTML = `<tr><th>단지명</th><th>공급위치</th><th>세대수</th><th>모집공고일</th><th>청약접수</th><th>당첨발표</th><th>입주예정</th><th></th></tr>` +
      sorted.map(d => `<tr class="${(d.HSSPLY_ADRES || '').includes('서초') ? 'hl' : ''}"><td>${esc(d.HOUSE_NM)}</td><td style="text-align:left">${esc((d.HSSPLY_ADRES || '').replace('서울특별시 ', ''))}</td><td>${d.TOT_SUPLY_HSHLDCO || '-'}</td><td>${d.RCRIT_PBLANC_DE || '-'}</td><td>${d.RCEPT_BGNDE || ''} ~ ${(d.RCEPT_ENDDE || '').slice(5)}</td><td>${d.PRZWNER_PRESNATN_DE || '-'}</td><td>${d.MVN_PREARNGE_YM ? d.MVN_PREARNGE_YM.slice(0, 4) + '.' + d.MVN_PREARNGE_YM.slice(4) : '-'}</td><td>${d.PBLANC_URL ? `<a href="${esc(d.PBLANC_URL)}" target="_blank" rel="noopener">공고</a>` : ''}</td></tr>`).join('');
  } catch (e) { $('#applyTable').innerHTML = `<tr><td>청약 정보를 불러오지 못했습니다: ${esc(e.message)}</td></tr>`; }
}

// ---------- 전체 렌더 ----------
function renderAll() {
  renderDongChips(); renderKPIs(); computeTop(); renderTop(); renderListings(); renderMap(); renderCharts(); renderDongTable(); renderAreaBars();
  if (S.sel && S.sel.src === 'top' && !TOP.find(g => g.key === S.sel.key)) S.sel = null;
  if (!S.sel && TOP[0]) S.sel = { key: TOP[0].key, apt: TOP[0].apt, dong: TOP[0].dong, src: 'top' };
  renderAnalysis();
  $$('#topList li').forEach(li => li.classList.toggle('sel', li.dataset.key === S.sel?.key));
  fitAll();
}
async function refresh() {
  try { await loadData(); renderAll(); }
  catch (e) { $('#loading').hidden = true; $('#errorBox').hidden = false; $('#errorBox').textContent = '데이터 조회 실패: ' + e.message + ' (server.py 가 실행 중인지 확인하세요)'; }
}

async function init() {
  S.to = ymd(new Date());
  setMode('month');
  initMap(); loadListings(); initListingDialog();
  $$('#modeSeg button').forEach(b => b.onclick = () => { setMode(b.dataset.mode, b.dataset.mode === 'custom'); if (b.dataset.mode !== 'custom') refresh(); });
  $('#dTo').onchange = () => { S.to = $('#dTo').value; if (S.mode !== 'custom') setMode(S.mode); };
  $('#dFrom').onchange = () => { S.from = $('#dFrom').value; setMode('custom', true); };
  $('#btnApply').onclick = () => {
    S.from = $('#dFrom').value; S.to = $('#dTo').value;
    if (S.from > S.to) [S.from, S.to] = [S.to, S.from];
    setMode(S.mode, true); refresh();
  };
  $$('#typeTabs button').forEach(b => b.onclick = () => {
    S.type = b.dataset.type; $$('#typeTabs button').forEach(x => x.classList.toggle('on', x === b));
    S.sel = null; computeTop(); renderAll();
  });
  $$('#sortSeg button').forEach(b => b.onclick = () => {
    S.sort = b.dataset.sort; $$('#sortSeg button').forEach(x => x.classList.toggle('on', x === b)); S.sel = null; renderAll();
  });
  const [geo, poi] = await Promise.all([getJSON('/api/geocache').catch(() => ({})), getJSON('/data/pois.json').catch(() => ({}))]);
  GEO = geo; POI = poi;
  getJSON('/api/rone').then(r => { RONE = r; if (DATA.range) renderIndex(); }).catch(() => {});
  renderApply();
  await refresh();
}
init();
