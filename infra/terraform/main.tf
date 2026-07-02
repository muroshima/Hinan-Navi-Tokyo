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
    "secretmanager.googleapis.com",
    "iam.googleapis.com",                 # SA作成に必要
    "cloudresourcemanager.googleapis.com", # project IAM操作に必要
  ]
  repo_id = "app"
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

# Cloud Build(既定=compute SA)が Artifact Registry へ push できるようにリポジトリ単位で付与
resource "google_artifact_registry_repository_iam_member" "cloudbuild_writer" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.app.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

# LLMキーの「枠」のみTerraform管理。値(version)はgcloud/CIで投入し、tfstateに生値を残さない
resource "google_secret_manager_secret" "anthropic" {
  secret_id = "ANTHROPIC_API_KEY"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# 実行SAにSecret読み取り権限。注入を有効化するとき(enable_llm_secret)だけ付与し最小権限に保つ
resource "google_secret_manager_secret_iam_member" "run_access" {
  count     = var.enable_llm_secret ? 1 : 0
  secret_id = google_secret_manager_secret.anthropic.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
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
      # enable_llm_secret=true のときのみSecret Managerから注入(値はTF外で投入)
      dynamic "env" {
        for_each = var.enable_llm_secret ? [1] : []
        content {
          name = "ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
              # 同一プロジェクトのためSecret短名でOK(google_cloud_run_v2の仕様)
              secret  = google_secret_manager_secret.anthropic.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.run_access,
    google_project_iam_member.run_agent_ar_reader,
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
