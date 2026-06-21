#!/usr/bin/env python3
"""東京都オープンデータ等(避難所/避難場所/車椅子対応トイレ/給水・Wi-Fi/都営バス停)を
統一スキーマGeoJSONに変換。
- エンコードはファイルごとに自動判定(utf-8-sig / cp932 / utf-8)
- 先頭ゴミ空行を除去し、本物のヘッダ行を検出
- バリアフリー列・災害種別列を bool に正規化
出力: public/data/{evacuation, toilets, lifeline, bus_stops}.geojson および metadata.json
"""
import csv, io, json, os, zipfile

RAW = os.path.join(os.path.dirname(__file__), '..', 'data-raw')
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data')
os.makedirs(OUT, exist_ok=True)


def read_csv(name):
    path = os.path.join(RAW, name)
    for enc in ('utf-8-sig', 'cp932', 'utf-8'):
        try:
            with open(path, encoding=enc, newline='') as f:
                return [r for r in csv.reader(f)]
        except UnicodeDecodeError:
            continue
    raise RuntimeError(f'encoding不明: {name}')


def find_header(rows, must_contain):
    """指定語のいずれかを含む最初の行をヘッダとみなす。"""
    for i, r in enumerate(rows):
        if any(any(k in (c or '') for k in must_contain) for c in r):
            return i, [c.strip().replace('\n', '') for c in r]
    raise RuntimeError('ヘッダが見つからない')


def truthy(v):
    """○ / ○有 / あり等を True に。空・×・- は False。"""
    s = (v or '').strip()
    return s not in ('', '×', '-', 'なし', '×印', '0')


def to_float(v):
    try:
        return float((v or '').strip())
    except ValueError:
        return None


def records(rows, header_idx, header):
    for r in rows[header_idx + 1:]:
        if not any((c or '').strip() for c in r):
            continue
        yield dict(zip(header, [c.strip() for c in r]))


def build_city_aging():
    """市区町村別 年齢3区分人口(第3-1表)から 高齢化率(65歳以上比) と総人口を算出。
    返り値: { 市区町村名: {'rate': float(%), 'pop': int} }"""
    try:
        rows = read_csv('city_age.csv')
    except Exception:
        return {}
    if not rows:
        return {}
    # 先頭の空行/注記行に耐えるよう、本物のヘッダ行を検出（他CSVと同様）
    try:
        hi, header = find_header(rows, ['年少', '老年'])
    except RuntimeError:
        return {}
    # 各区分の「総数」列（最初に現れるもの）
    i_name = next((i for i, c in enumerate(header) if c.strip() == '地域'), 2)
    i_young = next((i for i, c in enumerate(header) if '年少' in c and '総数' in c), 3)
    i_work = next((i for i, c in enumerate(header) if '生産年齢' in c and '総数' in c), 6)
    i_old = next((i for i, c in enumerate(header) if '老年' in c and '総数' in c), 9)
    out = {}
    skip = {'総数', '区部', '市部', '郡部', '島部', '都計'}
    for r in rows[hi + 1:]:
        if len(r) <= i_old:
            continue
        name = (r[i_name] or '').strip()
        if not name or name in skip:
            continue
        if not (name.endswith('区') or name.endswith('市') or name.endswith('町') or name.endswith('村')):
            continue
        try:
            young = int(r[i_young]); work = int(r[i_work]); old = int(r[i_old])
        except ValueError:
            continue
        total = young + work + old
        if total <= 0:
            continue
        out[name] = {'rate': round(old / total * 100, 1), 'pop': total}
    return out


def build_evacuation():
    feats = []
    aging = build_city_aging()

    def attach_aging(props):
        a = aging.get(props.get('city', ''))
        props['agingRate'] = a['rate'] if a else None  # 市区町村の高齢化率(%)
        props['cityPop'] = a['pop'] if a else None

    # 避難所 (center): 施設に直接バリアフリー列
    rows = read_csv('evacuation_center.csv')
    hi, h = find_header(rows, ['避難所_施設名称', '施設名称'])
    for d in records(rows, hi, h):
        name = d.get('避難所_施設名称', '')
        lat, lon = to_float(d.get('緯度')), to_float(d.get('経度'))
        if not name or lat is None or lon is None:
            continue
        # 'エレベーター有/避難スペースが１階' 列名は改行除去済み
        ev_key = next((k for k in d if k.startswith('エレベーター')), None)
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': {
                'id': f'c-{len(feats)}',
                'name': name,
                'kind': 'center',          # 指定避難所(屋内・滞在)
                'city': d.get('指定市区町村名', ''),
                'address': d.get('所在地住所', ''),
                'a11y': {
                    'ground_or_elevator': truthy(d.get(ev_key)) if ev_key else False,
                    'slope': truthy(d.get('スロープ等')),
                    'braille': truthy(d.get('点字ブロック')),
                    'wheelchair_toilet': truthy(d.get('車椅子使用者対応トイレ')),
                },
                'hazards': None,
                'note': d.get('その他', ''),
            },
        })
        attach_aging(feats[-1]['properties'])

    # 避難場所 (area): 災害種別ごとの適否フラグつき
    rows = read_csv('evacuation_area.csv')
    hi, h = find_header(rows, ['施設名'])
    haz_map = {
        'flood': '洪水', 'landslide': '崖崩れ、土石流及び地滑り', 'storm_surge': '高潮',
        'earthquake': '地震', 'tsunami': '津波', 'fire': '大規模な火事',
        'inland_flood': '内水氾濫', 'volcano': '火山現象',
    }
    for d in records(rows, hi, h):
        name = d.get('施設名', '')
        lat, lon = to_float(d.get('緯度')), to_float(d.get('経度'))
        if not name or lat is None or lon is None:
            continue
        ev_key = next((k for k in d if k.startswith('エレベーター')), None)
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': {
                'id': f'a-{len(feats)}',
                'name': name,
                'kind': 'area',            # 指定緊急避難場所(一時的に身を守る)
                'city': d.get('区市町村', ''),
                'address': d.get('所在地住所', ''),
                'a11y': {
                    'ground_or_elevator': truthy(d.get(ev_key)) if ev_key else False,
                    'slope': truthy(d.get('スロープ等')),
                    'braille': truthy(d.get('点字ブロック')),
                    'wheelchair_toilet': truthy(d.get('車椅子使用者対応トイレ')),
                },
                'hazards': {en: truthy(d.get(ja)) for en, ja in haz_map.items()},
                'note': d.get('その他', ''),
            },
        })
        attach_aging(feats[-1]['properties'])
    return feats


