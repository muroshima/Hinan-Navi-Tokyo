#!/usr/bin/env python3
"""東京都オープンデータ(避難所/避難場所/車椅子対応トイレ)を統一スキーマGeoJSONに変換。
- エンコードはファイルごとに自動判定(utf-8-sig / cp932 / utf-8)
- 先頭ゴミ空行を除去し、本物のヘッダ行を検出
- バリアフリー列・災害種別列を bool に正規化
出力: public/data/{evacuation.geojson, toilets.geojson}
"""
import csv, json, os, re

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
    header = rows[0]

    def col(keyword):
        for i, c in enumerate(header):
            if keyword in (c or ''):
                return i
        return None
    # 各区分の「総数」列（最初に現れるもの）
    i_name = 2
    i_young = next((i for i, c in enumerate(header) if '年少' in c and '総数' in c), 3)
    i_work = next((i for i, c in enumerate(header) if '生産年齢' in c and '総数' in c), 6)
    i_old = next((i for i, c in enumerate(header) if '老年' in c and '総数' in c), 9)
    out = {}
    skip = {'総数', '区部', '市部', '郡部', '島部', '都計'}
    for r in rows[1:]:
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


def dump(name, feats):
    fc = {'type': 'FeatureCollection', 'features': feats}
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False)
    print(f'{name}: {len(feats)} features')


if __name__ == '__main__':
    dump('evacuation.geojson', build_evacuation())
    dump('toilets.geojson', build_toilets())
    print('done ->', os.path.relpath(OUT))
