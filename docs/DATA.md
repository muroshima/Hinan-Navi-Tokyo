# データ出典・ライセンス

本プロジェクトが利用するデータ・地図タイル・外部APIの出典、ライセンス、取得日、加工内容、利用規約上の留意点をまとめます。**コード本体のライセンスとデータのライセンスは別**です（コード本体は [Apache-2.0](../LICENSE)）。利用にあたっては各提供元の最新の利用規約を必ずご確認ください。

機械可読のメタデータは [`public/data/metadata.json`](../public/data/metadata.json)（`scripts/preprocess.py` が自動生成）にもあります。

## 1. アプリに同梱する加工データ（東京都オープンデータ由来）

| 生成ファイル | 元データセット | 提供元 | ライセンス | 取得 | 加工 |
|---|---|---|---|---|---|
| `public/data/evacuation.geojson` | 東京都防災マップ 避難所一覧／避難場所一覧データ | 東京都 | CC BY 4.0 | 2026-06 | CSV(CP932/UTF-8)→正規化GeoJSON、バリアフリー列のbool化、**高齢化率の付与（町丁目粒度＝下記BQ空間結合、未取得時は市区町村fallback）** |
| `public/data/toilets.geojson` | 車椅子使用者対応トイレのバリアフリー設備情報 | 東京都(福祉局) | CC BY 4.0 | 2026-06 | CSV(CP932)→GeoJSON、設備項目（おむつ替え/オストメイト/大型ベッド/非常用ボタン等）のbool化 |
| `public/data/lifeline.geojson` | 災害時給水ステーション（給水拠点）一覧／公衆無線LAN（FREE Wi-Fi & TOKYO） | 東京都(水道局／デジタルサービス局) | CC BY 4.0 | 2026-06 | CSV(CP932)→統合GeoJSON。`kind`で給水(water)/Wi-Fi(wifi)を区別。給水は確保水量・種別も保持 |
| `public/data/bus_stops.geojson` | 都営バス GTFS-JP（停留所） | 東京都交通局／公共交通オープンデータセンター(ODPT) | CC BY 4.0 | 2026-06 | GTFS-JP zipの`stops.txt`から`location_type=1`の停留所を抽出してGeoJSON化。車椅子対応(`wheelchair_boarding=1`)を保持 |
| （高齢化率・町丁目粒度） | 令和2年国勢調査 小地域集計 第3表 年齢別人口(東京都)＋小地域境界(統計GIS) | 総務省統計局(e-Stat) | 政府統計(出典明示で自由利用) | 2026-07 | BigQuery GISで避難所点×小地域ポリゴンの`ST_CONTAINS`空間結合→`KEY_CODE`で年齢結合し65歳以上/総数を算出（`scripts/aging_bq.sh`→`data/chome_aging.json`→`evacuation.geojson`） |
| （高齢化率・市区町村fallback） | 住民基本台帳による東京都の世帯と人口（町丁別・年齢別）第3-1表 区市町村・年齢3区分別人口 | 東京都 | CC BY 4.0（東京都オープンデータ利用規約準拠） | 2026-06 | 65歳以上比から市区町村別高齢化率を算出。町丁目粒度が取れない避難所(島嶼等)のfallback |

