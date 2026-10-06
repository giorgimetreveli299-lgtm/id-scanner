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

# Always send 100% traffic to the revision this deploy just created.
# Otherwise a previous manual rollback (e.g. --to-revisions OLD=100) can leave
# the site stuck on old code even after a successful build.
$latest = gcloud run services describe $ServiceName `
  --region $Region `
  --project $Project `
  --format "value(status.latestReadyRevisionName)"

if (-not $latest) {
  Write-Host "Deploy built, but no ready revision was found." -ForegroundColor Red
  exit 1
}

gcloud run services update-traffic $ServiceName `
  --region $Region `
  --project $Project `
  --to-revisions "${latest}=100"

if ($LASTEXITCODE -ne 0) {
  Write-Host "Traffic switch to $latest failed." -ForegroundColor Red
  exit $LASTEXITCODE
}

$url = gcloud run services describe $ServiceName `
  --region $Region `
  --project $Project `
  --format "value(status.url)"

Write-Host ""
Write-Host "Online: $url" -ForegroundColor Green
Write-Host "Serving revision: $latest" -ForegroundColor Green
