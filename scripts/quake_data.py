#!/usr/bin/env python3
"""地震ユースケース(#106)用の前処理バッチ(ランタイムでは使わない)。

地震は水害と違って予報が出ず、「どこへ逃げるか」の判断材料が事前のリスク分布しかない。
東京都が公表する2系統のオープンデータを、クライアントが引ける軽量な形へ落とす。

  1. 地震に関する地域危険度測定調査(第9回・都市整備局) … 町丁目5,192件のポリゴン＋
     建物倒壊/火災/総合の危険度ランク(1〜5)。SHPは平面直角座標系第9系(JGD2000)なので経緯度へ逆変換する。
       → public/data/quake_risk.geojson

  2. 震度分布・液状化(令和4年度 首都直下地震等による東京の被害想定・総務局) … 計測震度は
     50mメッシュ(約69万件/13.7MB)、液状化は250mメッシュ。50mのままでは配信できないため
     250mメッシュへ集約(セル内の最大=保守側)し、液状化と同じ格子に統合する。
       → public/data/quake_grid.json

使い方:
  scripts/quake_data.py           # data-raw/quake/ に無ければ自動DL
出力:
  public/data/quake_risk.geojson  FeatureCollection(町丁目ポリゴン + 危険度ランク)
  public/data/quake_grid.json     { "cellLat":..., "cellLon":..., "cells": { "iLat,iLon": [震度, PL値, 沈下量m] } }
"""
import csv, json, math, os, sys, urllib.request, zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
RAWDIR = os.path.join(ROOT, 'data-raw', 'quake')
OUT_RISK = os.path.join(ROOT, 'public', 'data', 'quake_risk.geojson')
OUT_GRID = os.path.join(ROOT, 'public', 'data', 'quake_grid.json')

# 想定地震シナリオ。東京都の被害想定8シナリオのうち、都が「首都直下地震の代表」として
# 被害が最大級となる都心南部直下地震(M7.3)を採用する。複数シナリオを同梱すると配信量が
# 8倍になるうえ、利用者に選ばせても避難行動の判断は変わらないため1本に絞る。
SCENARIO = '都心南部直下地震（M7.3・冬夕方・風速8m/s）'
SHINDO_URL = 'https://www.opendata.metro.tokyo.lg.jp/soumu/0_keisokusinndo50m_tosinnnannbutyokka.csv'
LIQUEFACTION_URL = 'https://www.opendata.metro.tokyo.lg.jp/soumu/9_ekijyouka250m_tosinnnannbutyokka.csv'
# 第9回地域危険度(令和4年9月公表)のSHP一式(zip)。ファイル名が日本語なのでzipfileで個別展開する
KIKENDO_SHP_URL = 'https://www.toshiseibi.metro.tokyo.lg.jp/bosai/chousa_6/download/all2.zip'

# 250mメッシュ(5次メッシュ)の1辺。標準地域メッシュに一致させ、液状化データの
# 中心座標と震度50mメッシュが同じセルに落ちるようにする
CELL_LAT = 7.5 / 3600      # 緯度 7.5秒
CELL_LON = 11.25 / 3600    # 経度 11.25秒

# ポリゴン簡素化の許容誤差(度・約15m)と座標の丸め桁(約10m)。
# 生のSHPは13MB・約28万点あり配信できない。危険度は町丁目単位の面表示であり、
# 境界が十数mずれても判断は変わらないため、この粒度まで落として1.7MB程度に収める。
SIMPLIFY_EPS = 0.00015
COORD_DIGITS = 4


# --- 平面直角座標系(JGD2000 第9系) → 経緯度 -------------------------------------
# 国土地理院「平面直角座標への換算」の逆算式(ガウス・クリューゲル)。pyprojへの依存を避けるため自前実装。
# 検証: 原点(0,0) → (139.8333…, 36.0) と厳密一致することを確認済み。
_A = 6378137.0            # GRS80 長半径
_F = 1.0 / 298.257222101  # GRS80 扁平率
_M0 = 0.9999              # 平面直角座標系の縮尺係数
_PHI0 = math.radians(36.0)                # 第9系の原点緯度
_LAMBDA0 = math.radians(139 + 50 / 60)    # 第9系の原点経度


