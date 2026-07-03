# デモ動画パイプライン

だれでも避難ナビ TOKYO の紹介動画（約60秒）を、画面録画ソフトなしで
スクリプト生成する。Playwright が UI を録画し、edge-tts がナレーションを
生成、ffmpeg が合成する。

## 構成

```
scripts/demo/
├── playwright.config.ts   # 録画専用config（1280x720, video:on, next start）
├── tests/demo.spec.ts     # 収録シナリオ（narrationのcueに視覚を合わせる）
├── narration/demo.ja.json # ナレーション cue（voice/rate/at/text）
├── render.py              # TTS生成 + adelay/amix + h264/AAC mux
└── output/                # 生録画・中間生成物（gitignore。正本は docs/demo.mp4）
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
サムネイル（`docs/demo-thumb.jpg` → `docs/demo.mp4`）で埋め込んでいる。
インライン再生プレーヤーにしたい場合は、Issue/PR のコメント欄に
`docs/demo.mp4` を drag-and-drop して得られる `user-attachments` URL を
README に素のテキストで貼る（GitHub が自動で video player に変換）。