def build_toilets():
    rows = read_csv('wc_barrierfree.csv')
    hi, h = find_header(rows, ['トイレ名', '施設名'])
    feats = []
    for d in records(rows, hi, h):
        lat, lon = to_float(d.get('緯度')), to_float(d.get('経度'))
        if lat is None or lon is None:
            continue
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': {
                'id': f't-{len(feats)}',
                'facility': d.get('施設名', ''),
                'name': d.get('トイレ名', '') or d.get('施設名', ''),
                'floor': d.get('設置フロア', ''),
                'a11y': {
                    'braille': truthy(d.get('トイレへの誘導路として点字ブロックを敷設している')),
                    'audio': truthy(d.get('トイレの位置等を音声で案内している')),
                    'wheelchair_enter': truthy(d.get('車椅子が出入りできる（出入口の有効幅員80cm以上）')),
                    'wheelchair_turn': truthy(d.get('車椅子が転回できる（直径150cm以上の円が内接できる）')),
                    'ostomate': truthy(d.get('オストメイト用設備がある')),
                    'large_bed': truthy(d.get('大型ベッドを備えている')),
                    'baby_change': truthy(d.get('乳幼児用おむつ交換台等を備えている')),
                    'call_button': truthy(d.get('非常用呼び出しボタンを設置している')),
                },
            },
        })
    return feats


def build_lifeline():
    """生活継続レイヤー（災害時給水拠点・公衆Wi-Fi）を1つのGeoJSONに統合。
    properties.kind で 'water' / 'wifi' を区別。"""
    feats = []
    # 災害時給水ステーション（東京都水道局）
    try:
        rows = read_csv('water_station.csv')
        hi, h = find_header(rows, ['施設名'])
        for i, d in enumerate(records(rows, hi, h)):
            lat, lon = to_float(d.get('緯度')), to_float(d.get('経度'))
            name = d.get('施設名', '')
            if not name or lat is None or lon is None:
                continue
            feats.append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                'properties': {
                    'id': f'lw-{i}',  # 種別内の連番（行index・一意）
                    'kind': 'water',
                    'name': name,
                    'category': d.get('種別', ''),
                    'capacity': to_float(d.get('確保水量（立方メートル）')),  # 立方メートル(数値)
                    'address': d.get('所在地', ''),
                },
            })
    except Exception as e:
        print('water_station skip:', e)
    # 公衆無線LAN（FREE Wi-Fi & TOKYO）
    try:
        rows = read_csv('wifi.csv')
        hi, h = find_header(rows, ['名称'])
        for i, d in enumerate(records(rows, hi, h)):
            lat, lon = to_float(d.get('緯度')), to_float(d.get('経度'))
            name = d.get('名称', '')
            if not name or lat is None or lon is None:
                continue
            feats.append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                'properties': {
                    'id': f'lf-{i}',  # 種別内の連番（行index・一意）
                    'kind': 'wifi',
                    'name': name,
                    'address': d.get('住所', ''),
                },
            })
    except Exception as e:
        print('wifi skip:', e)
    return feats


