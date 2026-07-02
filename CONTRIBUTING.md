# コントリビューションガイド

「だれでも避難ナビ TOKYO」への関心をありがとうございます。ハッカソン用プロトタイプですが、改善提案・修正を歓迎します。

## 開発の前提

- Next.js 16 / React 19 / TypeScript / Tailwind CSS / MapLibre GL JS
- **本リポジトリの Next.js は破壊的変更を含むバージョンです**。コードを書く前に `node_modules/next/dist/docs/` の該当ガイドを確認してください（[AGENTS.md](AGENTS.md) 参照）。

## セットアップ

```bash
npm install
# データ生成（data-raw/ に元CSVを配置して実行。取得元は docs/DATA.md）
python3 scripts/preprocess.py
npm run dev   # http://localhost:3000
```

LLM は **Vertex AI Gemini**（IAM認証・APIキー不要）。ローカルで使うには `gcloud auth application-default login`（ADC）＋ `GOOGLE_CLOUD_PROJECT` を設定（`.env.local.example` 参照）。**未設定でも語句一致のfallbackで動作**します。

## ブランチ・PR フロー

- **`main` への直接 push は禁止**。必ず feature ブランチを切って PR を作成してください。
- 1 PR = 1 つの目的。関連 Issue があれば本文に `close #<番号>` を記載します。
- マージ前に以下がローカルで通ることを確認してください（CI でも検証されます）。
  ```bash
  npm run lint
  npx tsc --noEmit
  npm run build
  ```

## コミット・PR の注意

- **APIキー・トークン等のシークレットをコミットしない**（CI の gitleaks で検知されます）。
- 個人情報・実顧客データを含めない。

## データ・ライセンス

- データの出典・ライセンス・取得手順は [docs/DATA.md](docs/DATA.md) を参照してください。
- コード本体は [Apache-2.0](LICENSE)。データのライセンスとは別に扱います。
