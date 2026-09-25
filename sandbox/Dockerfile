# syntax=docker/dockerfile:1

# Code-execution sidecar for the bot's run_code tool: python3 (numpy, pandas, matplotlib, sympy, requests),
# node, bash, curl, jq and bc behind a stdlib-only HTTP server (server.py). It holds no secrets on purpose:
# the bot container keeps the Discord token and the OpenRouter key, this one only runs code.
# Run it with the hardening in docker-compose.yaml (read-only root, all capabilities dropped, limits).

# Node from the official image: a current release rather than Debian's older nodejs package.
FROM node:26-trixie-slim AS node

FROM python:3.14-slim-trixie

# tini as PID 1: forwards SIGTERM to the server and reaps anything that slips past it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bc ca-certificates curl jq tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

COPY requirements.txt /opt/sandbox/requirements.txt
RUN PIP_ROOT_USER_ACTION=ignore pip install --no-cache-dir -r /opt/sandbox/requirements.txt \
 && python3 -c "import numpy, pandas, matplotlib, sympy, requests"

# The unprivileged user the server and every run execute as. With every capability dropped there is no
# second user to switch to, so the server protects itself instead (see harden_self() in server.py). A fixed,
# uncommon uid keeps RLIMIT_NPROC (counted per uid across the host) from colliding with host processes.
# A fresh named volume mounted at /workspace inherits this ownership.
RUN groupadd --gid 10001 sandbox \
 && useradd --uid 10001 --gid 10001 --home-dir /workspace --no-create-home --shell /bin/bash sandbox \
 && mkdir -p /workspace/out \
 && chown -R 10001:10001 /workspace

COPY server.py /opt/sandbox/server.py

# Everyone in the server lives in Eastern time, so `date` and datetime.now() should too. Math libraries
# get one thread each: the container is capped at one CPU, and every thread counts against RLIMIT_NPROC.
ENV TZ=America/New_York \
    LANG=C.UTF-8 \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/workspace \
    SANDBOX_WORKSPACE=/workspace

USER 10001:10001
WORKDIR /workspace
VOLUME ["/workspace"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8080/health"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "/opt/sandbox/server.py"]