def build_bus_stops():
    """都営バスGTFS-JPのstops.txtからバス停（location_type=1=停留所の親）を抽出。
    wheelchair_boarding=1（車椅子対応）も保持。data-raw/ToeiBus-GTFS.zip を読む。"""
    feats = []
    path = os.path.join(RAW, 'ToeiBus-GTFS.zip')
    if not os.path.exists(path):
        return feats
    try:
        with zipfile.ZipFile(path) as z, z.open('stops.txt') as f:
            r = csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig', newline=''))
            for row in r:
                # location_type=1 は停留所(親)。0=のりば(密集するため代表点の1を採用)
                if (row.get('location_type') or '').strip() != '1':
                    continue
                lat, lon = to_float(row.get('stop_lat')), to_float(row.get('stop_lon'))
                name = (row.get('stop_name') or '').strip()
                if not name or lat is None or lon is None:
                    continue
                feats.append({
                    'type': 'Feature',
                    'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                    'properties': {
                        'id': f"bs-{(row.get('stop_id') or '').strip()}",
                        'name': name,
                        'wheelchair': (row.get('wheelchair_boarding') or '').strip() == '1',
                    },
                })
    except Exception as e:
        print('bus_stops skip:', e)
    return feats


def dump(name, feats):
    fc = {'type': 'FeatureCollection', 'features': feats}
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False)
    print(f'{name}: {len(feats)} features')
    return len(feats)


# 出典・ライセンス等のメタデータ（DATA.md と整合。詳細・正確な条件は docs/DATA.md / 各公式を参照）
SOURCES = [
    {
        'file': 'evacuation.geojson',
        'datasets': [
            '東京都防災マップ 避難所一覧データ',
            '東京都防災マップ 避難場所一覧データ',
        ],
        'provider': '東京都',
        'license': 'CC BY 4.0',
        'source_url': 'https://catalog.data.metro.tokyo.lg.jp/dataset/t000022d0000000085',
        'retrieved': '2026-06',
        'processing': 'CSV(CP932/UTF-8)→正規化GeoJSON。バリアフリー列のbool化、市区町村高齢化率の付与',
        'attribution': '東京都オープンデータ（CC BY 4.0）',
    },
    {
        'file': 'toilets.geojson',
        'datasets': ['車椅子使用者対応トイレのバリアフリー設備情報'],
        'provider': '東京都(福祉局)',
        'license': 'CC BY 4.0',
        'source_url': 'https://catalog.data.metro.tokyo.lg.jp/dataset/t000010d0000000095',
        'retrieved': '2026-06',
        'processing': 'CSV(CP932)→GeoJSON。おむつ替え/オストメイト/大型ベッド/非常用ボタン等をbool化',
        'attribution': '東京都オープンデータ（CC BY 4.0）',
    },
    {
        'file': 'lifeline.geojson',
        'datasets': [
            '災害時給水ステーション（給水拠点）一覧',
            '東京都 公衆無線LAN（FREE Wi-Fi & TOKYO）アクセスポイント',
        ],
        'provider': '東京都水道局 / 東京都デジタルサービス局',
        'license': 'CC BY 4.0',
        'source_url': 'https://catalog.data.metro.tokyo.lg.jp/',
        'retrieved': '2026-06',
        'processing': 'CSV(CP932)→統合GeoJSON。properties.kindで給水(water)/Wi-Fi(wifi)を区別',
        'attribution': '東京都オープンデータ（CC BY 4.0）',
    },
    {
        'file': 'bus_stops.geojson',
        'datasets': ['都営バス GTFS-JP（stops.txt 停留所）'],
        'provider': '東京都交通局 / 公共交通オープンデータセンター(ODPT)',
        'license': 'CC BY 4.0',
        'source_url': 'https://ckan.odpt.org/dataset/b_bus_gtfs_jp-toei',
        'retrieved': '2026-06',
        'processing': 'GTFS-JP zipのstops.txtからlocation_type=1の停留所を抽出。車椅子対応(wheelchair_boarding=1)を保持',
        'attribution': '都営バス GTFS-JP（東京都交通局）／公共交通オープンデータセンター（CC BY 4.0）',
    },
    {
        'file': '(高齢化率の付与に使用)',
        'datasets': ['住民基本台帳による東京都の世帯と人口(町丁別・年齢別) 第3-1表 区市町村,年齢3区分別人口'],
        'provider': '東京都',
        'license': 'CC BY 4.0（東京都オープンデータ利用規約に準拠）',
        'source_url': 'https://www.toukei.metro.tokyo.lg.jp/juukiy/',
        'retrieved': '2026-06',
        'processing': '65歳以上比から市区町村別高齢化率を算出し evacuation.geojson に付与',
        'attribution': '東京都オープンデータ（CC BY 4.0）',
    },
]


def write_metadata(counts):
    meta = {
        'generated_note': 'scripts/preprocess.py による自動生成。出典・ライセンスの詳細は docs/DATA.md を参照',
        'datasets': [],
    }
    for s in SOURCES:
        entry = dict(s)
        entry['record_count'] = counts.get(s['file'])
        meta['datasets'].append(entry)
    with open(os.path.join(OUT, 'metadata.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print('metadata.json written')


if __name__ == '__main__':
    counts = {}
    counts['evacuation.geojson'] = dump('evacuation.geojson', build_evacuation())
    counts['toilets.geojson'] = dump('toilets.geojson', build_toilets())
    counts['lifeline.geojson'] = dump('lifeline.geojson', build_lifeline())
    counts['bus_stops.geojson'] = dump('bus_stops.geojson', build_bus_stops())
    write_metadata(counts)
    print('done ->', os.path.relpath(OUT))
