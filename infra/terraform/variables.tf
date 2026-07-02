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
  description = "Artifact Registryのフルイメージパス。空ならCloud Runを作成しない(初回の土台apply用)"
  type        = string
  default     = ""
}

variable "gemini_location" {
  description = "Vertex AI Gemini のロケーション(Cloud Runのregionとは別。globalが2.5系モデルに広く対応)"
  type        = string
  default     = "global"
}
