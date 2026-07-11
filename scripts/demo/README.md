# デモ動画パイプライン

だれでも避難ナビ TOKYO の紹介動画（約1分）を、画面録画ソフトなしで
スクリプト生成する。Playwright が UI を録画し、edge-tts がナレーションを
生成、ffmpeg が合成する。

## 構成

```
scripts/demo/
├── playwright.config.ts   # 録画専用config（1280x720, video:on, next start）
├── tests/demo.spec.ts     # 収録シナリオ（narrationのcueに視覚を合わせる）
├── narration/demo.ja.json # ナレーション cue（voice/rate/at/text）
├── render.py              # TTS生成 + adelay/amix + h264/AAC mux + 前後カード合成
├── cards/                 # タイトル/エンドカード（docs/slides.md のスライド1・12のPNG。
│                          # スライド更新時は次で再生成して差し替える:
│                          #   npx -y @marp-team/marp-cli@4.3.1 docs/slides.md -c marp.config.mjs --images png -o /tmp/slide.png
│                          #   → /tmp/slide.001.png=title, /tmp/slide.012.png=end ）
└── output/                # 生録画・中間生成物（gitignore。正本は docs/demo.mp4）
```

## 運用ルール（履歴肥大の抑制・#94）

`docs/demo.mp4`（約10.5MB）はバイナリで git 履歴を肥大させるため、**リポジトリには
コミットしない**（`.gitignore` 済み）。公開版は YouTube（<https://youtu.be/1wp2LkwUc_4>）
にアップロードし、README・スライド・提出フォームはこの YouTube URL を参照する。
`docs/demo.mp4` はローカルでの視聴確認・YouTube 再アップロード用の正本として手元に置く。

## 収録時の注意（AI抽出を本物にする）

配慮属性チップ横の「（抽出: …）」表示を **gemini** にするため、収録は
Vertex AI が有効なサーバに対して行う（fallback のまま収録すると
「AIが読み取りました」のナレーションと画面表示が食い違う）:

```bash
gcloud auth application-default login   # 未認証なら
GOOGLE_CLOUD_PROJECT=<your-gcp-project> PORT=3000 npm run start &
curl -s -X POST localhost:3000/api/triage -H "Content-Type: application/json" \
  -d '{"text":"車椅子で避難したい"}' | grep -o '"source":"[a-z]*"'   # gemini を確認
# → その後に収録（config の reuseExistingServer が既存サーバを拾う）
```

## 前提

```bash
brew install uv ffmpeg          # uvx は uv 同梱
npx playwright install chromium # フルchromium（headless_shellでは録画不可）
```

## 実行

```bash
# プロジェクトルートで本番ビルド（dev の Strict Mode 二重mountを避けるため）
npm run build

# 収録 → 合成（docs/demo.mp4 に正本を出力）
npx playwright test --config scripts/demo/playwright.config.ts
python3 scripts/demo/render.py
```

`render.py` は narration の cue を再生成して既存録画に合成するだけなので、
**ナレーション文言のみ変更した場合は再収録不要**（`render.py` だけ再実行）。
シーンの尺・順序を変えたら spec を直して再収録する。

## タイミング調整

各 cue の実測尺は次で確認できる:

```bash
uvx edge-tts --voice ja-JP-NanamiNeural --rate +8% --text "…" --write-media /tmp/c.mp3
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /tmp/c.mp3
```

spec 側は `untilT(sec)` で「動画時間 sec までwait」して視覚を cue に合わせる。

## README への埋め込み

GitHub は README の `<video>` タグを strip するため、クリック可能な
サムネイル（`docs/video-thumb.jpg` → YouTube の URL。サムネイル生成は
[`scripts/thumbnail/`](../thumbnail/) 参照）で埋め込んでいる。動画本体は
リポジトリに含めず YouTube（<https://youtu.be/1wp2LkwUc_4>）で公開し、
サムネイルのリンク先をこの URL にしている。
