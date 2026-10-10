# Kimaki Cloud image for managed kimaki machines on Fly.io.
#
# kimaki and OpenCode 2 are baked in under /usr/local so first boot can answer
# /kimaki/wake inside the 30s window. User data lives on the volume at /root.
# Pin versions. Docker caches RUN npm, so @latest would freeze on first build.

FROM node:24-slim

RUN apt-get update && apt-get install -y git curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# The first OpenCode 2 kimaki release with scale-to-zero (npm kimaki@0.31.0 is still V1).
# docker build --build-arg KIMAKI_VERSION=<version> kimaki-cloud
ARG KIMAKI_VERSION
# @opencode/cli installs `opencode` and `opencode2`; kimaki starts `opencode2 serve --service`.
RUN test -n "$KIMAKI_VERSION" && npm install -g "kimaki@$KIMAKI_VERSION" @opencode/cli@2.0.26

COPY kimaki-init.sh /usr/local/bin/kimaki-init.sh
RUN chmod +x /usr/local/bin/kimaki-init.sh

ENV HOME=/root
WORKDIR /root

EXPOSE 8080

CMD ["kimaki-init.sh"]
