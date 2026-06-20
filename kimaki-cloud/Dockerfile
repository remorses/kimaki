# Kimaki Cloud — thin base image for managed kimaki machines on Fly.io.
#
# The Docker image only contains the OS, Node.js, git, bun, and the init script.
# Kimaki, opencode, and agent tools are installed into the persistent volume
# (/root) on first boot via kimaki-init.sh so they survive image updates and
# can be upgraded without recreating the machine.
#
# Volume layout:
#   /root (persistent Fly volume)
#   ├── .kimaki/           kimaki data (SQLite, credentials, logs)
#   ├── projects/          user project directories
#   ├── .bun/              bun global installs
#   ├── .npm/              npm cache + global installs
#   ├── .config/opencode/  opencode config
#   ├── .opensrc/          cached dependency source code
#   ├── .gitconfig         git config set by agents
#   └── .kimaki-initialized  sentinel file for first-boot detection

FROM node:24-slim

RUN apt-get update && apt-get install -y git curl unzip && rm -rf /var/lib/apt/lists/*

# Install bun into the image (not the volume) so it's available on first boot
# before the volume is seeded. The bun cache and global packages go to /root/.bun
# which is on the volume after mount.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

COPY kimaki-init.sh /usr/local/bin/kimaki-init.sh
RUN chmod +x /usr/local/bin/kimaki-init.sh

ENV HOME=/root
WORKDIR /root

EXPOSE 8080

CMD ["kimaki-init.sh"]
