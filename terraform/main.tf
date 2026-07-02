terraform {
  required_version = ">= 1.5"
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

locals {
  services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
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
}

# LLMキー(任意)。値が無ければSecret枠だけ作り、バージョンは作らない
resource "google_secret_manager_secret" "anthropic" {
  secret_id = "ANTHROPIC_API_KEY"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "anthropic" {
  count       = var.anthropic_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.anthropic.id
  secret_data = var.anthropic_api_key
}

resource "google_secret_manager_secret_iam_member" "run_access" {
  secret_id = google_secret_manager_secret.anthropic.secret_id
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
      # LLMキーがある場合のみSecret Managerから注入(無ければアプリはfallback)
      dynamic "env" {
        for_each = var.anthropic_api_key != "" ? [1] : []
        content {
          name = "ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
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
    google_secret_manager_secret_version.anthropic,
    google_secret_manager_secret_iam_member.run_access,
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
