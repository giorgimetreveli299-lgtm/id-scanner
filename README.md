# Driver License Verificator

Web app that extracts identification data from a driver license photo using Google Cloud Vision OCR.

## Getting started

1. Make sure `clientdocsocr.json` is in the project root (or set `GOOGLE_APPLICATION_CREDENTIALS`).
2. Cloud Vision API must be enabled on the GCP project `dizige`.
3. Install and run:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Security

- `clientdocsocr.json` is in `.gitignore` — do not commit it.
- If the key was ever shared, create a new key in Cloud Console and delete the old one.
