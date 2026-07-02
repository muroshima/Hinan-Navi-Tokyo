#!/usr/bin/env bash
# #6 高齢化率の町丁目粒度化: 国勢調査 小地域(町丁・字等) × 避難所の BigQuery GIS 空間結合(ST_CONTAINS)。
# 前処理バッチ(ランタイムでは使わない)。結果を data/chome_aging.json に出力し、
# scripts/preprocess.py が evacuation.geojson の agingRate を町丁目粒度で上書きする。
#
# 前提:
#  - e-Stat から取得(取得元は docs/DATA.md):
#      境界 Shapefile 一式(r2ka13.shp/.dbf/.shx/.prj) と 年齢別人口CSV(h03_13.csv, CP932)
#  - 依存: python3 + pyshp(`pip install pyshp`), bq CLI(gcloud), `gcloud auth application-default login`
#  - Terraform で BigQuery dataset `aging` を作成済み(infra/terraform)
#
# 使い方: scripts/aging_bq.sh <境界shpのベースパス(拡張子なし)> <年齢CSVパス>
#   例: scripts/aging_bq.sh ~/est_bound_13/r2ka13 ~/h03_13.csv
set -euo pipefail

# PROJECT_ID / BQ_LOCATION 環境変数で上書き可。既定値は固定(Terraformの project_id/region と同値に手動で合わせる。TF側を変えたらここも更新すること)
PROJ="${PROJECT_ID:-hinan-navi-tokyo}"
LOC="${BQ_LOCATION:-asia-northeast1}"
SHP="${1:?境界shpのベースパス(拡張子なし)}"
AGE="${2:?年齢別人口CSV(h03_13.csv)のパス}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEOJSON="$ROOT/public/data/evacuation.geojson"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$ROOT/data" # 出力先(data/)を保証

# 1) 境界 Shapefile → NDJSON(key_code, geojson文字列)
python3 - "$SHP" "$WORK/boundary.ndjson" <<'PY'
import shapefile, json, sys
r = shapefile.Reader(sys.argv[1], encoding="cp932")
fields = [x[0] for x in r.fields[1:]]; ki = fields.index("KEY_CODE")
with open(sys.argv[2], "w", encoding="utf-8") as o:
    for sr in r.iterShapeRecords():
        k = str(sr.record[ki]).strip()
        if not k or sr.shape.shapeType == 0:
            continue
        g = sr.shape.__geo_interface__
        if g:
            o.write(json.dumps({"key_code": k, "geojson": json.dumps(g)}) + "\n")
PY

# 2) 年齢別人口CSV → NDJSON(key_code, total, over65)。男女=総数のみ、秘匿X/非該当-はnull
python3 - "$AGE" "$WORK/age.ndjson" <<'PY'
import csv, json, sys
def num(v):
    v = (v or "").strip().replace(",", "")
    return int(v) if v.isdigit() else None
with open(sys.argv[1], encoding="cp932") as f, open(sys.argv[2], "w", encoding="utf-8") as o:
    for i, r in enumerate(csv.reader(f)):
        if i < 5 or len(r) < 38 or r[1].strip() != "総数":  # 先頭5行はメタ/ヘッダ
            continue
        cc, tc = r[2].strip(), r[3].strip()
        if not cc or tc in ("", "-"):
            continue
        o.write(json.dumps({"key_code": cc + tc, "total": num(r[12]), "over65": num(r[37])}) + "\n")
PY

# 3) 避難所点 → NDJSON(id, lng, lat)
python3 - "$GEOJSON" "$WORK/evac.ndjson" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    fc = json.load(f)
with open(sys.argv[2], "w", encoding="utf-8") as o:
    for ft in fc["features"]:
        c = ft["geometry"]["coordinates"]
        o.write(json.dumps({"id": ft["properties"]["id"], "lng": c[0], "lat": c[1]}) + "\n")
PY

# 4) BigQuery へ投入
for t in boundary age evac; do
    bq --project_id="$PROJ" --location="$LOC" load --source_format=NEWLINE_DELIMITED_JSON \
        --autodetect --replace "aging.$t" "$WORK/$t.ndjson"
done

# 5) 空間結合(避難所点 in 小地域ポリゴン → key_codeで年齢結合 → 65歳以上/総数)
bq --project_id="$PROJ" --location="$LOC" query --use_legacy_sql=false '
CREATE OR REPLACE TABLE aging.evac_aging AS
WITH poly AS (
  SELECT key_code, SAFE.ST_GEOGFROMGEOJSON(geojson, make_valid => TRUE) AS g FROM aging.boundary
),
age2 AS (
  SELECT key_code, ROUND(SAFE_DIVIDE(over65, total)*100, 1) AS rate
  FROM aging.age WHERE total > 0 AND over65 IS NOT NULL
)
SELECT e.id, p.key_code, a.rate AS aging_rate
FROM aging.evac e
JOIN poly p ON p.g IS NOT NULL AND ST_CONTAINS(p.g, ST_GEOGPOINT(e.lng, e.lat))
JOIN age2 a ON a.key_code = p.key_code'

# 6) 結果を data/chome_aging.json(id→町丁目高齢化率) にエクスポート
#    ※ランタイム配信不要の中間生成物のため public/ ではなく data/ に出力
bq --project_id="$PROJ" --location="$LOC" query --use_legacy_sql=false --format=json --max_rows=100000 \
    'SELECT id, aging_rate FROM aging.evac_aging' > "$WORK/result.json"
python3 - "$WORK/result.json" "$ROOT/data/chome_aging.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
m = {x["id"]: float(x["aging_rate"]) for x in d if x["aging_rate"] is not None}
with open(sys.argv[2], "w", encoding="utf-8") as o:
    # sort_keysで決定論的な出力にし、実行ごとの差分ノイズを防ぐ
    json.dump(m, o, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
PY

echo "done: data/chome_aging.json を生成。'python3 scripts/preprocess.py' で evacuation.geojson に町丁目粒度を反映"
