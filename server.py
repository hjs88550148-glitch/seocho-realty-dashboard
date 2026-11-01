# -*- coding: utf-8 -*-
"""
서초구 부동산 대시보드 - 로컬 서버
 - 정적 파일(static/, data/) 제공
 - 공공데이터포털 / 한국부동산원(R-ONE) / 청약홈 API 프록시 (CORS 우회 + 캐시)
 - 아파트 좌표 지오코딩 (OpenStreetMap Nominatim, 결과는 data/geocache.json 에 저장)
표준 라이브러리만 사용합니다. 실행: python server.py
"""
import json, os, re, sys, time, threading, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
if not os.path.exists(os.path.join(ROOT, 'config.json')):
    sys.exit('config.json 이 없습니다. config.example.json 을 config.json 으로 복사한 뒤 인증키를 입력하세요.')
CFG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))
CACHE_DIR = os.path.join(ROOT, 'cache')
GEO_FILE = os.path.join(ROOT, 'data', 'geocache.json')
os.makedirs(CACHE_DIR, exist_ok=True)

UA = 'SeochoRealtyDashboard/1.0 (local briefing tool)'
EP = {
    'trade': 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
    'rent': 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
}


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def cache_get(name, max_age):
    p = os.path.join(CACHE_DIR, name)
    if os.path.exists(p) and (max_age is None or time.time() - os.path.getmtime(p) < max_age):
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return None


