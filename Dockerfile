FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py id_verifier.py passport_verifier.py portrait_extract.py index.html ./

RUN groupadd --system --gid 1001 appuser \
  && useradd --system --uid 1001 --gid appuser --no-create-home appuser \
  && chown -R appuser:appuser /app

USER appuser

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
