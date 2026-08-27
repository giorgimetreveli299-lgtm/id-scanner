# Deploy id-scanner to Google Cloud Run (Dockerfile source build).
# Usage: .\deploy.ps1
# Optional: $env:DRIVER_LICENSE_APP_URL = "https://your-license-scanner.run.app"

$ErrorActionPreference = "Stop"

$ServiceName = "dizige-app"
$Region = "europe-west1"
$Project = "dizige"
$RuntimeSa = "python-web-runtime@${Project}.iam.gserviceaccount.com"
$BuildSa = "projects/${Project}/serviceAccounts/cloud-run-builder@${Project}.iam.gserviceaccount.com"
$LicenseAppUrl = if ($env:DRIVER_LICENSE_APP_URL) {
  $env:DRIVER_LICENSE_APP_URL.TrimEnd("/")
} else {
  "http://localhost:3000"
}

Write-Host "Deploying $ServiceName to Cloud Run ($Region)..." -ForegroundColor Cyan
Write-Host "Driver License app URL: $LicenseAppUrl" -ForegroundColor DarkGray

gcloud run deploy $ServiceName `
  --source . `
  --region $Region `
  --project $Project `
  --service-account $RuntimeSa `
  --build-service-account $BuildSa `
  --allow-unauthenticated `
  --clear-base-image `
  --update-env-vars "DRIVER_LICENSE_APP_URL=$LicenseAppUrl"

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
Write-Host "Driver License box opens: $LicenseAppUrl" -ForegroundColor Green
