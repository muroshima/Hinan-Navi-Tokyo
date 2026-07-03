variable "project_id" {
  description = "GCPプロジェクトID(このリポジトリ専用)"
  type        = string
  default     = "hinan-navi-tokyo"
}

variable "region" {
  description = "デプロイリージョン(東京)"
  type        = string
  default     = "asia-northeast1"
}

variable "run_image" {
  # ⚠️ 地雷対策(2026-07-03): 以前は default="" だったため、run_imageを渡さずに
  #    `terraform apply` するとCloud Run(count)が0になりサービスと公開IAMが destroy され、
  #    ライブデモが消える事故が起きた。既定を現行の稼働イメージにして、素の apply でも
  #    サービスが維持されるようにする。
  #  - 新しいビルドをデプロイする時は必ず `-var run_image=<新タグ>` を渡す。
  #  - 初回の土台のみ作りたい(サービスを敢えて作らない)時だけ明示的に `-var run_image=""`。
  description = "Artifact Registryのフルイメージパス。既定=現行稼働イメージ。空文字を明示するとCloud Runを作成しない(初回土台apply用)"
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/hinan-navi-tokyo/app/hinan-navi:v4"
}

variable "gemini_location" {
  description = "Vertex AI Gemini のロケーション(Cloud Runのregionとは別。globalが2.5系モデルに広く対応)"
  type        = string
  default     = "global"
}
