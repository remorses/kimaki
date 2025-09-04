#!/bin/bash

PREFIX="
# Project Coding Guidelines

NOTICE: AGENTS.md is generated using AGENTS.sh and should NEVER be manually updated.

This file contains all coding guidelines and standards for this project.

---

## opentui

opentui is the framework used to render the tui, using react.

IMPORTANT! before starting every task ALWAYS read opentui docs with `curl -s https://raw.githubusercontent.com/sst/opentui/refs/heads/main/packages/react/README.md`

ALWAYS!

"

OUTPUT_FILE="AGENTS.md"

echo "$PREFIX" > "$OUTPUT_FILE"

for f in \
  core.md \
  typescript.md \
  pnpm.md \
  sentry.md \
  vitest.md \
  gitchamber.md \
  changelog.md \
  docs-writing.md \
  cac.md \
  shadcn.md \
  tailwind.md \
  spiceflow.md \
  vercel-ai-sdk.md \
  playwright.md \
  zod.md; do
  echo "Fetching $f..."
  curl -fsSL "https://raw.githubusercontent.com/remorses/AGENTS.md/main/$f" >> "$OUTPUT_FILE"
  printf '\n\n---\n\n' >> "$OUTPUT_FILE"
done

echo "✅ AGENTS.md generated successfully!"
