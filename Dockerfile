FROM node:20-bookworm-slim AS node_deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py id_verifier.py passport_verifier.py license_verifier.py portrait_extract.py index.html ./
COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-bookworm-slim /usr/local/bin/npx /usr/local/bin/npx
COPY --from=node_deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY lib ./lib
COPY scripts ./scripts

RUN groupadd --system --gid 1001 appuser \
  && useradd --system --uid 1001 --gid appuser --no-create-home appuser \
  && chown -R appuser:appuser /app

USER appuser

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
