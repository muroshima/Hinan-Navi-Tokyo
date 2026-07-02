terraform {
  required_version = ">= 1.5"
  # state はGCSに保管(#17方針)。バケットはbackendの循環を避けるためTF管理外で事前作成:
  #   gcloud storage buckets create gs://hinan-navi-tokyo-tfstate --location=asia-northeast1 --uniform-bucket-level-access
  #   gcloud storage buckets update gs://hinan-navi-tokyo-tfstate --versioning
  backend "gcs" {
    bucket = "hinan-navi-tokyo-tfstate"
    prefix = "hinan-navi"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "this" {}

locals {
  services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",                  # SA作成に必要
    "cloudresourcemanager.googleapis.com", # project IAM操作に必要
    "aiplatform.googleapis.com",           # Vertex AI Gemini(LLM)
    "bigquery.googleapis.com",             # 高齢化率の空間結合(前処理バッチ)
  ]
  repo_id = "app"
}

# 高齢化率の町丁目粒度化(#6)を行う前処理バッチ用データセット。ランタイム(Cloud Run)は使わない。
# 中身(境界/年齢/結合結果テーブル)は scripts/aging_bq.sh でいつでも再生成可能な使い捨てで、
# 成果物は data/chome_aging.json としてリポジトリに永続する。掃除を容易にするため中身ごと破棄可とする。
resource "google_bigquery_dataset" "aging" {
  dataset_id                 = "aging"
  location                   = var.region
  description                = "国勢調査小地域×避難所のST_CONTAINS空間結合(前処理・再生成可能)"
  delete_contents_on_destroy = true
  depends_on                 = [google_project_service.apis]
}

# 必要APIの有効化
resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

# コンテナイメージ格納先
resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = local.repo_id
  format        = "DOCKER"
  description   = "だれでも避難ナビ TOKYO コンテナ"
  depends_on    = [google_project_service.apis]
}

# Cloud Run 実行用サービスアカウント(最小権限)
resource "google_service_account" "run" {
  account_id   = "hinan-navi-run"
  display_name = "Hinan Navi Cloud Run SA"
  depends_on   = [google_project_service.apis]
}

# Cloud Run の Service Agent が Artifact Registry からイメージをpullできるように付与
resource "google_project_iam_member" "run_agent_ar_reader" {
  project    = var.project_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-${data.google_project.this.number}@serverless-robot-prod.iam.gserviceaccount.com"
  depends_on = [google_project_service.apis]
}

# Cloud Run 実行SAが Vertex AI Gemini を呼べるように付与(LLMはVertex=IAM認証・APIキー不要)
resource "google_project_iam_member" "run_vertex_user" {
  project    = var.project_id
  role       = "roles/aiplatform.user"
  member     = "serviceAccount:${google_service_account.run.email}"
  depends_on = [google_project_service.apis]
}

# Cloud Build(既定=compute SA)が Artifact Registry へ push できるようにリポジトリ単位で付与
resource "google_artifact_registry_repository_iam_member" "cloudbuild_writer" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.app.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

# Cloud Run サービス(run_imageが指定されたときのみ作成)
resource "google_cloud_run_v2_service" "app" {
  count               = var.run_image != "" ? 1 : 0
  name                = "hinan-navi"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.run.email
    scaling {
      min_instance_count = 0 # アイドル時は0でスケールし課金を抑える
      max_instance_count = 3
    }
    containers {
      image = var.run_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
      # Vertex AI Gemini 呼び出し用(project/location)。認証はSA(ADC)でキー不要
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GCP_LOCATION"
        value = var.gemini_location
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.run_agent_ar_reader,
    google_project_iam_member.run_vertex_user,
  ]
}

# 一般公開(誰でも閲覧可能な防災ナビ)
resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.run_image != "" ? 1 : 0
  name     = google_cloud_run_v2_service.app[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
