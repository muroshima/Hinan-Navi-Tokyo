output "artifact_registry_image_base" {
  description = "docker build/push 先のベースパス"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${local.repo_id}"
}

output "cloud_run_url" {
  description = "公開URL(run_image指定後に有効)"
  value       = length(google_cloud_run_v2_service.app) > 0 ? google_cloud_run_v2_service.app[0].uri : "(run_image未設定のためCloud Run未作成)"
}
