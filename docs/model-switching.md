---
title: Fast Model & Variant Switching
description: |
  How to quickly switch models and thinking levels using agent markdown files and Discord commands instead of the /model menu.
---

## Why agents are faster than /model

The `/model` command requires clicking through 3-4 dropdown menus every time you want to switch. With agent files you define a model + variant + permissions once, restart kimaki, and from then on you can switch with a single `/sonnet-high-agent` command. No menus, instant.

This is especially useful when you regularly switch between models during a session, for example using a cheap model for boilerplate and a powerful one for architecture decisions.

## Creating agent files

Create `.md` files in your project's `.opencode/agent/` directory. Each file becomes a selectable agent in the `/agent` dropdown and gets its own `/<name>-agent` slash command.

The file only needs YAML frontmatter. The body is an optional system prompt override.

### Examples

**.opencode/agent/sonnet-high.md** - Sonnet with high thinking, auto-allows questions and plan entry so it doesn't stall on permission prompts:

```yaml
---
description: Claude Sonnet with high thinking
mode: primary
model: anthropic/claude-sonnet-4-20250514
variant: high
permission:
  question: allow
  plan_enter: allow
---
```

**.opencode/agent/opus-max.md** - Opus with maximum thinking budget. Use for complex architecture and debugging tasks:

```yaml
---
description: Claude Opus with max thinking
mode: primary
model: anthropic/claude-opus-4-20250514
variant: max
permission:
  question: allow
  plan_enter: allow
---
```

**.opencode/agent/gpt5.md** - GPT 5 Codex for fast iteration:

```yaml
---
description: GPT 5 Codex
mode: primary
model: openai/gpt-5.3-codex
permission:
  question: allow
  plan_enter: allow
---
```

**.opencode/agent/gpt5-medium.md** - GPT 5 Codex pinned to medium reasoning effort:

```yaml
---
description: GPT 5 Codex, medium effort
mode: primary
model: openai/gpt-5.3-codex
variant: medium
permission:
  question: allow
  plan_enter: allow
---
```

**.opencode/agent/gemini-low.md** - Gemini with low thinking for quick cheap tasks. Lower temperature for more deterministic output:

```yaml
---
description: Gemini 3 pro, low thinking
mode: primary
model: google/gemini-3-pro-preview
variant: low
temperature: 0.3
permission:
  question: allow
  plan_enter: allow
---
```

**.opencode/agent/safe-build.md** - Locked down agent that can only read and edit, no bash or external tools. Useful for untrusted refactoring tasks:

```yaml
---
description: Build agent, no bash or external tools
mode: primary
model: anthropic/claude-sonnet-4-20250514
variant: high
color: '#E67E22'
steps: 50
permission:
  bash: deny
  question: allow
  plan_enter: allow
---
```

### Frontmatter reference

| Field         | Type    | Description                                                                  |
| ------------- | ------- | ---------------------------------------------------------------------------- |
| `model`       | string  | Model ID as `provider/model` (e.g. `anthropic/claude-sonnet-4-20250514`)     |
| `variant`     | string  | Reasoning level (provider/model dependent): `none`, `minimal`, `low`, `medium`, `high`, `max`, `xhigh` |
| `mode`        | string  | `primary` (top-level agent) or `all` (usable as both top-level and subagent) |
| `description` | string  | Shown in the `/agent` selector and agent autocomplete                        |
| `permission`  | object  | Auto-allow/deny permissions: `question`, `plan_enter`, `bash`, `edit`, etc.  |
| `temperature` | number  | Sampling temperature (e.g. `0.3` for deterministic, `1.0` for creative)      |
| `top_p`       | number  | Top-p nucleus sampling                                                       |
| `steps`       | number  | Max agentic iterations before forcing a text-only response                   |
| `hidden`      | boolean | Hide from the agent selector UI                                              |
| `color`       | string  | Hex color (e.g. `"#FF5733"`) or theme color (`primary`, `warning`, etc.)     |
| `options`     | object  | Extra provider-specific parameters passed through to the model API           |

Any unknown frontmatter keys are automatically merged into `options` and forwarded to the provider, so you can pass provider-specific parameters directly in frontmatter without nesting them under `options`.

### Effort customization notes

`variant` is the primary way to customize agent effort from markdown frontmatter.

- For GPT-5 models, use variants like `minimal`, `low`, `medium`, `high`, or `xhigh` (if the selected GPT-5 model supports it).
- For Anthropic models, common values are `high` and `max` (mapped to model thinking settings).
- Available values depend on the exact provider + model pair.

## Override the default `build` agent variant

The best way to override the default build agent effort is to create a file named exactly `build.md` in `.opencode/agent/`. The filename maps to the agent name, so this merges into the built-in `build` agent config.

Use both `model` and `variant` to make behavior predictable:

```yaml
---
description: Build agent pinned to GPT-5 medium effort
mode: primary
model: openai/gpt-5.3-codex
variant: medium
permission:
  question: allow
  plan_enter: allow
---
```

Why this is the most reliable approach:

- `build.md` targets the native `build` agent directly.
- `variant` gives you default effort for that agent.
- pairing with `model` avoids ambiguity when the active model changes.
- explicit per-request variant still wins when you choose one manually.

> **Prompt override callout**
> Using `.md` agent files does **not** override built-in prompts unless the file has markdown body content.
> Frontmatter-only files keep default prompt behavior and only change config fields like `model`, `variant`, `permission`, and `steps`.
> This applies to built-in agents like `build`, `plan`, `explore`, and other native agents.

### Activating

After creating or editing agent files, restart kimaki so it picks up the new slash commands. Then switch with:

- `/agent` dropdown to pick from all available agents
- `/<name>-agent` slash command for instant one-step switching (e.g. `/sonnet-high-agent`, `/opus-max-agent`, `/gpt5-agent`)

## Setting variant via /model

The `/model` command includes a variant picker. After selecting a provider and model, if the model supports thinking levels a dropdown appears. The variant is stored alongside the model at whatever scope you choose (session, channel, or global).