- 出典カタログ: 東京都オープンデータカタログサイト https://catalog.data.metro.tokyo.lg.jp/
- 東京都オープンデータの多くは **CC BY 4.0**（出典の表示が条件）。本アプリは「東京都オープンデータ（CC BY 4.0）」と表示します。
- ※ 元CSVの再取得手順・配置（`data-raw/`）は後述「[データの再現手順](#データの再現手順data-raw-の配置)」を参照。

## データの再現手順（`data-raw/` の配置）

同梱の `public/data/*.geojson` は東京都オープンデータの元CSVから `scripts/preprocess.py` で生成しています。**元CSVは再配布条件の確認を避けるため未コミット**（`.gitignore`）です。再生成するには、以下を東京都オープンデータから取得し、`data-raw/` に**指定のファイル名**で配置してください（CSVは Shift-JIS(CP932) が多く、`preprocess.py` がエンコードを自動判定します）。

| 配置パス（リネーム後） | データセット | 取得元 |
|---|---|---|
| `data-raw/evacuation_center.csv` | 避難所一覧 | `https://www.opendata.metro.tokyo.lg.jp/soumu/130001_evacuation_center.csv` |
| `data-raw/wc_barrierfree.csv` | 車椅子使用者対応トイレ バリアフリー設備情報 | `https://www.opendata.metro.tokyo.lg.jp/fukushi/3_koukyoshisetsu_barieer_free_wc.csv`（ファイル名の `barieer` は東京都側の綴り原文ママ・実在確認済み）。カタログ: https://catalog.data.metro.tokyo.lg.jp/dataset/t000010d0000000095 |
| `data-raw/evacuation_area.csv` | 避難場所一覧（災害種別の適否フラグ付き） | 東京都オープンデータカタログ「避難所・避難場所一覧データ」 https://catalog.data.metro.tokyo.lg.jp/dataset/t000003d0000000093 から避難場所一覧のCSVを取得しリネーム |
| `data-raw/city_age.csv` | 住民基本台帳 年齢別人口（第3-1表 区市町村・年齢3区分別） | 東京都の統計 住民基本台帳 https://www.toukei.metro.tokyo.lg.jp/juukiy/ から該当表のCSVを取得しリネーム |
| `data-raw/water_station.csv` | 災害時給水ステーション（給水拠点）一覧 | `https://www.opendata.metro.tokyo.lg.jp/suidou/R7/kyoten_20251211.csv`（東京都水道局・都全域・座標付き） |
| `data-raw/wifi.csv` | 公衆無線LAN（FREE Wi-Fi & TOKYO） | `https://www.opendata.metro.tokyo.lg.jp/suisyoudataset/130001_public_wireless_lan_20240901.csv`（東京都デジタルサービス局・座標付き） |
| `data-raw/ToeiBus-GTFS.zip` | 都営バス GTFS-JP（静的） | `https://api-public.odpt.org/api/v4/files/Toei/data/ToeiBus-GTFS.zip`（APIキー不要・要リダイレクト追従 `curl -L`） |

```bash
# data-raw/ に上記4ファイルを配置後
python3 scripts/preprocess.py
# → public/data/{evacuation.geojson, toilets.geojson, metadata.json} を生成
```

- 直URLは時点により変わる場合があります。リンク切れ時はカタログ（`catalog.data.metro.tokyo.lg.jp`）でデータセット名を検索してください。
- いずれも東京都オープンデータ（**CC BY 4.0**）。利用時は出典表示が条件です。各データセットの最新の利用規約を必ず確認してください。

### 高齢化率の町丁目粒度化（BigQuery GIS 空間結合・#6）

避難所の高齢化率を市区町村粒度から**町丁目（小地域）粒度**へ格上げする前処理バッチ（ランタイムでは使わない）。

1. e-Stat（総務省統計局）から令和2年国勢調査 小地域（東京都）を取得:
   - **境界 Shapefile**: 統計GIS 直ダウンロード `https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=A002005212020&code=13&coordSys=1&format=shape&downloadType=5`（zipに `r2ka13.shp/.dbf/.shx/.prj` を同梱。※e-Stat のパラメータは綴りが `dlserveyId`＝原文ママの誤綴り。`serveyId`/`surveyId` では 404）
   - **年齢別人口 CSV**: 小地域集計 第3表（男女，年齢5歳階級別人口－町丁・字等・東京都）→ `h03_13.csv`（Shift-JIS）
2. Terraform で BigQuery dataset `aging` を作成（`infra/terraform`）、`gcloud auth application-default login`
3. 空間結合バッチを実行（`pyshp` と `bq` CLI が必要）。**避難所の `id` は `preprocess.py` の生成順で決まる**ため、元CSVを更新した場合は次の順で実行する:
   ```bash
   python3 scripts/preprocess.py                          # ① evacuation.geojson を生成(id確定)
   scripts/aging_bq.sh ~/est_bound_13/r2ka13 ~/h03_13.csv # ② 空間結合 → data/chome_aging.json
   python3 scripts/preprocess.py                          # ③ agingRate を町丁目粒度で反映
   ```
   ②は①で確定した避難所 `id` を参照するため、必ず ①→②→③ の順に実行すること。
- `data/chome_aging.json` は**ランタイム配信不要の中間生成物**のため `public/` ではなく `data/` に置く（`preprocess.py` が読み込み `evacuation.geojson` に焼き込む）。
- 秘匿地域（`X`）や境界外（島嶼等）で町丁目値が取れない避難所は、市区町村fallback（住民基本台帳）を使用（`agingLevel` で区別）。
- 出典表示: 「令和2年国勢調査」（総務省統計局）を加工。

## 2. 地図タイル・地形・フォント（クライアントで読み込み）

| 用途 | 提供 | 出典/ライセンス | 留意点 |
|---|---|---|---|
| ベース地図タイル | OpenStreetMap | © OpenStreetMap contributors（データ: ODbL）。タイルは OSMF **Tile Usage Policy** | **公開アプリの既定ベースマップ用途は非推奨/禁止**。公開配信時は自前/商用タイルへ差替が必要（別Issue「公開タイル/ルーティングの本番依存是正」） |
| ハザード（洪水/高潮/津波/土砂）タイル | 国土交通省 ハザードマップポータルサイト | 出典表示が条件（同サイト利用規約） | アプリ内に「ハザードマップポータルサイト(国土交通省)」と出典表示済み |
| 3D地形 DEM | Mapzen / AWS Open Data（Terrain Tiles, Terrarium） | 出典表示。元標高は複数データ源 | アプリ内に「Terrain: Mapzen/AWS Open Data」と表示済み。エンドポイント終了/移行の可能性に留意 |
| 建物3D（垂直避難・東京23区） | Project PLATEAU（国土交通省）の建物モデルを [indigo-lab/plateau-tokyo23ku-building-mvt-2020](https://github.com/indigo-lab/plateau-tokyo23ku-building-mvt-2020) がMVT化 | CC BY 4.0（PLATEAU/国交省クレジット＋変換リポジトリのリンク表示が条件） | 建物高さ `measuredHeight` で色分け表示。**2020年度版・第三者ホスティング**のため、本番運用時は自前のMVT再生成を推奨（別Issue「公開タイル本番化」）。地図のattribution controlに出典表示済み |
| ラベル用フォント(glyphs) | MapLibre demotiles（Open Sans 系） | デモ用エンドポイント | **本番非保証**。公開時は自前 glyphs へ差替を推奨 |

## 3. 外部API（サーバー経由で呼び出し）

| 用途 | 提供 | 出典/ライセンス | 留意点 |
|---|---|---|---|
| 住所・地名→座標（`/api/geocode`） | OpenStreetMap Nominatim 公開サーバ | データ © OpenStreetMap contributors（ODbL）。Nominatim **Usage Policy**（1req/s上限・重利用禁止） | User-Agent/連絡先付与済み。**IP単位レート制限 30回/分＋入力長制限（#30）**。ただしNominatimの1req/sはサーバ全体制約のため、公開常用時は自前運用が必要 |
| 徒歩経路距離（`/api/route`） | OSRM デモサーバ（router.project-osrm.org） | OSRM(BSD)。**デモサーバは本番利用不可・heavy use禁止** | 道路距離のみ採用し所要は徒歩速度で概算。**IP単位レート制限 30回/分（#30）**。公開常用時は自前/商用ルーティングへ差替が必要 |
| 徒歩ルート表示（リンク誘導） | Google Maps | リンク誘導のみ（API不使用） | 規約上ほぼ問題なし |

## 4. LLM（任意）
- `/api/triage`・`/api/timeline` は Vertex AI Gemini で自然文の属性抽出・タイムライン生成を行う（モデルは実装参照）。**認証未設定でも語句一致/ルールベースのフォールバックで動作**。
- **悪用・コスト対策（#30）**: 両APIとも **IP単位レート制限 15回/分**、triageは入力を1000文字に制限。同一入力は10分間のプロセス内キャッシュから返しGemini再呼び出しを抑制。
  - ⚠️ Cloud Run は複数インスタンスへスケールし得るため、レート制限・キャッシュは**インスタンス単位**（グローバル厳密ではない）。DoS完全防御ではなく単一クライアントの暴走・キー悪用抑止が目的。厳密なグローバル制限には外部ストア（Redis等）が必要（プロトタイプのため未導入）。

## 免責
本リポジトリはハッカソン用プロトタイプです。掲載データは時点情報であり実態と異なる場合があります。**避難の最終判断は自治体の公式情報・指示に従ってください**。詳細は README の免責も参照。

> 注: 一部のライセンス表記（特に統計データの細目）は提供元規約に基づく解釈を含みます。正確な条件は各公式の利用規約で最終確認してください。
