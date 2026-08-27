---
'kimaki': minor
---

Add **Subrouter**, a shared pool for all your AI subscriptions that fails over across providers, not just across accounts.

Run `/login` and pick **Subrouter** (now the first entry in the list). It asks which subscription to add, then pools it. Log in as many times as you like, to as many providers as you like.

Then pick the `subrouter/default` model. When a run hits a rate limit, Subrouter tries your next account. When every account of that provider is exhausted, it moves to the next provider:

```
  model: subrouter/default
       │
       ▼
  anthropic/claude-opus-4-6 ──429──▶ second Claude account ──429──▶ openai/gpt-5.5
                                                                        │
                                                        exhausted ──────┴──▶ xai/grok-4.6
```

Rate-limited accounts enter a **cooldown shared by every session on the machine**, so nothing keeps retrying a subscription that is known to be out. A `429` honors `retry-after` with a five minute floor; a `402` (balance exhausted) waits six hours.

Quota and authentication failures rotate through the pool. Normal request errors return immediately so Subrouter does not repeat a bad request across every subscription. Image and PDF prompts pass through to providers that support them, and ChatGPT requests fall back to HTTP immediately when a cached Codex WebSocket is unavailable.

Everything else about the pool is the `subrouter` CLI. Kimaki does not wrap it:

```bash
npx -y @subrouter/cli status                 # accounts, presets, cooldowns
npx -y @subrouter/cli cooldown clear         # retry everything now

# presets choose the failover order, each shows up in /model as subrouter/<name>
npx -y @subrouter/cli preset create fast --models 'anthropic/claude-opus-4-6,xai/grok-4.6'
```

The old `kimaki multioauth` commands and the per-provider rotation plugins still work and are unchanged. They are now marked legacy: they only cycle accounts inside a single provider and cannot fall back to another one.
