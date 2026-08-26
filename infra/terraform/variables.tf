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
  #  ⚠️ 既定はあくまで「削除事故の防波堤」。main.tf は image = var.run_image なので、
  #     新しいタグを -var でデプロイした後に *素の* apply を実行すると image が
  #     この既定値へ巻き戻る。運用ルール:
  #       (1) デプロイは常に `-var run_image=<新タグ>` で行う、
  #       (2) 新タグを恒久化する時はこの default も同じタグへ更新する。
  #     ※ このコメントにタグ値は書かない。書くと default とコメントが二重管理になり、
  #        実際に (2) の更新漏れで default が古いまま放置された(#112)
  #     (より堅牢にするなら未指定時に稼働イメージを data source 参照する案もあるが、
  #      初回applyのchicken-egg回避が要るためプロトタイプでは既定値+運用ルールを採用)
  description = "Artifact Registryのフルイメージパス。既定=現行稼働イメージ。空文字を明示するとCloud Runを作成しない(初回土台apply用)"
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/hinan-navi-tokyo/app/hinan-navi:v7"
}

variable "gemini_location" {
  description = "Vertex AI Gemini のロケーション(Cloud Runのregionとは別。globalが2.5系モデルに広く対応)"
  type        = string
  default     = "global"
}

# 予算アラート(#69・公開時のコスト暴発の最終防波堤)。
# billing_account_id が空(既定)のときは予算リソースを作らない(count=0)ので、素の apply でも安全。
# 有効化する時だけ `-var billing_account_id=XXXXXX-XXXXXX-XXXXXX` を渡す。
# 取得: gcloud billing accounts list  (実行ロールに billing 権限が必要)
variable "billing_account_id" {
  description = "予算アラートを作成する請求先アカウントID。空なら予算リソースを作成しない(#69)"
  type        = string
  default     = ""
}

variable "monthly_budget_amount" {
  description = "月次予算のしきい値額(通貨は billing_currency)。50%/90%/100%でアラート通知(#69)"
  type        = number
  default     = 3000
  # units は整数文字列が要求されるため、正の整数のみ許可(小数はapply失敗するので事前に弾く)
  validation {
    condition     = var.monthly_budget_amount > 0 && floor(var.monthly_budget_amount) == var.monthly_budget_amount
    error_message = "monthly_budget_amount は正の整数で指定してください。"
  }
}

variable "billing_currency" {
  description = "予算の通貨コード。請求先アカウントの通貨と一致させること(不一致だと作成失敗)"
  type        = string
  default     = "JPY"
}
