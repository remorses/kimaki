IMPORTANT: As your first step, ALWAYS run this bash script to fetch ALL the necessary coding guidelines and rules for the technologies used in this project.
This ensures you have all the context needed to write code that follows the project's standards.

```bash
#!/bin/bash

# Fetch all coding guidelines
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
  curl -fsSL "https://raw.githubusercontent.com/remorses/AGENTS.md/main/$f"; printf '\n'
done
```
