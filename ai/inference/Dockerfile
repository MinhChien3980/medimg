# syntax=docker/dockerfile:1
# ai-worker (CPU). Multi-arch: python:3.12-slim and the PyTorch CPU index both ship
# linux/amd64 and linux/arm64 wheels, nothing below is x86-only.
#
#   docker build -t medimg-ai-worker:dev .                 # runtime image (default, last stage)
#   docker build --target test -t medimg-ai-worker:test .  # + pytest/ruff/fakeredis/moto

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONPATH=/app

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app

WORKDIR /app

# Dependencies come from pyproject.toml (single source of truth). torch/torchvision are taken
# from the PyTorch CPU index so the image does not pull the multi-GB CUDA wheels.
COPY pyproject.toml ./
RUN python - <<'EOF'
import tomllib
deps = tomllib.load(open("pyproject.toml", "rb"))["project"]
torch = [d for d in deps["dependencies"] if d.split("=")[0] in ("torch", "torchvision")]
rest = [d for d in deps["dependencies"] if d not in torch]
open("/tmp/req-torch.txt", "w").write("\n".join(torch) + "\n")
open("/tmp/req.txt", "w").write("\n".join(rest) + "\n")
open("/tmp/req-dev.txt", "w").write("\n".join(deps["optional-dependencies"]["dev"]) + "\n")
EOF
RUN pip install --index-url https://download.pytorch.org/whl/cpu -r /tmp/req-torch.txt \
    && pip install -r /tmp/req.txt

# Pre-download the TorchXRayVision weights at build time so the container works offline.
# xrv caches them under ~/.torchxrayvision of the user that runs it.
USER app
RUN python -c "import torchxrayvision as xrv; m = xrv.models.DenseNet(weights='densenet121-res224-all'); print('weights ok', len(m.pathologies))"
USER root

# ---------------------------------------------------------------- test (dev deps + tests)
FROM base AS test
RUN pip install -r /tmp/req-dev.txt && chown app:app /app
COPY --chown=app:app worker ./worker
COPY --chown=app:app tests ./tests
USER app
ENV HOME=/home/app
CMD ["python", "-m", "pytest", "-v"]

# ---------------------------------------------------------------- runtime (default target)
FROM base AS runtime
COPY --chown=app:app worker ./worker
USER app
ENV HOME=/home/app \
    HEALTH_PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"HEALTH_PORT\", \"8090\")}/health', timeout=3)" || exit 1
CMD ["python", "-m", "worker.main"]
