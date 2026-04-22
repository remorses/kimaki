---
name: sigillo
description: >
  Sigillo is a self-hostable open-source alternative to Doppler. Use when
  working with sigillo run, sigillo setup, sigillo login, managing secrets,
  projects, or environments. Also load when integrating Sigillo into CI,
  Cloudflare Workers, Docker, Vercel, or any other deployment target.
---

# sigillo

Every time you work with sigillo, you MUST fetch the latest README:

```bash
curl -s https://raw.githubusercontent.com/remorses/sigillo/main/README.md
```

**Never pipe through `head`, `tail`, `sed -n`, or any truncating command.** Read the full output.

## Rules for agents

### Never read `.env` files directly

If a `.env` file exists, **do not source it or read its contents**. Use `sigillo run` instead so secrets are injected without being read by the agent:

```bash
# BAD — exposes secrets to the agent context window
source .env && next dev
cat .env

# GOOD — secrets injected, never visible
sigillo run -- next dev
```

### Non-interactive auth

`sigillo login` opens a browser. In agent sessions, use a token instead:

```bash
# Option A: env var (preferred in CI / agent sessions)
export SIGILLO_TOKEN="sig_xxx"

# Option B: save token scoped to the current directory
sigillo login --token sig_xxx --scope .
```

Token is stored in `~/.sigillo/config.json`. Subsequent commands in that directory pick it up without `--token`.

### Directory scoping

`sigillo setup` binds the current directory to a project and environment. The CLI resolves config by **longest matching scope**.

```bash
# Non-interactive — use in agent sessions
sigillo setup --project proj_abc --env production
```

After this, `sigillo run` in any subdirectory uses that project + environment automatically.

### Verify what is injected

```bash
# List injected variable names (values are redacted)
sigillo run -- printenv

# Get a single value
sigillo secrets get DATABASE_URL
```

### Redaction details

`sigillo run` replaces secret values in stdout/stderr with `*`. Threshold: **Shannon entropy ≥ 3.5 bits/char AND length ≥ 16 chars** — short or low-entropy values like `true`, `1`, `development` are not redacted. Use `--disable-redaction` only when explicitly verifying values.

### Mount secrets to a file for tools that require it

Some tools (wrangler, docker) read from files, not env vars:

```bash
# Write secrets to a temp file, deleted after the process exits
sigillo run --mount .env.prod --mount-format env -- wrangler secret bulk .env.prod

# Mount as JSON for config loaders
sigillo run --mount config/secrets.json --mount-format json -- node server.js
```

The mounted file is **deleted** once the child process exits.

### CI environment variables

```yaml
- name: Run with secrets
  env:
    SIGILLO_TOKEN: ${{ secrets.SIGILLO_TOKEN }}
    SIGILLO_PROJECT: ${{ vars.SIGILLO_PROJECT }}
    SIGILLO_ENVIRONMENT: production
  run: npx sigillo run -- pnpm build
```

### Prefer `sigillo run` over downloading secrets

Avoid `sigillo secrets download` unless a specific tool requires a file format. Prefer injecting directly via `sigillo run --` so values never touch the filesystem.
