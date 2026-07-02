#!/usr/bin/env python3
"""浸水回避ルーティング(#38)用の前処理バッチ(ランタイムでは使わない)。

東京都「浸水予想区域図」の流域別 浸水深・地盤高データ(密な点グリッドCSV・各10〜15MB)を、
約278m(0.0025°)の粗いグリッドに集約して軽量な public/data/flood_grid.json を出力する。
生CSVは合計100MB超と大きくクライアント配信不可のため、セルごとに
「最大浸水深」と「代表地盤高(最小=最も低い=浸水しやすい)」だけを残す。

クライアント(MapView)は、推奨避難所までのOSRM経路上の点をこのグリッドに当てて
「浸水想定域を通過するか・最大浸水深・上り概算」を判定する。

使い方:
  scripts/flood_grid.py            # data-raw/flood/*.csv を集約(無ければ自動DL)
出力: public/data/flood_grid.json  { "cell": 0.0025, "cells": { "iLat,iLon":[maxDepth, groundElev] } }
"""
import csv, json, math, os, sys, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
RAWDIR = os.path.join(ROOT, 'data-raw', 'flood')
OUT = os.path.join(ROOT, 'public', 'data', 'flood_grid.json')
CELL = 0.0025  # グリッド1辺(度)。緯度で約278m

# 東京都オープンデータ「浸水予想区域図」の流域別 浸水深・地盤高CSV。
# 対象は各流域1ファイル(秋川はR3版を採用。データセットにはR4の秋川分割版(1)(2)(3)もあるが
# 同一流域の図郭分割のため重複回避で不採用=流域カバレッジは網羅)。
CSV_URLS = [
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_kandagawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_sumidagawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_syakujiigawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_jyounantiku.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_koutounaibu.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_nogawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_kuromegawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_zanborigawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_sakaigawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_nakagawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_tsurumigawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_asakawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_tamagawa.csv',
    'https://www.opendata.metro.tokyo.lg.jp/kensetsu/R3/shinsui_akikawa.csv',
]


def local_path(url):
    return os.path.join(RAWDIR, url.rsplit('/', 1)[-1])


def ensure_downloaded():
    os.makedirs(RAWDIR, exist_ok=True)
    for url in CSV_URLS:
        p = local_path(url)
        if os.path.exists(p) and os.path.getsize(p) > 0:
            continue
        print('downloading', url)
        req = urllib.request.Request(url, headers={'User-Agent': 'dare-hinan-navi/0.1 (hackathon)'})
        with urllib.request.urlopen(req, timeout=120) as r, open(p, 'wb') as o:
            o.write(r.read())


def open_csv(path):
    """ファイルごとにエンコーディング自動判定(utf-8-sig / cp932 / utf-8)して開く。
    判定失敗時はファイルを確実にcloseしてから次候補へ(FDリーク防止)。"""
    for enc in ('utf-8-sig', 'cp932', 'utf-8'):
        f = open(path, encoding=enc, newline='')
        try:
            f.readline()
            f.seek(0)
            return f
        except UnicodeDecodeError:
            f.close()
            continue
    raise RuntimeError(f'encoding不明: {path}')


def num(v):
    try:
        return float((v or '').strip())
    except (ValueError, AttributeError):
        return None


def r1(x):
    """小数第1位へJSの Math.round(x*10)/10 と同じ規則(0.5切り上げ)で丸める。
    負値(地盤高)でもMath.roundと一致(例: -0.45→-0.4)。"""
    return math.floor(x * 10 + 0.5) / 10


def main():
    ensure_downloaded()
    # cell -> [max_depth, min_ground]
    cells = {}
    for url in CSV_URLS:
        p = local_path(url)
        if not os.path.exists(p):
            continue
        with open_csv(p) as f:
            r = csv.DictReader(f)
            for row in r:
                depth = num(row.get('浸水深'))
                lat = num(row.get('緯度'))
                lon = num(row.get('経度'))
                ground = num(row.get('地盤高'))
                if lat is None or lon is None or depth is None:
                    continue
                # クライアント(JS)の Math.round(0.5→切り上げ)と丸め規則を揃える。
                # Pythonの round() は銀行丸め(0.5→偶数)でセル境界がズレるため使わない。
                # 東京の緯度経度は正値なので floor(x+0.5) で Math.round と一致する。
                il = math.floor(lat / CELL + 0.5)
                io = math.floor(lon / CELL + 0.5)
                key = f'{il},{io}'
                cur = cells.get(key)
                if cur is None:
                    cells[key] = [depth, ground if ground is not None else 9999.0]
                else:
                    if depth > cur[0]:
                        cur[0] = depth
                    if ground is not None and ground < cur[1]:
                        cur[1] = ground
    # 浸水深0のセルは落とす(浸水しないので判定に不要=サイズ削減)
    cells = {k: [r1(v[0]), (r1(v[1]) if v[1] < 9999 else None)]
             for k, v in cells.items() if v[0] > 0}
    out = {'cell': CELL, 'cells': cells}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    print(f'flood_grid.json: {len(cells)} cells (cell={CELL}deg)  ->', os.path.relpath(OUT, ROOT))


if __name__ == '__main__':
    sys.exit(main())
