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

variable "enable_llm_secret" {
  description = "trueでCloud RunにANTHROPIC_API_KEYをSecret Managerから注入。値はTFに書かずgcloud/CIで投入する(tfstateに生値を残さない)"
  type        = bool
  default     = false
}
