variable "project_id" {
  description = "GCPプロジェクトID"
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

variable "anthropic_api_key" {
  description = "LLM属性抽出/タイムライン用。空ならSecret版を作らずアプリは語句一致fallbackで動作"
  type        = string
  default     = ""
  sensitive   = true
}