def _jpr_coeffs():
    n = _F / (2 - _F)
    a = [
        1 + n**2 / 4 + n**4 / 64,
        -3 / 2 * (n - n**3 / 8 - n**5 / 64),
        15 / 16 * (n**2 - n**4 / 4),
        -35 / 48 * (n**3 - 5 / 16 * n**5),
        315 / 512 * n**4,
        -693 / 1280 * n**5,
    ]
    beta = [
        1 / 2 * n - 2 / 3 * n**2 + 37 / 96 * n**3 - 1 / 360 * n**4 - 81 / 512 * n**5,
        1 / 48 * n**2 + 1 / 15 * n**3 - 437 / 1440 * n**4 + 46 / 105 * n**5,
        17 / 480 * n**3 - 37 / 840 * n**4 - 209 / 4480 * n**5,
        4397 / 161280 * n**4 - 11 / 504 * n**5,
        4583 / 161280 * n**5,
    ]
    delta = [
        2 * n - 2 / 3 * n**2 - 2 * n**3 + 116 / 45 * n**4 + 26 / 45 * n**5 - 2854 / 675 * n**6,
        7 / 3 * n**2 - 8 / 5 * n**3 - 227 / 45 * n**4 + 2704 / 315 * n**5 + 2323 / 945 * n**6,
        56 / 15 * n**3 - 136 / 35 * n**4 - 1262 / 105 * n**5 + 73814 / 2835 * n**6,
        4279 / 630 * n**4 - 332 / 35 * n**5 - 399572 / 14175 * n**6,
        4174 / 315 * n**5 - 144838 / 6237 * n**6,
        601676 / 22275 * n**6,
    ]
    return n, a, beta, delta


_N, _AJ, _BETA, _DELTA = _jpr_coeffs()
_A_BAR = _M0 * _A / (1 + _N) * _AJ[0]
_S_PHI0 = _M0 * _A / (1 + _N) * (
    _AJ[0] * _PHI0 + sum(_AJ[j] * math.sin(2 * j * _PHI0) for j in range(1, 6))
)


def jpr9_to_lonlat(east, north):
    """第9系の (東方向m, 北方向m) → (経度, 緯度) 度"""
    xi = (north + _S_PHI0) / _A_BAR
    eta = east / _A_BAR
    xi2 = xi - sum(_BETA[j - 1] * math.sin(2 * j * xi) * math.cosh(2 * j * eta) for j in range(1, 6))
    eta2 = eta - sum(_BETA[j - 1] * math.cos(2 * j * xi) * math.sinh(2 * j * eta) for j in range(1, 6))
    chi = math.asin(math.sin(xi2) / math.cosh(eta2))
    lat = chi + sum(_DELTA[j - 1] * math.sin(2 * j * chi) for j in range(1, 7))
    lon = _LAMBDA0 + math.atan2(math.sinh(eta2), math.cos(xi2))
    return math.degrees(lon), math.degrees(lat)


# --- 50mメッシュコード(12桁) → セル中心の経緯度 ---------------------------------
def mesh50m_center(code):
    """50mメッシュコード(3次メッシュ8桁 + 緯度方向2桁 + 経度方向2桁, 各00〜19)の中心座標。

    3次メッシュ(約1km)を緯度・経度それぞれ20分割したもの。分割番号は南西を起点に 00〜19。
    """
    if len(code) != 12 or not code.isdigit():
        return None
    lat = int(code[0:2]) / 1.5                    # 1次メッシュ
    lon = int(code[2:4]) + 100
    lat += int(code[4]) * (5 / 60)                # 2次メッシュ(緯度5分・経度7分30秒)
    lon += int(code[5]) * (7.5 / 60)
    lat += int(code[6]) * (30 / 3600)             # 3次メッシュ(緯度30秒・経度45秒)
    lon += int(code[7]) * (45 / 3600)
    dlat = 30 / 3600 / 20                         # 50mメッシュ1辺(緯度1.5秒・経度2.25秒)
    dlon = 45 / 3600 / 20
    lat += (int(code[8:10]) + 0.5) * dlat
    lon += (int(code[10:12]) + 0.5) * dlon
    return lon, lat


