# The backend does not just serve HTTP — it spawns `claude` subprocesses that
# read and write real project folders. So the image carries the CLI and the
# tooling an agent reaches for (git, ripgrep, the docker client), and the
# projects themselves are bind-mounted at their host paths by compose.
FROM node:22-bookworm-slim

ARG EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        git \
        ripgrep \
        curl \
        ca-certificates \
        less \
        docker.io \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the embedding model into the image so the first search after a fresh
# `docker compose up` is instant instead of a 220 MB download. A different model
# picked in config.yaml still works — it just downloads into the cache volume.
ENV FASTEMBED_CACHE_PATH=/opt/fastembed
RUN python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='${EMBEDDING_MODEL}', cache_dir='/opt/fastembed')"

COPY app ./app

EXPOSE 8756
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8756"]