def cache_put(name, obj):
    with open(os.path.join(CACHE_DIR, name), 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def num(s):
    s = (s or '').replace(',', '').strip()
    try:
        return float(s) if '.' in s else int(s)
    except ValueError:
        return 0


# ---------------- 국토교통부 실거래가 ----------------
def fetch_month(kind, ym):
    """한 달치 실거래 자료. 신고기한(30일)이 지난 과거 달은 영구 캐시, 최근 2개월은 6시간 캐시."""
    name = f'{kind}_{CFG["lawd_cd"]}_{ym}.json'
    today = date.today()
    months_ago = (today.year * 12 + today.month) - (int(ym[:4]) * 12 + int(ym[4:]))
    cached = cache_get(name, None if months_ago >= 3 else 6 * 3600)
    if cached is not None:
        return cached
    items, page = [], 1
    while True:
        q = urllib.parse.urlencode({'serviceKey': CFG['data_go_kr_key'], 'LAWD_CD': CFG['lawd_cd'],
                                    'DEAL_YMD': ym, 'numOfRows': 1000, 'pageNo': page})
        root = ET.fromstring(http_get(f'{EP[kind]}?{q}'))
        code = root.findtext('.//resultCode')
        if code not in ('000', '00'):
            raise RuntimeError(f'API 오류 {code}: {root.findtext(".//resultMsg")}')
        for it in root.iter('item'):
            g = lambda k: (it.findtext(k) or '').strip()
            if g('cdealType'):          # 해제(취소)된 거래 제외
                continue
            d = {
                'apt': g('aptNm'), 'dong': g('umdNm'), 'jibun': g('jibun'),
                'area': num(g('excluUseAr')), 'floor': num(g('floor')), 'build': num(g('buildYear')),
                'date': f"{g('dealYear')}-{int(g('dealMonth')):02d}-{int(g('dealDay')):02d}",
            }
            if kind == 'trade':
                d.update(t='매매', price=num(g('dealAmount')), gbn=g('dealingGbn'))
            else:
                rent = num(g('monthlyRent'))
                d.update(t='월세' if rent else '전세', deposit=num(g('deposit')), rent=rent,
                         road=g('roadnm'), ctype=g('contractType'))
            items.append(d)
        total = int(root.findtext('.//totalCount') or 0)
        if page * 1000 >= total:
            break
        page += 1
    cache_put(name, items)
    return items


def month_range(a, b):
    y, m = int(a[:4]), int(a[4:])
    out = []
    while y * 100 + m <= int(b):
        out.append(f'{y}{m:02d}')
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


POOL = ThreadPoolExecutor(6)


def get_deals(kind, frm, to):
    months = month_range(frm, to)[-25:]
    res, errors = [], []
    for ym, fut in [(ym, POOL.submit(fetch_month, kind, ym)) for ym in months]:
        try:
            res.extend(fut.result())
        except Exception as e:  # 한 달 실패해도 나머지는 표시
            errors.append(f'{ym}: {e}')
    return {'items': res, 'months': months, 'errors': errors}


# ---------------- 청약홈 분양정보 (한국부동산원) ----------------
def get_apply():
    cached = cache_get('apply.json', 12 * 3600)
    if cached is not None:
        return cached
    q = urllib.parse.urlencode({'page': 1, 'perPage': 100, 'serviceKey': CFG['data_go_kr_key'],
                                'cond[SUBSCRPT_AREA_CODE_NM::EQ]': '서울'})
    url = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail?' + q
    data = json.loads(http_get(url)).get('data', [])
    keep = ['HOUSE_NM', 'HSSPLY_ADRES', 'TOT_SUPLY_HSHLDCO', 'RCRIT_PBLANC_DE', 'RCEPT_BGNDE', 'RCEPT_ENDDE',
            'PRZWNER_PRESNATN_DE', 'MVN_PREARNGE_YM', 'CNSTRCT_ENTRPS_NM', 'HOUSE_SECD_NM', 'PBLANC_URL']
    out = sorted([{k: d.get(k) for k in keep} for d in data], key=lambda d: d.get('RCRIT_PBLANC_DE') or '', reverse=True)
    cache_put('apply.json', out)
    return out


# ---------------- 한국부동산원 R-ONE (키 등록 시) ----------------
RONE = 'https://www.reb.or.kr/r-one/openapi/'


def rone_call(path, **params):
    params.update(KEY=CFG['rone_key'], Type='json')
    return json.loads(http_get(RONE + path + '?' + urllib.parse.urlencode(params)))


def rone_find_tables():
    """통계표 목록에서 주간 아파트 매매/전세 가격지수 표를 이름으로 찾는다."""
    found, page = {}, 1
    while page < 10:
        d = rone_call('SttsApiTbl.do', pIndex=page, pSize=100)
        part = d.get('SttsApiTbl', [])
        rows = part[1]['row'] if len(part) > 1 else []
        for r in rows:
            n, cyc = r['STATBL_NM'], r['DTACYCLE_CD']
            if cyc == 'WK' and '아파트' in n and '매매가격지수' in n and 'sale' not in found:
                found['sale'] = r['STATBL_ID']
            if cyc == 'WK' and '아파트' in n and '전세가격지수' in n and 'jeonse' not in found:
                found['jeonse'] = r['STATBL_ID']
        if len(rows) < 100 or len(found) == 2:
            break
        page += 1
    return found


def get_rone_index():
    if not CFG.get('rone_key'):
        return {'available': False, 'reason': 'config.json 에 rone_key(한국부동산원 R-ONE 인증키)를 입력하면 주간 아파트가격지수가 표시됩니다.'}
    cached = cache_get('rone_index.json', 12 * 3600)
    if cached is not None:
        return cached
    tables = rone_find_tables()
    out = {'available': True, 'tables': tables, 'series': {}}
    for key, tid in tables.items():
        rows, page = [], 1
        while page < 30:
            d = rone_call('SttsApiTblData.do', STATBL_ID=tid, DTACYCLE_CD='WK', pIndex=page, pSize=1000)
            part = d.get('SttsApiTblData', [])
            chunk = part[1]['row'] if len(part) > 1 else []
            rows += [r for r in chunk if '서초' in (r.get('CLS_FULLNM') or r.get('CLS_NM') or '') or (r.get('CLS_NM') in ('서울', '서울특별시'))]
            if len(chunk) < 1000:
                break
            page += 1
        series = {}
        for r in rows:
            nm = '서초구' if '서초' in (r.get('CLS_FULLNM') or r.get('CLS_NM') or '') else '서울'
            series.setdefault(nm, []).append([r.get('WRTTIME_IDTFR_ID'), num(str(r.get('DTA_VAL')))])
        for v in series.values():
            v.sort()
        out['series'][key] = {k: v[-52:] for k, v in series.items()}
    cache_put('rone_index.json', out)
    return out


# ---------------- 지오코딩 ----------------
GEO_LOCK = threading.Lock()
GEO = json.load(open(GEO_FILE, encoding='utf-8')) if os.path.exists(GEO_FILE) else {}
_last_nominatim = [0.0]


def nominatim(q):
    with GEO_LOCK:
        wait = 1.1 - (time.time() - _last_nominatim[0])
        if wait > 0:
            time.sleep(wait)
        _last_nominatim[0] = time.time()
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(
        {'format': 'json', 'limit': 1, 'countrycodes': 'kr', 'q': q,
         'viewbox': '126.95,37.53,127.10,37.42', 'bounded': 1})
    try:
        r = json.loads(http_get(url, 15))
        if r:
            return [round(float(r[0]['lat']), 6), round(float(r[0]['lon']), 6)]
    except Exception:
        pass
    return None


# OSM 에 등록된 서초·강남 일대 아파트 단지명 → 중심좌표 (data/osm_apts.json)
OSM_APTS = json.load(open(os.path.join(ROOT, 'data', 'osm_apts.json'), encoding='utf-8')) \
    if os.path.exists(os.path.join(ROOT, 'data', 'osm_apts.json')) else {}
DONG_CENTER = {'서초동': (37.4877, 127.0174), '반포동': (37.5045, 127.0), '잠원동': (37.513, 127.011),
               '방배동': (37.487, 126.99), '양재동': (37.47, 127.038), '우면동': (37.465, 127.02),
               '원지동': (37.442, 127.043), '신원동': (37.448, 127.06), '염곡동': (37.46, 127.055), '내곡동': (37.453, 127.073)}


def norm(n):
    n = re.sub(r'\(.*?\)|\s|아파트|APT|apt', '', n)
    n = re.sub(r'(\d+)차', r'\1', n)
    return n.lower()


OSM_NORM = [(norm(k), v) for k, v in OSM_APTS.items()]


def osm_match(apt, dong):
    a = norm(apt)
    if len(a) < 2:
        return None
    c = DONG_CENTER.get(dong, (37.48, 127.03))
    dist = lambda v: (v[0] - c[0]) ** 2 + ((v[1] - c[1]) * 0.79) ** 2
    near = lambda v: dist(v) < 0.025 ** 2          # 동 중심 약 2.8km 이내
    for test in (lambda n: n == a,
                 lambda n: n.startswith(a) and (not n[len(a):len(a) + 1].isdigit() or re.fullmatch(r'\d+단지', n[len(a):])),
                 lambda n: a.startswith(n) and len(n) >= 4,
                 lambda n: len(a) >= 5 and a in n):
        cands = [v for n, v in OSM_NORM if test(n) and near(v)]
        if cands:
            return min(cands, key=dist)
    return None


def geocode(apt, dong, road='', jibun=''):
    key = f'{dong}|{apt}'
    if GEO.get(key) and GEO[key].get('src') == 'osm':
        return GEO[key]
    m = osm_match(apt, dong)
    if m:
        val = {'lat': m[0], 'lon': m[1], 'src': 'osm'}
        with GEO_LOCK:
            GEO[key] = val
        save_geo()
        return val
    if key in GEO:
        return GEO[key]
    pos, src = None, ''
    for q, s in ((f'서울 서초구 {road}', 'road') if road else (None, None),
                 (f'서초구 {apt}', 'name'), (f'서울 서초구 {dong} {jibun}', 'jibun') if jibun else (None, None)):
        if q and not pos:
            pos = nominatim(q)
            src = s
    val = {'lat': pos[0], 'lon': pos[1], 'src': src} if pos else None
    with GEO_LOCK:
        GEO[key] = val
    save_geo()
    return val


def save_geo():
    with GEO_LOCK:
        if os.path.exists(GEO_FILE):  # 다른 프로세스(--warm)가 쓴 내용과 병합
            try:
                GEO.update({k: v for k, v in json.load(open(GEO_FILE, encoding='utf-8')).items() if k not in GEO})
            except ValueError:
                pass
        with open(GEO_FILE, 'w', encoding='utf-8') as f:
            json.dump(GEO, f, ensure_ascii=False, indent=0)


# ---------------- HTTP ----------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if '/api/' in (args[0] if args else ''):
            sys.stderr.write('%s %s\n' % (datetime.now().strftime('%H:%M:%S'), fmt % args))

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == '/':
                self.path = '/static/index.html'
                return super().do_GET()
            if u.path == '/api/deals':
                return self.send_json(get_deals(q['kind'], q['from'], q['to']))
            if u.path == '/api/apply':
                return self.send_json(get_apply())
            if u.path == '/api/rone':
                return self.send_json(get_rone_index())
            if u.path == '/api/geocode':
                return self.send_json(geocode(q.get('apt', ''), q.get('dong', ''), q.get('road', ''), q.get('jibun', '')))
            if u.path == '/api/geocache':
                return self.send_json(GEO)
            if u.path.startswith(('/static/', '/data/')):
                return super().do_GET()
            self.send_error(404)
        except Exception as e:
            self.send_json({'error': str(e)}, 500)


def upgrade_geo():
    """캐시된 실거래 단지 전체를 OSM 단지명과 오프라인 매칭 (서버 시작 시 1회, 수 초 이내)."""
    keys = set(GEO)
    for f in os.listdir(CACHE_DIR):
        if f.startswith(('trade_', 'rent_')):
            keys |= {f"{d['dong']}|{d['apt']}" for d in json.load(open(os.path.join(CACHE_DIR, f), encoding='utf-8'))}
    n = 0
    for k in keys:
        if GEO.get(k) and GEO[k].get('src') == 'osm':
            continue
        dong, apt = k.split('|', 1)
        m = osm_match(apt, dong)
        if m:
            GEO[k] = {'lat': m[0], 'lon': m[1], 'src': 'osm'}
            n += 1
    if n:
        save_geo()
    return n


def warm(months=12):
    """최근 n개월 거래 아파트 좌표를 미리 확보 (python server.py --warm)."""
    today = date.today()
    to = f'{today.year}{today.month:02d}'
    y, m = today.year, today.month - months + 1
    while m < 1:
        y, m = y - 1, m + 12
    frm = f'{y}{m:02d}'
    roads, apts = {}, {}
    for d in get_deals('rent', frm, to)['items']:
        if d.get('road'):
            roads[f"{d['dong']}|{d['apt']}"] = d['road']
    for kind in ('trade', 'rent'):
        for d in get_deals(kind, frm, to)['items']:
            apts.setdefault(f"{d['dong']}|{d['apt']}", d.get('jibun', ''))
    todo = [k for k in apts if k not in GEO]
    print(f'아파트 {len(apts)}개 중 좌표 미확보 {len(todo)}개 지오코딩 시작')
    for i, k in enumerate(todo, 1):
        dong, apt = k.split('|', 1)
        r = geocode(apt, dong, roads.get(k, ''), apts[k])
        print(f'[{i}/{len(todo)}] {k} -> {r}')


if __name__ == '__main__':
    if '--warm' in sys.argv:
        warm()
        sys.exit()
    print(f'단지 좌표 OSM 매칭 {upgrade_geo()}건 갱신')
    port = CFG.get('port', 8650)
    print(f'서초구 부동산 대시보드: http://localhost:{port}  (종료: Ctrl+C)')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