def cell_key(lon, lat):
    return f'{math.floor(lat / CELL_LAT)},{math.floor(lon / CELL_LON)}'


# --- ダウンロード ---------------------------------------------------------------
def ensure(url, filename):
    """data-raw/quake/ に無ければ取得する。一時ファイル→os.replaceで壊れた中間物を残さない"""
    os.makedirs(RAWDIR, exist_ok=True)
    path = os.path.join(RAWDIR, filename)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    print('downloading', url)
    req = urllib.request.Request(url, headers={'User-Agent': 'dare-hinan-navi/0.1 (hackathon)'})
    tmp = path + '.part'
    try:
        with urllib.request.urlopen(req, timeout=180) as r, open(tmp, 'wb') as o:
            o.write(r.read())
        os.replace(tmp, path)
    except Exception as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        print('  download failed:', e, file=sys.stderr)
        return None
    return path


def read_rows(path):
    """CP932優先で読む(東京都のCSVはCP932が多い)。失敗したらUTF-8"""
    for enc in ('cp932', 'utf-8-sig'):
        try:
            with open(path, encoding=enc) as f:
                return list(csv.reader(f))
        except UnicodeDecodeError:
            continue
    raise RuntimeError(f'cannot decode {path}')


# --- 1) 地域危険度 SHP → GeoJSON ------------------------------------------------
def _simplify(ring, eps):
    """Douglas-Peucker。リングの始終点は保持する"""
    if len(ring) <= 4:
        return ring
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    while stack:
        s, e = stack.pop()
        if e <= s + 1:
            continue
        x1, y1 = ring[s]
        x2, y2 = ring[e]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy)
        far, fd = -1, eps
        for i in range(s + 1, e):
            x, y = ring[i]
            # 線分が退化している場合は端点からの距離で代用
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm if norm > 0 else math.hypot(x - x1, y - y1)
            if d > fd:
                far, fd = i, d
        if far > 0:
            keep[far] = True
            stack.append((s, far))
            stack.append((far, e))
    out = [p for p, k in zip(ring, keep) if k]
    # 簡素化で3点未満に潰れたら元のリングを返す(不正なポリゴンを作らない)
    return out if len(out) >= 4 else ring


def _round_ring(ring):
    """COORD_DIGITS桁に丸め、連続する重複点を除去する"""
    out = []
    for x, y in ring:
        p = (round(x, COORD_DIGITS), round(y, COORD_DIGITS))
        if not out or out[-1] != p:
            out.append(p)
    if len(out) >= 3 and out[0] != out[-1]:
        out.append(out[0])
    return out


def _convert_coords(geom):
    """__geo_interface__ の座標(平面直角9系)を経緯度へ変換し、簡素化・丸めをかける"""
    def ring_conv(ring):
        conv = [jpr9_to_lonlat(x, y) for x, y in ring]
        return _round_ring(_simplify(conv, SIMPLIFY_EPS))

    t = geom['type']
    if t == 'Polygon':
        rings = [ring_conv(r) for r in geom['coordinates']]
        rings = [r for r in rings if len(r) >= 4]
        return {'type': 'Polygon', 'coordinates': rings} if rings else None
    if t == 'MultiPolygon':
        polys = []
        for poly in geom['coordinates']:
            rings = [ring_conv(r) for r in poly]
            rings = [r for r in rings if len(r) >= 4]
            if rings:
                polys.append(rings)
        return {'type': 'MultiPolygon', 'coordinates': polys} if polys else None
    return None


