# Deploy ID/Passport API (FastAPI) to Cloud Run.
# Usage: .\deploy.ps1

$ErrorActionPreference = "Stop"

$ServiceName = "dizige-app"
$Region = "europe-west1"
$Project = "dizige"
$RuntimeSa = "python-web-runtime@${Project}.iam.gserviceaccount.com"
$BuildSa = "projects/${Project}/serviceAccounts/cloud-run-builder@${Project}.iam.gserviceaccount.com"

Write-Host "Deploying $ServiceName (ID/Passport) to Cloud Run ($Region)..." -ForegroundColor Cyan

gcloud run deploy $ServiceName `
  --source . `
  --region $Region `
  --project $Project `
  --service-account $RuntimeSa `
  --build-service-account $BuildSa `
  --allow-unauthenticated `
  --clear-base-image

if ($LASTEXITCODE -ne 0) {
  Write-Host "Deploy failed." -ForegroundColor Red
  exit $LASTEXITCODE
}

$url = gcloud run services describe $ServiceName `
  --region $Region `
  --project $Project `
  --format "value(status.url)"

Write-Host ""
Write-Host "Online: $url" -ForegroundColor Green
