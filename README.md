# ID Verification

Web app for Georgian ID card and passport verification using Google Cloud Vision OCR.

## Getting started

1. Make sure `clientdocsocr.json` is in the project root (or set `GOOGLE_APPLICATION_CREDENTIALS`).
2. Cloud Vision API must be enabled on the GCP project `dizige`.
3. Install Python dependencies and run:

```bash
pip install -r requirements.txt
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

## Deploy

```bash
npm run deploy
```

## Security

- `clientdocsocr.json` is in `.gitignore` — do not commit it.
- If the key was ever shared, create a new key in Cloud Console and delete the old one.