def build_risk():
    try:
        import shapefile  # pyshp
    except ImportError:
        print('pyshp が必要です: pip install pyshp', file=sys.stderr)
        return None

    zip_path = ensure(KIKENDO_SHP_URL, 'kikendo_shp.zip')
    if not zip_path:
        return None
    # zip内のファイル名が日本語(CP932)でunzipが失敗するため、拡張子だけ見て英名で展開する
    base = os.path.join(RAWDIR, 'kikendo')
    if not os.path.exists(base + '.shp'):
        with zipfile.ZipFile(zip_path) as z:
            for info in z.infolist():
                ext = os.path.splitext(info.filename)[1].lower()
                if ext in ('.shp', '.shx', '.dbf', '.prj'):
                    with open(base + ext, 'wb') as f:
                        f.write(z.read(info))

    r = shapefile.Reader(base, encoding='cp932')
    fields = [f[0] for f in r.fields[1:]]
    idx = {name: i for i, name in enumerate(fields)}
    feats = []
    for sr in r.iterShapeRecords():
        if sr.shape.shapeType == 0:  # NULL shape
            continue
        gi = sr.shape.__geo_interface__
        geom = _convert_coords(gi) if gi else None
        if not geom:
            continue
        rec = sr.record
        feats.append({
            'type': 'Feature',
            'geometry': geom,
            'properties': {
                'city': str(rec[idx['区市町村名']]).strip(),
                'chome': str(rec[idx['町丁目名']]).strip(),
                # ランクは1(低)〜5(高)。数値のまま持ち、表示ラベルはクライアント側で当てる
                'buildingRank': int(rec[idx['建物_ラ']]),
                'fireRank': int(rec[idx['火災_ラ']]),
                'totalRank': int(rec[idx['総合_ラ']]),
            },
        })
    print(f'risk: {len(feats)} features')
    return {
        'type': 'FeatureCollection',
        'features': feats,
    }


# --- 2) 計測震度(50m) + 液状化(250m) → 250mグリッド ------------------------------
def build_grid():
    cells = {}  # key -> [震度, PL値, 沈下量m]

    shindo_path = ensure(SHINDO_URL, 'shindo50m.csv')
    if shindo_path:
        n = 0
        # 69万行を辞書に溜めるため、csv.readerで1行ずつ処理する
        with open(shindo_path, encoding='cp932') as f:
            for i, row in enumerate(csv.reader(f)):
                if i == 0 or len(row) < 2:
                    continue
                c = mesh50m_center(row[0].strip())
                if not c:
                    continue
                try:
                    v = float(row[1])
                except ValueError:
                    continue
                k = cell_key(*c)
                cur = cells.get(k)
                # 250mセル内に50mメッシュが25個入る。避難判断は安全側に倒すため最大値を採る
                if cur is None:
                    cells[k] = [v, None, None]
                elif cur[0] is None or v > cur[0]:
                    cur[0] = v
                n += 1
        print(f'shindo: {n} meshes -> {len(cells)} cells')

    liq_path = ensure(LIQUEFACTION_URL, 'liquefaction250m.csv')
    if liq_path:
        rows = read_rows(liq_path)
        n = 0
        for row in rows[1:]:
            if len(row) < 5:
                continue
            try:
                lon, lat = float(row[1]), float(row[2])
                pl, sink = float(row[3]), float(row[4])
            except ValueError:
                continue
            k = cell_key(lon, lat)
            cur = cells.get(k)
            if cur is None:
                cells[k] = [None, pl, sink]
            else:
                cur[1] = pl if cur[1] is None else max(cur[1], pl)
                cur[2] = sink if cur[2] is None else max(cur[2], sink)
            n += 1
        print(f'liquefaction: {n} meshes -> {len(cells)} cells total')

    if not cells:
        return None

    def r1(v, digits):
        return None if v is None else round(v, digits)

    return {
        'scenario': SCENARIO,
        'cellLat': CELL_LAT,
        'cellLon': CELL_LON,
        'note': '値は [計測震度, 液状化PL値, 沈下量m]。250mセル内の最大値（安全側）',
        'cells': {k: [r1(v[0], 2), r1(v[1], 1), r1(v[2], 2)] for k, v in cells.items()},
    }


def dump(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)
    print(f'wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)')


def main():
    os.makedirs(os.path.dirname(OUT_RISK), exist_ok=True)
    risk = build_risk()
    if risk:
        dump(OUT_RISK, risk)
    grid = build_grid()
    if grid:
        dump(OUT_GRID, grid)
    if not risk or not grid:
        sys.exit('地震データの生成に失敗しました（上のログを確認してください）')


if __name__ == '__main__':
    main()
