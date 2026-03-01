# Voice message transcription from Discord user:

Open src the chat SDK npm pac...

## Conversation

### 👤 User

[Current branch: main]

[Current branch: main]

Voice message transcription from Discord user:

Open src the chat SDK npm package. It's a generic SDK that lets you write bots for any messaging platform like Slack and Discord. Now inspect the source code and explain what is the common interface used for the platforms. Explain what you can do in the Discord one. Explain everything you can do in Discord. Then explain everything you can do in Slack. What is the most powerful of the two in the chat SDK? And if you cannot do much with the Discord one, is it because Discord mainly requires a WebSocket gateway connection instead of webhooks? Does the chat SDK support WebSockets connections?


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

<details>
<summary>💭 Thinking</summary>

The user wants me to opensrc the "chat-sdk" npm package, then analyze its source code to understand the common interface for messaging platforms, what you can do with Discord and Slack adapters, and whether it supports WebSocket connections.

Let me first download the package source code.

</details>

#### 🛠️ Tool: bash

**Input:**
```yaml
command: npx opensrc chat-sdk
description: Download chat-sdk npm package source
timeout: 60000

```

**Output:**
```

Fetching chat-sdk from npm...
  → No installed version found, using latest
  → Resolving repository...
  ✗ Error: Cannot read properties of undefined (reading 'latest')

Done: 0 succeeded, 1 failed

```

*Duration: 3.7s*


*Completed in 9.4s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: websearch

**Input:**
```yaml
query: chat-sdk npm package messaging platform Slack Discord bot
numResults: 10

```

**Output:**
```
Title: Introducing npm i chat – One codebase, every chat platform - Vercel
URL: https://vercel.com/changelog/chat-sdk
Text: # Introducing npm i chat – One codebase, every chat platform

Published: February 23, 2026 | Authors: Hayden Bleasel, Malte Ubl, Fernando Rojo, John Phamous, Nicolás Montone, Vishal Yathish

---

Building chatbots across multiple platforms traditionally requires maintaining separate codebases and handling individual platform APIs.

Today, we're open sourcing the new [Chat SDK] in public beta. It's a unified TypeScript library that lets teams write bot logic once and deploy it to Slack, Microsoft Teams, Google Chat, Discord, GitHub, and Linear.

The event-driven architecture includes type-safe handlers for mentions, messages, reactions, button clicks, and slash commands. Teams can build user interfaces using JSX cards and modals that render natively on each platform.

The SDK handles distributed state management using pluggable adapters for Redis, ioredis, and in-memory storage.

```typescript
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/

Title: vercel/chat: A unified TypeScript SDK for building chat bots ... - GitHub
URL: https://github.com/vercel/chat
Text: # Repository: vercel/chat

A unified TypeScript SDK for building chat bots across Slack, Microsoft Teams, Google Chat, Discord, and more.

- Stars: 197
- Forks: 10
- Watchers: 197
- Open issues: 20
- Primary language: TypeScript
- Languages: TypeScript (91.0%), MDX (8.7%), CSS (0.3%), JavaScript
- License: MIT License (MIT)
- Topics: ai, chat, discord, google-chat, slack, teams, vercel
- Default branch: main
- Homepage: https://chat-sdk.dev/
- Created: 2025-12-22T04:45:42Z
- Last push: 2026-02-25T01:10:16Z
- Contributors: 20 (top: cramforce, haydenbleasel, nandorojo, visyat, github-actions[bot], JohnPhamous, NicolasMontone, dependabot[bot], malewis5, Brycero)
- Releases: 244
- Latest release: chat@4.14.0 (2026-02-24T20:23:45Z)

---

# Chat SDK

[![npm version]] 
[![npm downloads]] 
[![License: MIT]] 

A unified TypeScript SDK for building chat bots across Slack, Microsoft Teams, Google Chat, Discord, GitHub, and Linear. Write your bot logic once, deploy everywhere.

## In

Title: Chat SDK
URL: https://chat-sdk.dev/
Text: Chat SDK by Vercel
[] [
Chat SDK
] 
Search…
/[GitHub] 
# Chat SDK
Chat SDK is a free, open-source template that helps you dive right into building powerful chatbot applications.
[Get Started] [Try It Out] 
How can I assist you today?
### Fully customizable
Customize your chatbot to fit the needs of your enterprise business or even your hobby project.
### Up to date
Stay up to date with the advancements in user experience and model capabilities like artifacts and reasoning.
### Best practices
We ensure the chatbot follows best practices so you can focus on building the important parts.
## Deploy your chatbot today.
[Deploy on Vercel] [Get Started]

Title: Vercel open-sources chat sdk for multi-platform bots - Facebook
URL: https://www.facebook.com/groups/techtitansgroup/posts/1596800238313955/
Text: Tech Titans | Vercel has open-sourced Chat SDK (npm i chat), a unified TypeScript library that lets teams write bot logic once and deploy it across Slack, Microsoft...

Title: Vercel Just Released a Universal Chat SDK That Actually Handles the Platform Fragmentation Problem | by Gowtham Boyina | Feb, 2026 | Towards AI
Author: Gowtham Boyina
Published Date: 2026-02-26T00:00:00.000Z
URL: https://pub.towardsai.net/vercel-just-released-a-universal-chat-sdk-that-actually-handles-the-platform-fragmentation-problem-e4e2bb314056
Text: Vercel Just Released a Universal Chat SDK That Actually Handles the Platform Fragmentation Problem | by Gowtham Boyina | Feb, 2026 | Towards AI

[Sitemap] 

[Open in app] 

Sign up

[Sign in] 

[Medium Logo] 

Get app

[Write] 

[Search] 

Sign up

[Sign in] 

## Towards AI

Follow publication

We build Enterprise AI. We teach what we learn. Join 100K+ AI practitioners on Towards AI Academy. Free: 6-day Agentic AI Engineering Email Guide: [https://email-course.towardsai.net/] 

Follow publication

Member-only story

# Vercel Just Released a Universal Chat SDK That Actually Handles the Platform Fragmentation Problem

## Write Once, Deploy to Slack, Teams, Discord, GitHub, and Linear

[Gowtham Boyina] 

7 min read

11 hours ago

--

Shar

Title: @chatbotkit/sdk
Author: 
Published Date: 2024-05-06T00:00:00.000Z
URL: https://www.npmjs.com/package/@chatbotkit/sdk
Text: @chatbotkit/sdk - npm
⚠️**Security Update**: Classic tokens have been revoked. Granular tokens are now limited to 90 days and require 2FA by default. Update your CI/CD workflows to avoid disruption.[Learn more].
×skip to:[content] [package search] [sign in] 
❤npm
[] 
Search
[Sign Up] [Sign In] 
# @chatbotkit/sdk
![TypeScript icon, indicating that this package has built-in type declarations] 
1.28.0•Public•Published9 days ago
* [Readme] 
* [CodeBeta] 
* [2 Dependencies] 
* [5 Dependents] 
* [89 Versions] 
[![Follow on Twitter]] [![ChatBotKit]] [![CBK.AI]] [![NPM]] [![Email]] [![Discord]] 
# ChatBotKit Node SDK
[] 
Welcome to the ChatBotKit Node SDK. This is a Node.js-based solution designed to simplify the process of building conversational AI chatbots. Utilize[ChatBotKit] to rapidly develop and deploy AI bots capable of natural language interactions.
## Getting Started
[] 
Embark on creating your chatbot with ChatBotKit in a few easy steps:
1. **Installation**: To 

Title: Introducing Chat SDK for Multi-Platform Support - LinkedIn
URL: https://www.linkedin.com/posts/malteubl_introducing-npm-i-chat-one-codebase-every-activity-7432159623828135936-CIVi
Text: Introducing Chat SDK for Multi-Platform Support | Malte Ubl posted on the topic | LinkedIn
## LinkedIn respects your privacy
LinkedIn and 3rd parties use essential and non-essential cookies to provide, secure, analyze and improve our Services, and to show you relevant ads (including **professional and job ads**) on and off LinkedIn. Learn more in our [Cookie Policy].
Select Accept to consent or Reject to decline non-essential cookies for this use. You can update your choices at any time in your [settings].
Accept
Reject
Agree & Join LinkedIn
By clicking Continue to join or sign in, you agree to LinkedIn’s [User Agreement], [Privacy Policy], and [Cookie Policy].
``
``
``
``
``
``
``
[
Skip to main content
] 
#
Introducing Chat SDK for Multi-Platform Support
This title was summarized by AI from the post below.
[
![View profile for Malte Ubl] 
] 
[
Malte Ubl
] 
3d
* [
Report this post
] 
Write once, chat a

Title: Node Slack SDK | Slack Developer Docs
Author: 
URL: https://slack.dev/node-slack-sdk
Text: Node Slack SDK | Slack Developer Docs
javascript
[Skip to main content] 
On this page
# Node Slack SDK
The Node Slack SDK is a collection of single-purpose packages for building Slack apps that are performant, secure, and scalable.
Just starting out?
The[Getting Started tutorial] will walk you through building your first Slack app using Node.js.
## Slack APIs[​] 
The Node Slack SDK has corresponding packages for Slack APIs. They are small and powerful when used independently, and work seamlessly when used together, too.
|Slack APIUseNPM packageWeb APISend data to or query data from Slack using any of[more than 200 methods].[`@slack/web-api`] OAuthSet up the authentication flow using V2 OAuth for Slack apps.[`@slack/oauth`] Incoming WebhooksSend notifications to a single channel that the user picks on installation.[`@slack/webhook`] Socket ModeListen for incoming messages and a limited set of events happening in Slack, using WebSocket.[`@slack/socket-mode`] 
`@slack/events-api`and`@slack/interacti

Title: GitHub - chatbotkit/node-sdk: The ChatBotKit Node SDK offers a JavaScript-based platform for effortlessly building conversational AI bots and agents.
Author: chatbotkit
Published Date: 2023-04-15T00:00:00.000Z
URL: https://github.com/chatbotkit/node-sdk
Text: GitHub - chatbotkit/node-sdk: The ChatBotKit Node SDK offers a JavaScript-based platform for effortlessly building conversational AI bots and agents.
[Skip to content] 
## Navigation Menu
Toggle navigation
[] 
[Sign in] 
Appearance settings
Search or jump to...
# Search code, repositories, users, issues, pull requests...
 
Search
Clear
[Search syntax tips] 
# Provide feedback
 
We read every piece of feedback, and take your input very seriously.
Include my email address so I can be contacted
CancelSubmit feedback
# Saved searches
## Use saved searches to filter your results more quickly
 
Name
Query
To see all available qualifiers, see our[documentation].
CancelCreate saved search
[Sign in] 
[Sign up] 
Appearance settings
Resetting focus
You signed in with another tab or window.[Reload] to refresh your session.You signed out in an


```

*Duration: 5.4s*


*Completed in 8.2s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

It's the Vercel `chat` package (npm name `chat`, repo `vercel/chat`). Let me fetch the source code.

#### 🛠️ Tool: bash

**Input:**
```yaml
command: npx opensrc vercel/chat
description: Download vercel/chat repo source
timeout: 120000

```

**Output:**
```

Fetching vercel/chat from github.com...
  → Resolving repository...
  → Found: https://github.com/vercel/chat
  → Ref: main
  → Cloning at main...
  ✓ Saved to opensrc/repos/github.com/vercel/chat

Done: 1 succeeded, 0 failed

```

*Duration: 2.3s*


*Completed in 5.9s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat</path>
<type>directory</type>
<entries>
.changeset/
.cursor/
.editorconfig
.github/
.gitignore
apps/
biome.jsonc
CLAUDE.md
examples/
knip.json
LICENSE
package.json
packages/
pnpm-lock.yaml
pnpm-workspace.yaml
README.md
skills/
tsconfig.base.json
turbo.json
vitest.config.ts

(20 entries)
</entries>
```


*Completed in 3.4s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages</path>
<type>directory</type>
<entries>
adapter-discord/
adapter-gchat/
adapter-github/
adapter-linear/
adapter-shared/
adapter-slack/
adapter-teams/
adapter-telegram/
chat/
integration-tests/
state-ioredis/
state-memory/
state-redis/

(13 entries)
</entries>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/README.md

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/README.md</path>
<type>file</type>
<content>1: # Chat SDK
2: 
3: [![npm version](https://img.shields.io/npm/v/chat)](https://www.npmjs.com/package/chat)
4: [![npm downloads](https://img.shields.io/npm/dm/chat)](https://www.npmjs.com/package/chat)
5: [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
6: 
7: A unified TypeScript SDK for building chat bots across Slack, Microsoft Teams, Google Chat, Discord, Telegram, GitHub, and Linear. Write your bot logic once, deploy everywhere.
8: 
9: ## Installation
10: 
11: ```bash
12: npm install chat
13: ```
14: 
15: Install adapters for your platforms:
16: 
17: ```bash
18: npm install @chat-adapter/slack @chat-adapter/teams @chat-adapter/gchat @chat-adapter/discord @chat-adapter/telegram
19: ```
20: 
21: ## Usage
22: 
23: ```typescript
24: import { Chat } from "chat";
25: import { createSlackAdapter } from "@chat-adapter/slack";
26: import { createRedisState } from "@chat-adapter/state-redis";
27: 
28: const bot = new Chat({
29:   userName: "mybot",
30:   adapters: {
31:     slack: createSlackAdapter(),
32:   },
33:   state: createRedisState(),
34: });
35: 
36: bot.onNewMention(async (thread) => {
37:   await thread.subscribe();
38:   await thread.post("Hello! I'm listening to this thread.");
39: });
40: 
41: bot.onSubscribedMessage(async (thread, message) => {
42:   await thread.post(`You said: ${message.text}`);
43: });
44: ```
45: 
46: See the [Getting Started guide](https://chat-sdk.dev/docs/getting-started) for a full walkthrough.
47: 
48: ## Supported platforms
49: 
50: | Platform | Package | Mentions | Reactions | Cards | Modals | Streaming | DMs |
51: |----------|---------|----------|-----------|-------|--------|-----------|-----|
52: | Slack | `@chat-adapter/slack` | Yes | Yes | Yes | Yes | Native | Yes |
53: | Microsoft Teams | `@chat-adapter/teams` | Yes | Read-only | Yes | No | Post+Edit | Yes |
54: | Google Chat | `@chat-adapter/gchat` | Yes | Yes | Yes | No | Post+Edit | Yes |
55: | Discord | `@chat-adapter/discord` | Yes | Yes | Yes | No | Post+Edit | Yes |
56: | Telegram | `@chat-adapter/telegram` | Yes | Yes | Partial | No | Post+Edit | Yes |
57: | GitHub | `@chat-adapter/github` | Yes | Yes | No | No | No | No |
58: | Linear | `@chat-adapter/linear` | Yes | Yes | No | No | No | No |
59: 
60: ## Features
61: 
62: - [**Event handlers**](https://chat-sdk.dev/docs/usage) — mentions, messages, reactions, button clicks, slash commands, modals
63: - [**AI streaming**](https://chat-sdk.dev/docs/streaming) — stream LLM responses with native Slack streaming and post+edit fallback
64: - [**Cards**](https://chat-sdk.dev/docs/cards) — JSX-based interactive cards (Block Kit, Adaptive Cards, Google Chat Cards)
65: - [**Actions**](https://chat-sdk.dev/docs/actions) — handle button clicks and dropdown selections
66: - [**Modals**](https://chat-sdk.dev/docs/modals) — form dialogs with text inputs, dropdowns, and validation
67: - [**Slash commands**](https://chat-sdk.dev/docs/slash-commands) — handle `/command` invocations
68: - [**Emoji**](https://chat-sdk.dev/docs/emoji) — type-safe, cross-platform emoji with custom emoji support
69: - [**File uploads**](https://chat-sdk.dev/docs/files) — send and receive file attachments
70: - [**Direct messages**](https://chat-sdk.dev/docs/direct-messages) — initiate DMs programmatically
71: - [**Ephemeral messages**](https://chat-sdk.dev/docs/ephemeral-messages) — user-only visible messages with DM fallback
72: 
73: ## Packages
74: 
75: | Package | Description |
76: |---------|-------------|
77: | `chat` | Core SDK with `Chat` class, types, JSX runtime, and utilities |
78: | `@chat-adapter/slack` | [Slack adapter](https://chat-sdk.dev/docs/adapters/slack) |
79: | `@chat-adapter/teams` | [Teams adapter](https://chat-sdk.dev/docs/adapters/teams) |
80: | `@chat-adapter/gchat` | [Google Chat adapter](https://chat-sdk.dev/docs/adapters/gchat) |
81: | `@chat-adapter/discord` | [Discord adapter](https://chat-sdk.dev/docs/adapters/discord) |
82: | `@chat-adapter/telegram` | [Telegram adapter](https://chat-sdk.dev/docs/adapters/telegram) |
83: | `@chat-adapter/github` | [GitHub adapter](https://chat-sdk.dev/docs/adapters/github) |
84: | `@chat-adapter/linear` | [Linear adapter](https://chat-sdk.dev/docs/adapters/linear) |
85: | `@chat-adapter/state-redis` | [Redis state adapter](https://chat-sdk.dev/docs/state/redis) (production) |
86: | `@chat-adapter/state-ioredis` | [ioredis state adapter](https://chat-sdk.dev/docs/state/ioredis) (alternative) |
87: | `@chat-adapter/state-memory` | [In-memory state adapter](https://chat-sdk.dev/docs/state/memory) (development) |
88: 
89: ## AI coding agent support
90: 
91: If you use an AI coding agent like [Claude Code](https://docs.anthropic.com/en/docs/claude-code), you can teach it about Chat SDK:
92: 
93: ```bash
94: npx skills add vercel/chat
95: ```
96: 
97: ## Documentation
98: 
99: Full documentation is available at [chat-sdk.dev/docs](https://chat-sdk.dev/docs).
100: 
101: ## Contributing
102: 
103: See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and the release process.
104: 
105: ## License
106: 
107: MIT

(End of file - total 107 lines)
</content>

<system-reminder>
Instructions from: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/CLAUDE.md
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Install dependencies
pnpm install

# Build all packages (uses Turborepo)
pnpm build

# Type-check all packages
pnpm typecheck

# Check all packages (linting and formatting)
pnpm check

# Check for unused exports/dependencies
pnpm knip

# Run all tests
pnpm test

# Run full validation. ALWAYS do this before declaring a task to be done.
pnpm validate


# Run dev mode (watch for changes)
pnpm dev

# Build a specific package
pnpm --filter chat build
pnpm --filter @chat-adapter/slack build
pnpm --filter @chat-adapter/gchat build
pnpm --filter @chat-adapter/teams build

# Run tests for a specific package
pnpm --filter chat test
pnpm --filter @chat-adapter/integration-tests test

# Run a single test file
pnpm --filter @chat-adapter/integration-tests test src/slack.test.ts
```

## Code Style

- Install dependencies with `pnpm add` rather than manually editing package.json
- `sample-messages.md` files in adapter packages contain real-world webhook logs as examples

## Architecture

This is a **pnpm monorepo** using **Turborepo** for build orchestration. All packages use ESM (`"type": "module"`), TypeScript, and **tsup** for bundling.

### Package Structure

- **`packages/chat-sdk`** - Core SDK (`chat` package) with `Chat` class, types, and markdown utilities (mdast-based)
- **`packages/adapter-slack`** - Slack adapter using `@slack/web-api`
- **`packages/adapter-gchat`** - Google Chat adapter using `googleapis`
- **`packages/adapter-teams`** - Microsoft Teams adapter using `botbuilder`
- **`packages/state-memory`** - In-memory state adapter (for development/testing)
- **`packages/state-redis`** - Redis state adapter (for production)
- **`packages/integration-tests`** - Integration tests against real platform APIs
- **`examples/nextjs-chat`** - Example Next.js app showing how to use the SDK

### Core Concepts

1. **Chat** (`packages/chat-sdk/src/chat.ts` in `chat` package) - Main entry point that coordinates adapters and handlers
2. **Adapter** - Platform-specific implementations (Slack, Teams, Google Chat). Each adapter:
   - Handles webhook verification and parsing
   - Converts platform-specific message formats to/from normalized format
   - Provides `FormatConverter` for markdown/AST transformations
3. **StateAdapter** - Persistence layer for subscriptions and distributed locking
4. **Thread** - Represents a conversation thread with methods like `post()`, `subscribe()`, `startTyping()`
5. **Message** - Normalized message format with `text`, `formatted` (mdast AST), and `raw` (platform-specific)

### Thread ID Format

All thread IDs follow the pattern: `{adapter}:{channel}:{thread}`

- Slack: `slack:C123ABC:1234567890.123456`
- Teams: `teams:{base64(conversationId)}:{base64(serviceUrl)}`
- Google Chat: `gchat:spaces/ABC123:{base64(threadName)}`

### Message Handling Flow

1. Platform sends webhook to `/api/webhooks/{platform}`
2. Adapter verifies request, parses message, calls `chat.handleIncomingMessage()`
3. Chat class acquires lock on thread, then:
   - Checks if thread is subscribed -> calls `onSubscribedMessage` handlers
   - Checks for @mention -> calls `onNewMention` handlers
   - Checks message patterns -> calls matching `onNewMessage` handlers
4. Handler receives `Thread` and `Message` objects

### Formatting System

Messages use **mdast** (Markdown AST) as the canonical format. Each adapter has a `FormatConverter` that:

- `toAst(platformText)` - Converts platform format to mdast
- `fromAst(ast)` - Converts mdast to platform format
- `renderPostable(message)` - Renders a `PostableMessage` to platform string

## Testing

### Test Utilities

The `packages/chat/src/mock-adapter.ts` file provides shared test utilities:

- `createMockAdapter(name)` - Creates a mock Adapter with vi.fn() mocks for all methods
- `createMockState()` - Creates a mock StateAdapter with working in-memory subscriptions, locks, and cache
- `createTestMessage(id, text, overrides?)` - Creates a test Message object
- `mockLogger` - A mock Logger that captures all log calls

Example usage:

```typescript
import { createMockAdapter, createMockState, createTestMessage } from "./mock-adapter";

const adapter = createMockAdapter("slack");
const state = createMockState();
const message = createTestMessage("msg-1", "Hello world");
```

## Recording & Replay Tests

Production webhook interactions can be recorded and converted into replay tests:

1. **Recording**: Enable `RECORDING_ENABLED=true` in deployed environment. Recordings are tagged with git SHA.
2. **Export**: Use `pnpm recording:list` and `pnpm recording:export <session-id>` from `examples/nextjs-chat`
3. **Convert**: Extract webhook payloads and create JSON fixtures in `packages/integration-tests/fixtures/replay/`
4. **Test**: Write replay tests using helpers from `replay-test-utils.ts`

See `packages/integration-tests/fixtures/replay/README.md` for detailed workflow.

### Downloading and Analyzing Recordings

When debugging production issues, download recordings for the current git SHA:

```bash
cd examples/nextjs-chat

# Get current SHA
git rev-parse HEAD

# List all recording sessions (look for sessions starting with your SHA)
pnpm recording:list

# Export a specific session to a file
pnpm recording:export session-<SHA>-<timestamp>-<random> 2>&1 | \
  grep -v "^>" | grep -v "^\[dotenv" | grep -v "^$" > /tmp/recording.json

# View number of entries
cat /tmp/recording.json | jq 'length'

# Group webhooks by platform
cat /tmp/recording.json | jq '[.[] | select(.type == "webhook")] | group_by(.platform) | .[] | {platform: .[0].platform, count: length}'

# Extract and analyze platform-specific webhooks
cat /tmp/recording.json | jq '[.[] | select(.type == "webhook" and .platform == "teams") | .body | fromjson]' > /tmp/teams-webhooks.json
cat /tmp/recording.json | jq '[.[] | select(.type == "webhook" and .platform == "slack") | .body | fromjson]' > /tmp/slack-webhooks.json
cat /tmp/recording.json | jq '[.[] | select(.type == "webhook" and .platform == "gchat") | .body | fromjson]' > /tmp/gchat-webhooks.json

# Inspect specific webhook fields (e.g., Teams channelData)
cat /tmp/teams-webhooks.json | jq '[.[] | {type, text, channelData, value}]'
```

## Changesets (Release Flow)

This monorepo uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs. **Every PR that changes a package's behavior must include a changeset.**

### Creating a changeset

```bash
pnpm changeset
```

You'll be prompted to:
1. **Select the affected package(s)** — choose which packages your change touches (e.g., `@chat-adapter/slack`, `chat`)
2. **Choose the semver bump** — `patch` for fixes, `minor` for new features, `major` for breaking changes
3. **Write a summary** — a short description of the change (this goes into the CHANGELOG)

This creates a markdown file in `.changeset/` — commit it with your PR.

### When to use which bump

- **patch** — bug fixes, internal refactors with no API change
- **minor** — new features, new exports, new options
- **major** — breaking changes (removed exports, changed signatures, dropped support)

### Example

```bash
pnpm changeset
# → select: @chat-adapter/slack
# → bump: minor
# → summary: Add custom installation prefix support for preview deployments
```

### Publishing (maintainers)

When changesets are merged to `main`, the Changesets GitHub Action opens a "Version Packages" PR that bumps versions and updates CHANGELOGs. Merging that PR triggers publishing to npm.

## Environment Variables

Key env vars used (see `turbo.json` for full list):

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` - Slack credentials
- `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID` - Teams credentials
- `GOOGLE_CHAT_CREDENTIALS` or `GOOGLE_CHAT_USE_ADC` - Google Chat auth
- `REDIS_URL` - Redis connection for state adapter
- `BOT_USERNAME` - Default bot username

---

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `pnpm dlx ultracite fix` before committing to ensure compliance.

</system-reminder>
```


*Completed in 2.8s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

<details>
<summary>💭 Thinking</summary>

Now I have a good overview. Let me dive into the core SDK and the Discord and Slack adapters to understand the common interface and what each platform supports.

</details>

Good, I can see the structure. Now let me dive deep into the core interface, Discord adapter, and Slack adapter.

#### ❌ Tool Error: task

```
Tool execution aborted
```


*Completed in 3m 8s*

### 👤 User

Voice message transcription from Discord user:

Open src the chat SDK npm package. It's a generic SDK that lets you write bots for any messaging platform like Slack and Discord. Now inspect the source code and explain what is the common interface used for the platforms. Explain what you can do in the Discord one. Explain everything you can do in Discord. Then explain everything you can do in Slack. What is the most powerful of the two in the chat SDK? And if you cannot do much with the Discord one, is it because Discord mainly requires a WebSocket gateway connection instead of webhooks? Does the chat SDK support WebSockets connections?


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

<details>
<summary>💭 Thinking</summary>

The user wants me to analyze the Vercel chat SDK. I already downloaded it to opensrc. Let me explore the source code thoroughly - the core interface, Discord adapter, and Slack adapter.

</details>

Let me explore the source code thoroughly.

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat</path>
<type>directory</type>
<entries>
CHANGELOG.md
package.json
README.md
src/
tsconfig.json
tsup.config.ts
vitest.config.ts

(7 entries)
</entries>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord</path>
<type>directory</type>
<entries>
CHANGELOG.md
package.json
README.md
src/
tsconfig.json
tsup.config.ts
vitest.config.ts

(7 entries)
</entries>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack</path>
<type>directory</type>
<entries>
CHANGELOG.md
package.json
README.md
sample-messages.md
src/
tsconfig.json
tsup.config.ts
vitest.config.ts

(8 entries)
</entries>
```


*Completed in 6.2s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src</path>
<type>directory</type>
<entries>
cards.test.ts
cards.ts
channel.test.ts
channel.ts
chat-singleton.test.ts
chat-singleton.ts
chat.test.ts
chat.ts
emoji.test.ts
emoji.ts
errors.test.ts
errors.ts
index.ts
jsx-react.test.tsx
jsx-runtime.test.ts
jsx-runtime.test.tsx
jsx-runtime.ts
logger.test.ts
logger.ts
markdown.test.ts
markdown.ts
message.test.ts
message.ts
mock-adapter.ts
modals.test.ts
modals.ts
serialization.test.ts
thread.test.ts
thread.ts
types.ts

(30 entries)
</entries>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src</path>
<type>directory</type>
<entries>
cards.test.ts
cards.ts
gateway.test.ts
index.test.ts
index.ts
markdown.test.ts
markdown.ts
types.ts

(8 entries)
</entries>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src</path>
<type>directory</type>
<entries>
cards.test.ts
cards.ts
crypto.test.ts
crypto.ts
index.test.ts
index.ts
markdown.test.ts
markdown.ts
modals.test.ts
modals.ts

(10 entries)
</entries>
```


*Completed in 3.8s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Now let me read the core files in parallel:

> ⚠️ **Large tool output** (60,613 chars, truncated to 30,000)

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/types.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/types.ts</path>
<type>file</type>
<content>1: /**
2:  * Core types for chat-sdk
3:  */
4: 
5: import type { Root } from "mdast";
6: import type { CardElement } from "./cards";
7: import type { CardJSXElement } from "./jsx-runtime";
8: import type { Logger, LogLevel } from "./logger";
9: import type { Message } from "./message";
10: import type { ModalElement } from "./modals";
11: 
12: // =============================================================================
13: // Re-exports from extracted modules
14: // =============================================================================
15: 
16: export {
17:   ChatError,
18:   LockError,
19:   NotImplementedError,
20:   RateLimitError,
21: } from "./errors";
22: export type { Logger, LogLevel } from "./logger";
23: export { ConsoleLogger } from "./logger";
24: 
25: // =============================================================================
26: // Configuration
27: // =============================================================================
28: 
29: /**
30:  * Chat configuration with type-safe adapter inference.
31:  * @template TAdapters - Record of adapter name to adapter instance
32:  */
33: export interface ChatConfig<
34:   TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
35: > {
36:   /** Map of adapter name to adapter instance */
37:   adapters: TAdapters;
38:   /**
39:    * TTL for message deduplication entries in milliseconds.
40:    * Defaults to 300000 (5 minutes). Increase if your webhook cold starts
41:    * cause platform retries that arrive after the default TTL expires.
42:    */
43:   dedupeTtlMs?: number;
44:   /**
45:    * Placeholder text for fallback streaming (post + edit) adapters.
46:    * Defaults to `"..."`.
47:    *
48:    * Set to `null` to avoid posting an initial placeholder message and instead
49:    * wait until some real text has been streamed before creating the message.
50:    */
51:   fallbackStreamingPlaceholderText?: string | null;
52:   /**
53:    * Logger instance or log level.
54:    * Pass "silent" to disable all logging.
55:    */
56:   logger?: Logger | LogLevel;
57:   /** State adapter for subscriptions and locking */
58:   state: StateAdapter;
59:   /**
60:    * Update interval for fallback streaming (post + edit) in milliseconds.
61:    * Defaults to 500ms. Lower values provide smoother updates but may hit rate limits.
62:    */
63:   streamingUpdateIntervalMs?: number;
64:   /** Default bot username across all adapters */
65:   userName: string;
66: }
67: 
68: /**
69:  * Options for webhook handling.
70:  */
71: export interface WebhookOptions {
72:   /**
73:    * Function to run message handling in the background.
74:    * Use this to ensure fast webhook responses while processing continues.
75:    *
76:    * @example
77:    * // Next.js App Router
78:    * import { after } from "next/server";
79:    * chat.webhooks.slack(request, { waitUntil: (p) => after(() => p) });
80:    *
81:    * @example
82:    * // Vercel Functions
83:    * import { waitUntil } from "@vercel/functions";
84:    * chat.webhooks.slack(request, { waitUntil });
85:    */
86:   waitUntil?: (task: Promise<unknown>) => void;
87: }
88: 
89: // =============================================================================
90: // Adapter Interface
91: // =============================================================================
92: 
93: /**
94:  * Adapter interface with generics for platform-specific types.
95:  * @template TThreadId - Platform-specific thread ID data type
96:  * @template TRawMessage - Platform-specific raw message type
97:  */
98: export interface Adapter<TThreadId = unknown, TRawMessage = unknown> {
99:   /** Add a reaction to a message */
100:   addReaction(
101:     threadId: string,
102:     messageId: string,
103:     emoji: EmojiValue | string
104:   ): Promise<void>;
105:   /** Bot user ID for platforms that use IDs in mentions (e.g., Slack's <@U123>) */
106:   readonly botUserId?: string;
107: 
108:   /**
109:    * Derive channel ID from a thread ID.
110:    * Default fallback: first two colon-separated parts (e.g., "slack:C123").
111:    * Adapters with different structures should override this.
112:    */
113:   channelIdFromThreadId?(threadId: string): string;
114: 
115:   /** Decode thread ID string back to platform-specific data */
116:   decodeThreadId(threadId: string): TThreadId;
117: 
118:   /** Delete a message */
119:   deleteMessage(threadId: string, messageId: string): Promise<void>;
120: 
121:   /** Edit an existing message */
122:   editMessage(
123:     threadId: string,
124:     messageId: string,
125:     message: AdapterPostableMessage
126:   ): Promise<RawMessage<TRawMessage>>;
127: 
128:   /** Encode platform-specific data into a thread ID string */
129:   encodeThreadId(platformData: TThreadId): string;
130: 
131:   /**
132:    * Fetch channel info/metadata.
133:    */
134:   fetchChannelInfo?(channelId: string): Promise<ChannelInfo>;
135: 
136:   /**
137:    * Fetch channel-level messages (top-level, not thread replies).
138:    * For example, Slack's conversations.history vs conversations.replies.
139:    */
140:   fetchChannelMessages?(
141:     channelId: string,
142:     options?: FetchOptions
143:   ): Promise<FetchResult<TRawMessage>>;
144: 
145:   /**
146:    * Fetch a single message by ID.
147:    * Optional - adapters that don't implement this will return null.
148:    *
149:    * @param threadId - The thread ID containing the message
150:    * @param messageId - The platform-specific message ID
151:    * @returns The message, or null if not found/not supported
152:    */
153:   fetchMessage?(
154:     threadId: string,
155:     messageId: string
156:   ): Promise<Message<TRawMessage> | null>;
157: 
158:   /**
159:    * Fetch messages from a thread.
160:    *
161:    * **Direction behavior:**
162:    * - `backward` (default): Fetches the most recent messages. Use this for loading
163:    *   a chat view. The `nextCursor` points to older messages.
164:    * - `forward`: Fetches the oldest messages first. Use this for iterating through
165:    *   message history. The `nextCursor` points to newer messages.
166:    *
167:    * **Message ordering:**
168:    * Messages within each page are always returned in chronological order (oldest first),
169:    * regardless of direction. This is the natural reading order for chat messages.
170:    *
171:    * @example
172:    * ```typescript
173:    * // Load most recent 50 messages for display
174:    * const recent = await adapter.fetchMessages(threadId, { limit: 50 });
175:    * // recent.messages: [older, ..., newest] in chronological order
176:    *
177:    * // Paginate backward to load older messages
178:    * const older = await adapter.fetchMessages(threadId, {
179:    *   limit: 50,
180:    *   cursor: recent.nextCursor,
181:    * });
182:    *
183:    * // Iterate through all history from the beginning
184:    * const history = await adapter.fetchMessages(threadId, {
185:    *   limit: 100,
186:    *   direction: 'forward',
187:    * });
188:    * ```
189:    */
190:   fetchMessages(
191:     threadId: string,
192:     options?: FetchOptions
193:   ): Promise<FetchResult<TRawMessage>>;
194: 
195:   /** Fetch thread metadata */
196:   fetchThread(threadId: string): Promise<ThreadInfo>;
197: 
198:   /** Handle incoming webhook request */
199:   handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>;
200: 
201:   /** Called when Chat instance is created (internal use) */
202:   initialize(chat: ChatInstance): Promise<void>;
203: 
204:   /**
205:    * Check if a thread is a direct message conversation.
206:    *
207:    * @param threadId - The thread ID to check
208:    * @returns True if the thread is a DM, false otherwise
209:    */
210:   isDM?(threadId: string): boolean;
211: 
212:   /**
213:    * List threads in a channel.
214:    */
215:   listThreads?(
216:     channelId: string,
217:     options?: ListThreadsOptions
218:   ): Promise<ListThreadsResult<TRawMessage>>;
219:   /** Unique name for this adapter (e.g., "slack", "teams") */
220:   readonly name: string;
221: 
222:   /**
223:    * Optional hook called when a thread is subscribed to.
224:    * Adapters can use this to set up platform-specific subscriptions
225:    * (e.g., Google Chat Workspace Events).
226:    */
227:   onThreadSubscribe?(threadId: string): Promise<void>;
228: 
229:   /**
230:    * Open a direct message conversation with a user.
231:    *
232:    * @param userId - The platform-specific user ID
233:    * @returns The thread ID for the DM conversation
234:    *
235:    * @example
236:    * ```typescript
237:    * const dmThreadId = await adapter.openDM("U123456");
238:    * await adapter.postMessage(dmThreadId, "Hello!");
239:    * ```
240:    */
241:   openDM?(userId: string): Promise<string>;
242: 
243:   /**
244:    * Open a modal/dialog form.
245:    *
246:    * @param triggerId - Platform-specific trigger ID from the action event
247:    * @param modal - The modal element to display
248:    * @param contextId - Optional context ID for server-side stored thread/message context
249:    * @returns The view/dialog ID
250:    */
251:   openModal?(
252:     triggerId: string,
253:     modal: ModalElement,
254:     contextId?: string
255:   ): Promise<{ viewId: string }>;
256: 
257:   /** Parse platform message format to normalized format */
258:   parseMessage(raw: TRawMessage): Message<TRawMessage>;
259: 
260:   /**
261:    * Post a message to channel top-level (not in a thread).
262:    */
263:   postChannelMessage?(
264:     channelId: string,
265:     message: AdapterPostableMessage
266:   ): Promise<RawMessage<TRawMessage>>;
267: 
268:   /**
269:    * Post an ephemeral message visible only to a specific user.
270:    *
271:    * This is optional - if not implemented, Thread.postEphemeral will
272:    * fall back to openDM + postMessage when fallbackToDM is true.
273:    *
274:    * @param threadId - The thread to post in
275:    * @param userId - The user who should see the message
276:    * @param message - The message content
277:    * @returns EphemeralMessage with usedFallback: false
278:    */
279:   postEphemeral?(
280:     threadId: string,
281:     userId: string,
282:     message: AdapterPostableMessage
283:   ): Promise<EphemeralMessage>;
284: 
285:   /** Post a message to a thread */
286:   postMessage(
287:     threadId: string,
288:     message: AdapterPostableMessage
289:   ): Promise<RawMessage<TRawMessage>>;
290: 
291:   /** Remove a reaction from a message */
292:   removeReaction(
293:     threadId: string,
294:     messageId: string,
295:     emoji: EmojiValue | string
296:   ): Promise<void>;
297: 
298:   /** Render formatted content to platform-specific string */
299:   renderFormatted(content: FormattedContent): string;
300: 
301:   /** Show typing indicator */
302:   startTyping(threadId: string, status?: string): Promise<void>;
303: 
304:   /**
305:    * Stream a message using platform-native streaming APIs.
306:    *
307:    * The adapter consumes the async iterable and handles the entire streaming lifecycle.
308:    * Only available on platforms with native streaming support (e.g., Slack).
309:    *
310:    * @param threadId - The thread to stream to
311:    * @param textStream - Async iterable of text chunks (e.g., from AI SDK)
312:    * @param options - Platform-specific streaming options
313:    * @returns The raw message after streaming completes
314:    */
315:   stream?(
316:     threadId: string,
317:     textStream: AsyncIterable<string>,
318:     options?: StreamOptions
319:   ): Promise<RawMessage<TRawMessage>>;
320:   /** Bot username (can override global userName) */
321:   readonly userName: string;
322: }
323: 
324: /**
325:  * Options for streaming messages.
326:  * Platform-specific options are passed through to the adapter.
327:  */
328: export interface StreamOptions {
329:   /** Slack: The team/workspace ID */
330:   recipientTeamId?: string;
331:   /** Slack: The user ID to stream to (for AI assistant context) */
332:   recipientUserId?: string;
333:   /** Block Kit elements to attach when stopping the stream (Slack only, via chat.stopStream) */
334:   stopBlocks?: unknown[];
335:   /** Minimum interval between updates in ms (default: 1000). Used for fallback mode (GChat/Teams). */
336:   updateIntervalMs?: number;
337: }
338: 
339: /** Internal interface for Chat instance passed to adapters */
340: export interface ChatInstance {
341:   /** Get the configured logger, optionally with a child prefix */
342:   getLogger(prefix?: string): Logger;
343: 
344:   getState(): StateAdapter;
345:   getUserName(): string;
346: 
347:   /**
348:    * @deprecated Use processMessage instead. This method is for internal use.
349:    */
350:   handleIncomingMessage(
351:     adapter: Adapter,
352:     threadId: string,
353:     message: Message
354:   ): Promise<void>;
355: 
356:   /**
357:    * Process an incoming action event (button click) from an adapter.
358:    * Handles waitUntil registration and error catching internally.
359:    *
360:    * @param event - The action event (without thread field, will be added)
361:    * @param options - Webhook options including waitUntil
362:    */
363:   processAction(
364:     event: Omit<ActionEvent, "thread" | "openModal"> & { adapter: Adapter },
365:     options?: WebhookOptions
366:   ): void;
367: 
368:   processAppHomeOpened(
369:     event: AppHomeOpenedEvent,
370:     options?: WebhookOptions
371:   ): void;
372: 
373:   processAssistantContextChanged(
374:     event: AssistantContextChangedEvent,
375:     options?: WebhookOptions
376:   ): void;
377: 
378:   processAssistantThreadStarted(
379:     event: AssistantThreadStartedEvent,
380:     options?: WebhookOptions
381:   ): void;
382:   /**
383:    * Process an incoming message from an adapter.
384:    * Handles waitUntil registration and error catching internally.
385:    *
386:    * @param adapter - The adapter that received the message
387:    * @param threadId - The thread ID
388:    * @param message - Either a parsed message, or a factory function for lazy async parsing
389:    * @param options - Webhook options including waitUntil
390:    */
391:   processMessage(
392:     adapter: Adapter,
393:     threadId: string,
394:     message: Message | (() => Promise<Message>),
395:     options?: WebhookOptions
396:   ): void;
397: 
398:   /**
399:    * Process a modal close event from an adapter.
400:    *
401:    * @param event - The modal close event (without relatedThread/relatedMessage/relatedChannel)
402:    * @param contextId - Context ID for retrieving stored thread/message/channel context
403:    * @param options - Webhook options
404:    */
405:   processModalClose(
406:     event: Omit<
407:       ModalCloseEvent,
408:       "relatedThread" | "relatedMessage" | "relatedChannel"
409:     >,
410:     contextId?: string,
411:     options?: WebhookOptions
412:   ): void;
413: 
414:   /**
415:    * Process a modal submit event from an adapter.
416:    *
417:    * @param event - The modal submit event (without relatedThread/relatedMessage/relatedChannel)
418:    * @param contextId - Context ID for retrieving stored thread/message/channel context
419:    * @param options - Webhook options
420:    */
421:   processModalSubmit(
422:     event: Omit<
423:       ModalSubmitEvent,
424:       "relatedThread" | "relatedMessage" | "relatedChannel"
425:     >,
426:     contextId?: string,
427:     options?: WebhookOptions
428:   ): Promise<ModalResponse | undefined>;
429: 
430:   /**
431:    * Process an incoming reaction event from an adapter.
432:    * Handles waitUntil registration and error catching internally.
433:    *
434:    * @param event - The reaction event (without adapter field, will be added)
435:    * @param options - Webhook options including waitUntil
436:    */
437:   processReaction(
438:     event: Omit<ReactionEvent, "adapter" | "thread"> & { adapter?: Adapter },
439:     options?: WebhookOptions
440:   ): void;
441: 
442:   /**
443:    * Process an incoming slash command from an adapter.
444:    * Handles waitUntil registration and error catching internally.
445:    *
446:    * @param event - The slash command event
447:    * @param options - Webhook options including waitUntil
448:    */
449:   processSlashCommand(
450:     event: Omit<SlashCommandEvent, "channel" | "openModal"> & {
451:       adapter: Adapter;
452:       channelId: string;
453:     },
454:     options?: WebhookOptions
455:   ): void;
456: }
457: 
458: // =============================================================================
459: // State Adapter Interface
460: // =============================================================================
461: 
462: export interface StateAdapter {
463:   /** Acquire a lock on a thread (returns null if already locked) */
464:   acquireLock(threadId: string, ttlMs: number): Promise<Lock | null>;
465:   /** Connect to the state backend */
466:   connect(): Promise<void>;
467: 
468:   /** Delete a cached value */
469:   delete(key: string): Promise<void>;
470: 
471:   /** Disconnect from the state backend */
472:   disconnect(): Promise<void>;
473: 
474:   /** Extend a lock's TTL */
475:   extendLock(lock: Lock, ttlMs: number): Promise<boolean>;
476: 
477:   /** Get a cached value by key */
478:   get<T = unknown>(key: string): Promise<T | null>;
479: 
480:   /** Check if subscribed to a thread */
481:   isSubscribed(threadId: string): Promise<boolean>;
482: 
483:   /** Release a lock */
484:   releaseLock(lock: Lock): Promise<void>;
485: 
486:   /** Set a cached value with optional TTL in milliseconds */
487:   set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
488: 
489:   /** Subscribe to a thread (persists across restarts) */
490:   subscribe(threadId: string): Promise<void>;
491: 
492:   /** Unsubscribe from a thread */
493:   unsubscribe(threadId: string): Promise<void>;
494: }
495: 
496: export interface Lock {
497:   expiresAt: number;
498:   threadId: string;
499:   token: string;
500: }
501: 
502: // =============================================================================
503: // Postable (base interface for Thread and Channel)
504: // =============================================================================
505: 
506: /**
507:  * Base interface for entities that can receive messages.
508:  * Both Thread and Channel extend this interface.
509:  *
510:  * @template TState - Custom state type stored per entity
511:  * @template TRawMessage - Platform-specific raw message type
512:  */
513: export interface Postable<
514:   TState = Record<string, unknown>,
515:   TRawMessage = unknown,
516: > {
517:   /** The adapter this entity belongs to */
518:   readonly adapter: Adapter;
519:   /** Unique ID */
520:   readonly id: string;
521:   /** Whether this is a direct message conversation */
522:   readonly isDM: boolean;
523: 
524:   /**
525:    * Get a platform-specific mention string for a user.
526:    */
527:   mentionUser(userId: string): string;
528: 
529:   /**
530:    * Iterate messages newest first (backward from most recent).
531:    * Auto-paginates lazily — only fetches pages as consumed.
532:    */
533:   readonly messages: AsyncIterable<Message<TRawMessage>>;
534: 
535:   /**
536:    * Post a message.
537:    */
538:   post(
539:     message: string | PostableMessage | CardJSXElement
540:   ): Promise<SentMessage<TRawMessage>>;
541: 
542:   /**
543:    * Post an ephemeral message visible only to a specific user.
544:    */
545:   postEphemeral(
546:     user: string | Author,
547:     message: AdapterPostableMessage | CardJSXElement,
548:     options: PostEphemeralOptions
549:   ): Promise<EphemeralMessage | null>;
550: 
551:   /**
552:    * Set the state. Merges with existing state by default.
553:    */
554:   setState(
555:     state: Partial<TState>,
556:     options?: { replace?: boolean }
557:   ): Promise<void>;
558: 
559:   /** Show typing indicator */
560:   startTyping(status?: string): Promise<void>;
561: 
562:   /**
563:    * Get the current state.
564:    * Returns null if no state has been set.
565:    */
566:   readonly state: Promise<TState | null>;
567: }
568: 
569: // =============================================================================
570: // Channel
571: // =============================================================================
572: 
573: /**
574:  * Represents a channel/conversation container that holds threads.
575:  * Extends Postable for message posting capabilities.
576:  *
577:  * @template TState - Custom state type stored per channel
578:  * @template TRawMessage - Platform-specific raw message type
579:  */
580: export interface Channel<
581:   TState = Record<string, unknown>,
582:   TRawMessage = unknown,
583: > extends Postable<TState, TRawMessage> {
584:   /** Fetch channel metadata from the platform */
585:   fetchMetadata(): Promise<ChannelInfo>;
586:   /** Channel name (e.g., "#general"). Null until fetchInfo() is called. */
587:   readonly name: string | null;
588: 
589:   /**
590:    * Iterate threads in this channel, most recently active first.
591:    * Returns ThreadSummary (lightweight) for efficiency.
592:    * Empty iterable on threadless platforms.
593:    */
594:   threads(): AsyncIterable<ThreadSummary<TRawMessage>>;
595: }
596: 
597: /**
598:  * Lightweight summary of a thread within a channel.
599:  */
600: export interface ThreadSummary<TRawMessage = unknown> {
601:   /** Full thread ID */
602:   id: string;
603:   /** Timestamp of most recent reply */
604:   lastReplyAt?: Date;
605:   /** Reply count (if available) */
606:   replyCount?: number;
607:   /** Root/first message of the thread */
608:   rootMessage: Message<TRawMessage>;
609: }
610: 
611: /**
612:  * Channel metadata returned by fetchInfo().
613:  */
614: export interface ChannelInfo {
615:   id: string;
616:   isDM?: boolean;
617:   memberCount?: number;
618:   metadata: Record<string, unknown>;
619:   name?: string;
620: }
621: 
622: /**
623:  * Options for listing threads in a channel.
624:  */
625: export interface ListThreadsOptions {
626:   cursor?: string;
627:   limit?: number;
628: }
629: 
630: /**
631:  * Result of listing threads in a channel.
632:  */
633: export interface ListThreadsResult<TRawMessage = unknown> {
634:   nextCursor?: string;
635:   threads: ThreadSummary<TRawMessage>[];
636: }
637: 
638: // =============================================================================
639: // Thread
640: // =============================================================================
641: 
642: /** Default TTL for thread state (30 days in milliseconds) */
643: export const THREAD_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
644: 
645: /**
646:  * Thread interface with support for custom state.
647:  * Extends Postable for shared message posting capabilities.
648:  *
649:  * @template TState - Custom state type stored per-thread (default: Record<string, unknown>)
650:  * @template TRawMessage - Platform-specific raw message type
651:  */
652: export interface Thread<TState = Record<string, unknown>, TRawMessage = unknown>
653:   extends Postable<TState, TRawMessage> {
654:   /**
655:    * Async iterator for all messages in the thread.
656:    * Messages are yielded in chronological order (oldest first).
657:    * Automatically handles pagination.
658:    */
659:   allMessages: AsyncIterable<Message<TRawMessage>>;
660: 
661:   /** Get the Channel containing this thread */
662:   readonly channel: Channel<TState, TRawMessage>;
663:   // Inherited from Postable: id, adapter, isDM, state, setState,
664:   //   messages (newest first), post, postEphemeral, startTyping, mentionUser
665: 
666:   /** Channel/conversation ID */
667:   readonly channelId: string;
668: 
669:   /**
670:    * Wrap a Message object as a SentMessage with edit/delete capabilities.
671:    * Used internally for reconstructing messages from serialized data.
672:    */
673:   createSentMessageFromMessage(
674:     message: Message<TRawMessage>
675:   ): SentMessage<TRawMessage>;
676: 
677:   /**
678:    * Check if this thread is currently subscribed.
679:    *
680:    * In subscribed message handlers, this is optimized to return true immediately
681:    * without a state lookup, since we already know we're in a subscribed context.
682:    *
683:    * @returns Promise resolving to true if subscribed, false otherwise
684:    */
685:   isSubscribed(): Promise<boolean>;
686: 
687:   /**
688:    * Get a platform-specific mention string for a user.
689:    * Use this to @-mention a user in a message.
690:    * @example
691:    * await thread.post(`Hey ${thread.mentionUser(userId)}, check this out!`);
692:    */
693:   mentionUser(userId: string): string;
694: 
695:   /**
696:    * Post a message to this thread.
697:    *
698:    * Supports text, markdown, cards, and streaming from async iterables.
699:    * When posting a stream (e.g., from AI SDK), uses platform-native streaming
700:    * APIs when available (Slack), or falls back to post + edit with throttling.
701:    *
702:    * @param message - String, PostableMessage, JSX Card, or AsyncIterable<string>
703:    * @returns A SentMessage with methods to edit, delete, or add reactions
704:    *
705:    * @example
706:    * ```typescript
707:    * // Simple string
708:    * await thread.post("Hello!");
709:    *
710:    * // Markdown
711:    * await thread.post({ markdown: "**Bold** and _italic_" });
712:    *
713:    * // With emoji
714:    * await thread.post(`${emoji.thumbs_up} Great job!`);
715:    *
716:    * // JSX Card (with @jsxImportSource chat)
717:    * await thread.post(
718:    *   <Card title="Welcome!">
719:    *     <Text>Hello world</Text>
720:    *   </Card>
721:    * );
722:    *
723:    * // Stream from AI SDK
724:    * const result = await agent.stream({ prompt: message.text });
725:    * await thread.post(result.textStream);
726:    * ```
727:    */
728:   post(
729:     message: string | PostableMessage | CardJSXElement
730:   ): Promise<SentMessage<TRawMessage>>;
731: 
732:   /**
733:    * Post an ephemeral message visible only to a specific user.
734:    *
735:    * **Platform Behavior:**
736:    * - **Slack**: Native ephemeral (session-dependent, disappears on reload)
737:    * - **Google Chat**: Native private message (persists, only target user sees it)
738:    * - **Discord**: No native support - requires fallbackToDM: true
739:    * - **Teams**: No native support - requires fallbackToDM: true
740:    *
741:    * @param user - User ID string or Author object (from message.author or event.user)
742:    * @param message - Message content (string, markdown, card, etc.). Streaming is not supported.
743:    * @param options.fallbackToDM - Required. If true, falls back to DM when native
744:    *   ephemeral is not supported. If false, returns null when unsupported.
745:    * @returns EphemeralMessage with `usedFallback: true` if DM was used, or null
746:    *   if native ephemeral not supported and fallbackToDM is false
747:    *
748:    * @example
749:    * ```typescript
750:    * // Always send (DM fallback on Discord/Teams)
751:    * await thread.postEphemeral(user, 'Only you can see this!', { fallbackToDM: true })
752:    *
753:    * // Only send if native ephemeral supported (Slack/GChat)
754:    * const result = await thread.postEphemeral(user, 'Secret!', { fallbackToDM: false })
755:    * if (!result) {
756:    *   // Platform doesn't support native ephemeral - handle accordingly
757:    * }
758:    * ```
759:    */
760:   postEphemeral(
761:     user: string | Author,
762:     message: AdapterPostableMessage | CardJSXElement,
763:     options: PostEphemeralOptions
764:   ): Promise<EphemeralMessage | null>;
765: 
766:   /** Recently fetched messages (cached) */
767:   recentMessages: Message<TRawMessage>[];
768: 
769:   /**
770:    * Refresh `recentMessages` from the API.
771:    *
772:    * Fetches the latest 50 messages and updates `recentMessages`.
773:    */
774:   refresh(): Promise<void>;
775: 
776:   /**
777:    * Show typing indicator in the thread.
778:    *
779:    * Some platforms support persistent typing indicators, others just send once.
780:    * Optional status (e.g. "Typing...", "Searching documents...") is shown where supported.
781:    */
782:   startTyping(status?: string): Promise<void>;
783: 
784:   /**
785:    * Subscribe to future messages in this thread.
786:    *
787:    * Once subscribed, all messages in this thread will trigger `onSubscribedMessage` handlers.
788:    * The initial message that triggered subscription will NOT fire the handler.
789:    *
790:    * @example
791:    * ```typescript
792:    * chat.onNewMention(async (thread, message) => {
793:    *   await thread.subscribe();  // Subscribe to follow-up messages
794:    *   await thread.post("I'm now watching this thread!");
795:    * });
796:    * ```
797:    */
798:   subscribe(): Promise<void>;
799: 
800:   /**
801:    * Unsubscribe from this thread.
802:    *
803:    * Future messages will no longer trigger `onSubscribedMessage` handlers.
804:    */
805:   unsubscribe(): Promise<void>;
806: }
807: 
808: export interface ThreadInfo {
809:   channelId: string;
810:   channelName?: string;
811:   id: string;
812:   /** Whether this is a direct message conversation */
813:   isDM?: boolean;
814:   /** Platform-specific metadata */
815:   metadata: Record<string, unknown>;
816: }
817: 
818: /**
819:  * Direction for fetching messages.
820:  *
821:  * - `backward`: Fetch most recent messages first. Pagination moves toward older messages.
822:  *   This is the default, suitable for loading a chat view (show latest messages first).
823:  *
824:  * - `forward`: Fetch oldest messages first. Pagination moves toward newer messages.
825:  *   Suitable for iterat
...(truncated)
```

> ⚠️ **Large tool output** (59,317 chars, truncated to 30,000)

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/chat.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/chat.ts</path>
<type>file</type>
<content>1: import { ChannelImpl, type SerializedChannel } from "./channel";
2: import {
3:   getChatSingleton,
4:   hasChatSingleton,
5:   setChatSingleton,
6: } from "./chat-singleton";
7: import { isJSX, toModalElement } from "./jsx-runtime";
8: import { Message, type SerializedMessage } from "./message";
9: import type { ModalElement } from "./modals";
10: import { type SerializedThread, ThreadImpl } from "./thread";
11: import type {
12:   ActionEvent,
13:   ActionHandler,
14:   Adapter,
15:   AppHomeOpenedEvent,
16:   AppHomeOpenedHandler,
17:   AssistantContextChangedEvent,
18:   AssistantContextChangedHandler,
19:   AssistantThreadStartedEvent,
20:   AssistantThreadStartedHandler,
21:   Author,
22:   Channel,
23:   ChatConfig,
24:   ChatInstance,
25:   EmojiValue,
26:   Logger,
27:   LogLevel,
28:   MentionHandler,
29:   MessageHandler,
30:   ModalCloseEvent,
31:   ModalCloseHandler,
32:   ModalResponse,
33:   ModalSubmitEvent,
34:   ModalSubmitHandler,
35:   ReactionEvent,
36:   ReactionHandler,
37:   SentMessage,
38:   SlashCommandEvent,
39:   SlashCommandHandler,
40:   StateAdapter,
41:   SubscribedMessageHandler,
42:   Thread,
43:   WebhookOptions,
44: } from "./types";
45: import { ChatError, ConsoleLogger, LockError } from "./types";
46: 
47: const DEFAULT_LOCK_TTL_MS = 30_000; // 30 seconds
48: const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/i;
49: const DISCORD_SNOWFLAKE_REGEX = /^\d{17,19}$/;
50: /** TTL for message deduplication entries */
51: const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes
52: const MODAL_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
53: 
54: /** Server-side stored modal context */
55: interface StoredModalContext {
56:   channel?: SerializedChannel;
57:   message?: SerializedMessage;
58:   thread?: SerializedThread;
59: }
60: 
61: interface MessagePattern<TState = Record<string, unknown>> {
62:   handler: MessageHandler<TState>;
63:   pattern: RegExp;
64: }
65: 
66: /** Filter can be EmojiValue objects, emoji names, or raw emoji formats */
67: type EmojiFilter = EmojiValue | string;
68: 
69: interface ReactionPattern {
70:   /** If specified, only these emoji trigger the handler. Empty means all emoji. */
71:   emoji: EmojiFilter[];
72:   handler: ReactionHandler;
73: }
74: 
75: interface ActionPattern {
76:   /** If specified, only these action IDs trigger the handler. Empty means all actions. */
77:   actionIds: string[];
78:   handler: ActionHandler;
79: }
80: 
81: interface ModalSubmitPattern {
82:   callbackIds: string[];
83:   handler: ModalSubmitHandler;
84: }
85: 
86: interface ModalClosePattern {
87:   callbackIds: string[];
88:   handler: ModalCloseHandler;
89: }
90: 
91: interface SlashCommandPattern<TState = Record<string, unknown>> {
92:   /** If specified, only these commands trigger the handler. Empty means all commands. */
93:   commands: string[];
94:   handler: SlashCommandHandler<TState>;
95: }
96: 
97: /**
98:  * Type-safe webhook handler that is available for each adapter.
99:  */
100: type WebhookHandler = (
101:   request: Request,
102:   options?: WebhookOptions
103: ) => Promise<Response>;
104: 
105: /**
106:  * Creates a type-safe webhooks object based on the adapter names.
107:  */
108: type Webhooks<TAdapters extends Record<string, Adapter>> = {
109:   [K in keyof TAdapters]: WebhookHandler;
110: };
111: 
112: /**
113:  * Main Chat class with type-safe adapter inference and custom thread state.
114:  *
115:  * @template TAdapters - Map of adapter names to Adapter instances
116:  * @template TState - Custom state type stored per-thread (default: Record<string, unknown>)
117:  *
118:  * @example
119:  * // Define custom thread state type
120:  * interface MyThreadState {
121:  *   aiMode?: boolean;
122:  *   userName?: string;
123:  * }
124:  *
125:  * const chat = new Chat<typeof adapters, MyThreadState>({
126:  *   userName: "mybot",
127:  *   adapters: {
128:  *     slack: createSlackAdapter({ ... }),
129:  *     teams: createTeamsAdapter({ ... }),
130:  *   },
131:  *   state: createMemoryState(),
132:  * });
133:  *
134:  * // Type-safe thread state
135:  * chat.onNewMention(async (thread, message) => {
136:  *   await thread.setState({ aiMode: true });
137:  *   const state = await thread.state; // Type: MyThreadState | null
138:  * });
139:  */
140: export class Chat<
141:   TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
142:   TState = Record<string, unknown>,
143: > implements ChatInstance
144: {
145:   /**
146:    * Register this Chat instance as the global singleton.
147:    * Required for Thread deserialization via @workflow/serde.
148:    *
149:    * @example
150:    * ```typescript
151:    * const chat = new Chat({ ... });
152:    * chat.registerSingleton();
153:    *
154:    * // Now threads can be deserialized without passing chat explicitly
155:    * const thread = ThreadImpl.fromJSON(serializedThread);
156:    * ```
157:    */
158:   registerSingleton(): this {
159:     setChatSingleton(this);
160:     return this;
161:   }
162: 
163:   /**
164:    * Get the registered singleton Chat instance.
165:    * Throws if no singleton has been registered.
166:    */
167:   static getSingleton(): Chat {
168:     return getChatSingleton() as Chat;
169:   }
170: 
171:   /**
172:    * Check if a singleton has been registered.
173:    */
174:   static hasSingleton(): boolean {
175:     return hasChatSingleton();
176:   }
177: 
178:   private readonly adapters: Map<string, Adapter>;
179:   private readonly _stateAdapter: StateAdapter;
180:   private readonly userName: string;
181:   private readonly logger: Logger;
182:   private readonly _streamingUpdateIntervalMs: number;
183:   private readonly _fallbackStreamingPlaceholderText: string | null;
184:   private readonly _dedupeTtlMs: number;
185: 
186:   private readonly mentionHandlers: MentionHandler<TState>[] = [];
187:   private readonly messagePatterns: MessagePattern<TState>[] = [];
188:   private readonly subscribedMessageHandlers: SubscribedMessageHandler<TState>[] =
189:     [];
190:   private readonly reactionHandlers: ReactionPattern[] = [];
191:   private readonly actionHandlers: ActionPattern[] = [];
192:   private readonly modalSubmitHandlers: ModalSubmitPattern[] = [];
193:   private readonly modalCloseHandlers: ModalClosePattern[] = [];
194:   private readonly slashCommandHandlers: SlashCommandPattern<TState>[] = [];
195:   private readonly assistantThreadStartedHandlers: AssistantThreadStartedHandler[] =
196:     [];
197:   private readonly assistantContextChangedHandlers: AssistantContextChangedHandler[] =
198:     [];
199:   private readonly appHomeOpenedHandlers: AppHomeOpenedHandler[] = [];
200: 
201:   /** Initialization state */
202:   private initPromise: Promise<void> | null = null;
203:   private initialized = false;
204: 
205:   /**
206:    * Type-safe webhook handlers keyed by adapter name.
207:    * @example
208:    * chat.webhooks.slack(request, { backgroundTask: waitUntil });
209:    */
210:   readonly webhooks: Webhooks<TAdapters>;
211: 
212:   constructor(config: ChatConfig<TAdapters>) {
213:     this.userName = config.userName;
214:     this._stateAdapter = config.state;
215:     this.adapters = new Map();
216:     this._streamingUpdateIntervalMs = config.streamingUpdateIntervalMs ?? 500;
217:     this._fallbackStreamingPlaceholderText =
218:       config.fallbackStreamingPlaceholderText !== undefined
219:         ? config.fallbackStreamingPlaceholderText
220:         : "...";
221:     this._dedupeTtlMs = config.dedupeTtlMs ?? DEDUPE_TTL_MS;
222: 
223:     // Initialize logger
224:     if (typeof config.logger === "string") {
225:       this.logger = new ConsoleLogger(config.logger as LogLevel);
226:     } else {
227:       this.logger = config.logger || new ConsoleLogger("info");
228:     }
229: 
230:     // Register adapters and create webhook handlers
231:     const webhooks = {} as Record<string, WebhookHandler>;
232:     for (const [name, adapter] of Object.entries(config.adapters)) {
233:       this.adapters.set(name, adapter);
234:       // Create webhook handler for each adapter
235:       webhooks[name] = (request: Request, options?: WebhookOptions) =>
236:         this.handleWebhook(name, request, options);
237:     }
238:     this.webhooks = webhooks as Webhooks<TAdapters>;
239: 
240:     this.logger.debug("Chat instance created", {
241:       adapters: Object.keys(config.adapters),
242:     });
243:   }
244: 
245:   /**
246:    * Handle a webhook request for a specific adapter.
247:    * Automatically initializes adapters on first call.
248:    */
249:   private async handleWebhook(
250:     adapterName: string,
251:     request: Request,
252:     options?: WebhookOptions
253:   ): Promise<Response> {
254:     // Ensure initialization
255:     await this.ensureInitialized();
256: 
257:     const adapter = this.adapters.get(adapterName);
258:     if (!adapter) {
259:       return new Response(`Unknown adapter: ${adapterName}`, { status: 404 });
260:     }
261: 
262:     return adapter.handleWebhook(request, options);
263:   }
264: 
265:   /**
266:    * Ensure the chat instance is initialized.
267:    * This is called automatically before handling webhooks.
268:    */
269:   private async ensureInitialized(): Promise<void> {
270:     if (this.initialized) {
271:       return;
272:     }
273: 
274:     // Avoid concurrent initialization
275:     if (!this.initPromise) {
276:       this.initPromise = this.doInitialize();
277:     }
278: 
279:     await this.initPromise;
280:   }
281: 
282:   private async doInitialize(): Promise<void> {
283:     this.logger.info("Initializing chat instance...");
284:     await this._stateAdapter.connect();
285:     this.logger.debug("State connected");
286: 
287:     const initPromises = Array.from(this.adapters.values()).map(
288:       async (adapter) => {
289:         this.logger.debug("Initializing adapter", adapter.name);
290:         const result = await adapter.initialize(this);
291:         this.logger.debug("Adapter initialized", adapter.name);
292:         return result;
293:       }
294:     );
295:     await Promise.all(initPromises);
296: 
297:     this.initialized = true;
298:     this.logger.info("Chat instance initialized", {
299:       adapters: Array.from(this.adapters.keys()),
300:     });
301:   }
302: 
303:   /**
304:    * Gracefully shut down the chat instance.
305:    */
306:   async shutdown(): Promise<void> {
307:     this.logger.info("Shutting down chat instance...");
308:     await this._stateAdapter.disconnect();
309:     this.initialized = false;
310:     this.initPromise = null;
311:     this.logger.info("Chat instance shut down");
312:   }
313: 
314:   /**
315:    * Initialize the chat instance and all adapters.
316:    * This is called automatically when handling webhooks, but can be called
317:    * manually for non-webhook use cases (e.g., Gateway listeners).
318:    */
319:   async initialize(): Promise<void> {
320:     await this.ensureInitialized();
321:   }
322: 
323:   /**
324:    * Register a handler for new @-mentions of the bot.
325:    *
326:    * **Important**: This handler is ONLY called for mentions in **unsubscribed** threads.
327:    * Once a thread is subscribed (via `thread.subscribe()`), subsequent messages
328:    * including @-mentions go to `onSubscribedMessage` handlers instead.
329:    *
330:    * To detect mentions in subscribed threads, check `message.isMention`:
331:    *
332:    * @example
333:    * ```typescript
334:    * // Handle new mentions (unsubscribed threads only)
335:    * chat.onNewMention(async (thread, message) => {
336:    *   await thread.subscribe();  // Subscribe to follow-up messages
337:    *   await thread.post("Hello! I'll be watching this thread.");
338:    * });
339:    *
340:    * // Handle all messages in subscribed threads
341:    * chat.onSubscribedMessage(async (thread, message) => {
342:    *   if (message.isMention) {
343:    *     // User @-mentioned us in a thread we're already watching
344:    *     await thread.post("You mentioned me again!");
345:    *   }
346:    * });
347:    * ```
348:    */
349:   onNewMention(handler: MentionHandler<TState>): void {
350:     this.mentionHandlers.push(handler);
351:     this.logger.debug("Registered mention handler");
352:   }
353: 
354:   /**
355:    * Register a handler for messages matching a regex pattern.
356:    *
357:    * @param pattern - Regular expression to match against message text
358:    * @param handler - Handler called when pattern matches
359:    *
360:    * @example
361:    * ```typescript
362:    * // Match messages starting with "!help"
363:    * chat.onNewMessage(/^!help/, async (thread, message) => {
364:    *   await thread.post("Available commands: !help, !status, !ping");
365:    * });
366:    * ```
367:    */
368:   onNewMessage(pattern: RegExp, handler: MessageHandler<TState>): void {
369:     this.messagePatterns.push({ pattern, handler });
370:     this.logger.debug("Registered message pattern handler", {
371:       pattern: pattern.toString(),
372:     });
373:   }
374: 
375:   /**
376:    * Register a handler for messages in subscribed threads.
377:    *
378:    * Called for all messages in threads that have been subscribed via `thread.subscribe()`.
379:    * This includes:
380:    * - Follow-up messages from users
381:    * - Messages that @-mention the bot (check `message.isMention`)
382:    *
383:    * Does NOT fire for:
384:    * - The message that triggered the subscription (e.g., the initial @mention)
385:    * - Messages sent by the bot itself
386:    *
387:    * @example
388:    * ```typescript
389:    * chat.onSubscribedMessage(async (thread, message) => {
390:    *   // Handle all follow-up messages
391:    *   if (message.isMention) {
392:    *     // User @-mentioned us in a subscribed thread
393:    *   }
394:    *   await thread.post(`Got your message: ${message.text}`);
395:    * });
396:    * ```
397:    */
398:   onSubscribedMessage(handler: SubscribedMessageHandler<TState>): void {
399:     this.subscribedMessageHandlers.push(handler);
400:     this.logger.debug("Registered subscribed message handler");
401:   }
402: 
403:   /**
404:    * Register a handler for reaction events.
405:    *
406:    * @example
407:    * ```typescript
408:    * // Handle specific emoji using EmojiValue objects (recommended)
409:    * chat.onReaction([emoji.thumbs_up, emoji.heart], async (event) => {
410:    *   if (event.emoji === emoji.thumbs_up) {
411:    *     console.log("Thumbs up!");
412:    *   }
413:    * });
414:    *
415:    * // Handle all reactions
416:    * chat.onReaction(async (event) => {
417:    *   console.log(`${event.added ? "Added" : "Removed"} ${event.emoji.name}`);
418:    * });
419:    * ```
420:    *
421:    * @param emojiOrHandler - Either an array of emoji to filter (EmojiValue or string), or the handler
422:    * @param handler - The handler (if emoji filter is provided)
423:    */
424:   onReaction(handler: ReactionHandler): void;
425:   onReaction(emoji: EmojiFilter[], handler: ReactionHandler): void;
426:   onReaction(
427:     emojiOrHandler: EmojiFilter[] | ReactionHandler,
428:     handler?: ReactionHandler
429:   ): void {
430:     if (typeof emojiOrHandler === "function") {
431:       // No emoji filter - handle all reactions
432:       this.reactionHandlers.push({ emoji: [], handler: emojiOrHandler });
433:       this.logger.debug("Registered reaction handler for all emoji");
434:     } else if (handler) {
435:       // Specific emoji filter
436:       this.reactionHandlers.push({ emoji: emojiOrHandler, handler });
437:       this.logger.debug("Registered reaction handler", {
438:         emoji: emojiOrHandler.map((e) => (typeof e === "string" ? e : e.name)),
439:       });
440:     }
441:   }
442: 
443:   /**
444:    * Register a handler for action events (button clicks in cards).
445:    *
446:    * @example
447:    * ```typescript
448:    * // Handle specific action
449:    * chat.onAction("approve", async (event) => {
450:    *   await event.thread.post("Approved!");
451:    * });
452:    *
453:    * // Handle multiple actions
454:    * chat.onAction(["approve", "reject"], async (event) => {
455:    *   if (event.actionId === "approve") {
456:    *     await event.thread.post("Approved!");
457:    *   } else {
458:    *     await event.thread.post("Rejected!");
459:    *   }
460:    * });
461:    *
462:    * // Handle all actions (catch-all)
463:    * chat.onAction(async (event) => {
464:    *   console.log(`Action: ${event.actionId}`);
465:    * });
466:    * ```
467:    *
468:    * @param actionIdOrHandler - Either an action ID, array of action IDs, or the handler
469:    * @param handler - The handler (if action ID filter is provided)
470:    */
471:   onAction(handler: ActionHandler): void;
472:   onAction(actionIds: string[] | string, handler: ActionHandler): void;
473:   onAction(
474:     actionIdOrHandler: string | string[] | ActionHandler,
475:     handler?: ActionHandler
476:   ): void {
477:     if (typeof actionIdOrHandler === "function") {
478:       // No action filter - handle all actions
479:       this.actionHandlers.push({ actionIds: [], handler: actionIdOrHandler });
480:       this.logger.debug("Registered action handler for all actions");
481:     } else if (handler) {
482:       // Specific action ID(s) filter
483:       const actionIds = Array.isArray(actionIdOrHandler)
484:         ? actionIdOrHandler
485:         : [actionIdOrHandler];
486:       this.actionHandlers.push({ actionIds, handler });
487:       this.logger.debug("Registered action handler", { actionIds });
488:     }
489:   }
490: 
491:   onModalSubmit(handler: ModalSubmitHandler): void;
492:   onModalSubmit(
493:     callbackIds: string[] | string,
494:     handler: ModalSubmitHandler
495:   ): void;
496:   onModalSubmit(
497:     callbackIdOrHandler: string | string[] | ModalSubmitHandler,
498:     handler?: ModalSubmitHandler
499:   ): void {
500:     if (typeof callbackIdOrHandler === "function") {
501:       this.modalSubmitHandlers.push({
502:         callbackIds: [],
503:         handler: callbackIdOrHandler,
504:       });
505:       this.logger.debug("Registered modal submit handler for all modals");
506:     } else if (handler) {
507:       const callbackIds = Array.isArray(callbackIdOrHandler)
508:         ? callbackIdOrHandler
509:         : [callbackIdOrHandler];
510:       this.modalSubmitHandlers.push({ callbackIds, handler });
511:       this.logger.debug("Registered modal submit handler", { callbackIds });
512:     }
513:   }
514: 
515:   onModalClose(handler: ModalCloseHandler): void;
516:   onModalClose(
517:     callbackIds: string[] | string,
518:     handler: ModalCloseHandler
519:   ): void;
520:   onModalClose(
521:     callbackIdOrHandler: string | string[] | ModalCloseHandler,
522:     handler?: ModalCloseHandler
523:   ): void {
524:     if (typeof callbackIdOrHandler === "function") {
525:       this.modalCloseHandlers.push({
526:         callbackIds: [],
527:         handler: callbackIdOrHandler,
528:       });
529:       this.logger.debug("Registered modal close handler for all modals");
530:     } else if (handler) {
531:       const callbackIds = Array.isArray(callbackIdOrHandler)
532:         ? callbackIdOrHandler
533:         : [callbackIdOrHandler];
534:       this.modalCloseHandlers.push({ callbackIds, handler });
535:       this.logger.debug("Registered modal close handler", { callbackIds });
536:     }
537:   }
538: 
539:   /**
540:    * Register a handler for slash command events.
541:    *
542:    * Slash commands are triggered when a user types `/command` in the message composer.
543:    * Use `event.channel.post()` or `event.channel.postEphemeral()` to respond.
544:    *
545:    * @example
546:    * ```typescript
547:    * // Handle a specific command
548:    * chat.onSlashCommand("/help", async (event) => {
549:    *   await event.channel.post("Here are the available commands...");
550:    * });
551:    *
552:    * // Handle multiple commands
553:    * chat.onSlashCommand(["/status", "/health"], async (event) => {
554:    *   await event.channel.post("All systems operational!");
555:    * });
556:    *
557:    * // Handle all commands (catch-all)
558:    * chat.onSlashCommand(async (event) => {
559:    *   console.log(`Received command: ${event.command} ${event.text}`);
560:    * });
561:    *
562:    * // Open a modal from a slash command
563:    * chat.onSlashCommand("/feedback", async (event) => {
564:    *   await event.openModal({
565:    *     callbackId: "feedback_modal",
566:    *     title: "Submit Feedback",
567:    *     inputs: [{ id: "feedback", type: "text_input", label: "Your feedback" }],
568:    *   });
569:    * });
570:    * ```
571:    *
572:    * @param commandOrHandler - Either a command, array of commands, or the handler
573:    * @param handler - The handler (if command filter is provided)
574:    */
575:   onSlashCommand(handler: SlashCommandHandler<TState>): void;
576:   onSlashCommand(
577:     commands: string[] | string,
578:     handler: SlashCommandHandler<TState>
579:   ): void;
580:   onSlashCommand(
581:     commandOrHandler: string | string[] | SlashCommandHandler<TState>,
582:     handler?: SlashCommandHandler<TState>
583:   ): void {
584:     if (typeof commandOrHandler === "function") {
585:       this.slashCommandHandlers.push({
586:         commands: [],
587:         handler: commandOrHandler,
588:       });
589:       this.logger.debug("Registered slash command handler for all commands");
590:     } else if (handler) {
591:       const commands = Array.isArray(commandOrHandler)
592:         ? commandOrHandler
593:         : [commandOrHandler];
594:       const normalizedCommands = commands.map((cmd) =>
595:         cmd.startsWith("/") ? cmd : `/${cmd}`
596:       );
597:       this.slashCommandHandlers.push({ commands: normalizedCommands, handler });
598:       this.logger.debug("Registered slash command handler", {
599:         commands: normalizedCommands,
600:       });
601:     }
602:   }
603: 
604:   onAssistantThreadStarted(handler: AssistantThreadStartedHandler): void {
605:     this.assistantThreadStartedHandlers.push(handler);
606:     this.logger.debug("Registered assistant thread started handler");
607:   }
608: 
609:   onAssistantContextChanged(handler: AssistantContextChangedHandler): void {
610:     this.assistantContextChangedHandlers.push(handler);
611:     this.logger.debug("Registered assistant context changed handler");
612:   }
613: 
614:   onAppHomeOpened(handler: AppHomeOpenedHandler): void {
615:     this.appHomeOpenedHandlers.push(handler);
616:     this.logger.debug("Registered app home opened handler");
617:   }
618: 
619:   /**
620:    * Get an adapter by name with type safety.
621:    */
622:   getAdapter<K extends keyof TAdapters>(name: K): TAdapters[K] {
623:     return this.adapters.get(name as string) as TAdapters[K];
624:   }
625: 
626:   /**
627:    * Get a JSON.parse reviver function that automatically deserializes
628:    * chat:Thread and chat:Message objects.
629:    *
630:    * Use this when parsing JSON that contains serialized Thread or Message objects
631:    * (e.g., from workflow engine payloads).
632:    *
633:    * @returns A reviver function for JSON.parse
634:    *
635:    * @example
636:    * ```typescript
637:    * // Parse workflow payload with automatic deserialization
638:    * const data = JSON.parse(payload, chat.reviver());
639:    *
640:    * // data.thread is now a ThreadImpl instance
641:    * // data.message is now a Message object with Date fields restored
642:    * await data.thread.post("Hello from workflow!");
643:    * ```
644:    */
645:   reviver(): (key: string, value: unknown) => unknown {
646:     // Ensure this chat instance is registered as singleton for thread deserialization
647:     this.registerSingleton();
648:     return function reviver(_key: string, value: unknown): unknown {
649:       if (value && typeof value === "object" && "_type" in value) {
650:         const typed = value as { _type: string };
651:         if (typed._type === "chat:Thread") {
652:           return ThreadImpl.fromJSON(value as SerializedThread);
653:         }
654:         if (typed._type === "chat:Channel") {
655:           return ChannelImpl.fromJSON(value as SerializedChannel);
656:         }
657:         if (typed._type === "chat:Message") {
658:           return Message.fromJSON(value as SerializedMessage);
659:         }
660:       }
661:       return value;
662:     };
663:   }
664: 
665:   // ChatInstance interface implementations
666: 
667:   /**
668:    * Process an incoming message from an adapter.
669:    * Handles waitUntil registration and error catching internally.
670:    * Adapters should call this instead of handleIncomingMessage directly.
671:    */
672:   processMessage(
673:     adapter: Adapter,
674:     threadId: string,
675:     messageOrFactory: Message | (() => Promise<Message>),
676:     options?: WebhookOptions
677:   ): void {
678:     const task = (async () => {
679:       const message =
680:         typeof messageOrFactory === "function"
681:           ? await messageOrFactory()
682:           : messageOrFactory;
683:       await this.handleIncomingMessage(adapter, threadId, message);
684:     })().catch((err) => {
685:       this.logger.error("Message processing error", { error: err, threadId });
686:     });
687: 
688:     if (options?.waitUntil) {
689:       options.waitUntil(task);
690:     }
691:   }
692: 
693:   /**
694:    * Process an incoming reaction event from an adapter.
695:    * Handles waitUntil registration and error catching internally.
696:    */
697:   processReaction(
698:     event: Omit<ReactionEvent, "adapter" | "thread"> & { adapter?: Adapter },
699:     options?: WebhookOptions
700:   ): void {
701:     const task = this.handleReactionEvent(event).catch((err) => {
702:       this.logger.error("Reaction processing error", {
703:         error: err,
704:         emoji: event.emoji,
705:         messageId: event.messageId,
706:       });
707:     });
708: 
709:     if (options?.waitUntil) {
710:       options.waitUntil(task);
711:     }
712:   }
713: 
714:   /**
715:    * Process an incoming action event (button click) from an adapter.
716:    * Handles waitUntil registration and error catching internally.
717:    */
718:   processAction(
719:     event: Omit<ActionEvent, "thread" | "openModal"> & { adapter: Adapter },
720:     options?: WebhookOptions
721:   ): void {
722:     const task = this.handleActionEvent(event).catch((err) => {
723:       this.logger.error("Action processing error", {
724:         error: err,
725:         actionId: event.actionId,
726:         messageId: event.messageId,
727:       });
728:     });
729: 
730:     if (options?.waitUntil) {
731:       options.waitUntil(task);
732:     }
733:   }
734: 
735:   async processModalSubmit(
736:     event: Omit<
737:       ModalSubmitEvent,
738:       "relatedThread" | "relatedMessage" | "relatedChannel"
739:     >,
740:     contextId?: string,
741:     _options?: WebhookOptions
742:   ): Promise<ModalResponse | undefined> {
743:     const { relatedThread, relatedMessage, relatedChannel } =
744:       await this.retrieveModalContext(event.adapter.name, contextId);
745: 
746:     const fullEvent: ModalSubmitEvent = {
747:       ...event,
748:       relatedThread,
749:       relatedMessage,
750:       relatedChannel,
751:     };
752: 
753:     for (const { callbackIds, handler } of this.modalSubmitHandlers) {
754:       if (callbackIds.length === 0 || callbackIds.includes(event.callbackId)) {
755:         try {
756:           const response = await handler(fullEvent);
757:           if (response) {
758:             return response;
759:           }
760:         } catch (err) {
761:           this.logger.error("Modal submit handler error", {
762:             error: err,
763:             callbackId: event.callbackId,
764:           });
765:         }
766:       }
767:     }
768:   }
769: 
770:   processModalClose(
771:     event: Omit<
772:       ModalCloseEvent,
773:       "relatedThread" | "relatedMessage" | "relatedChannel"
774:     >,
775:     contextId?: string,
776:     options?: WebhookOptions
777:   ): void {
778:     const task = (async () => {
779:       const { relatedThread, relatedMessage, relatedChannel } =
780:         await this.retrieveModalContext(event.adapter.name, contextId);
781: 
782:       const fullEvent: ModalCloseEvent = {
783:         ...event,
784:         relatedThread,
785:         relatedMessage,
786:         relatedChannel,
787:       };
788: 
789:       for (const { callbackIds, handler } of this.modalCloseHandlers) {
790:         if (
791:           callbackIds.length === 0 ||
792:           callbackIds.includes(event.callbackId)
793:         ) {
794:           await handler(fullEvent);
795:         }
796:       }
797:     })().catch((err) => {
798:       this.logger.error("Modal close handler error", {
799:         error: err,
800:         callbackId: event.callbackId,
801:       });
802:     });
803: 
804:     if (options?.waitUntil) {
805:       options.waitUntil(task);
806:     }
807:   }
808: 
809:   /**
810:    * Process an incoming slash command from an adapter.
811:    * Handles waitUntil registration and error catching internally.
812:    */
813:   processSlashCommand(
814:     event: Omit<SlashCommandEvent, "channel" | "openModal"> & {
815:       adapter: Adapter;
816:       channelId: string;
817:     },
818:     options?: WebhookOptions
819:   ): void {
820:     const task = this.handleSlashCommandEvent(event).catch((err) => {
821:       this.logger.error("Slash command processing error", {
822:         error: err,
823:         command: event.command,
824:         text: event.text,
825:      
...(truncated)
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/thread.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/thread.ts</path>
<type>file</type>
<content>1: import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
2: import type { Root } from "mdast";
3: import { cardToFallbackText } from "./cards";
4: import { ChannelImpl, deriveChannelId } from "./channel";
5: import { getChatSingleton } from "./chat-singleton";
6: import { type CardJSXElement, isJSX, toCardElement } from "./jsx-runtime";
7: import {
8:   paragraph,
9:   parseMarkdown,
10:   root,
11:   text as textNode,
12:   toPlainText,
13: } from "./markdown";
14: import { Message, type SerializedMessage } from "./message";
15: import type {
16:   Adapter,
17:   AdapterPostableMessage,
18:   Attachment,
19:   Author,
20:   Channel,
21:   EphemeralMessage,
22:   PostableMessage,
23:   PostEphemeralOptions,
24:   SentMessage,
25:   StateAdapter,
26:   StreamOptions,
27:   Thread,
28: } from "./types";
29: import { THREAD_STATE_TTL_MS } from "./types";
30: 
31: /**
32:  * Serialized thread data for passing to external systems (e.g., workflow engines).
33:  */
34: export interface SerializedThread {
35:   _type: "chat:Thread";
36:   adapterName: string;
37:   channelId: string;
38:   currentMessage?: SerializedMessage;
39:   id: string;
40:   isDM: boolean;
41: }
42: 
43: /**
44:  * Config for creating a ThreadImpl with explicit adapter/state instances.
45:  */
46: interface ThreadImplConfigWithAdapter {
47:   adapter: Adapter;
48:   channelId: string;
49:   currentMessage?: Message;
50:   fallbackStreamingPlaceholderText?: string | null;
51:   id: string;
52:   initialMessage?: Message;
53:   isDM?: boolean;
54:   isSubscribedContext?: boolean;
55:   stateAdapter: StateAdapter;
56:   streamingUpdateIntervalMs?: number;
57: }
58: 
59: /**
60:  * Config for creating a ThreadImpl with lazy adapter resolution.
61:  * The adapter will be looked up from the Chat singleton on first access.
62:  */
63: interface ThreadImplConfigLazy {
64:   adapterName: string;
65:   channelId: string;
66:   currentMessage?: Message;
67:   fallbackStreamingPlaceholderText?: string | null;
68:   id: string;
69:   initialMessage?: Message;
70:   isDM?: boolean;
71:   isSubscribedContext?: boolean;
72:   streamingUpdateIntervalMs?: number;
73: }
74: 
75: type ThreadImplConfig = ThreadImplConfigWithAdapter | ThreadImplConfigLazy;
76: 
77: function isLazyConfig(
78:   config: ThreadImplConfig
79: ): config is ThreadImplConfigLazy {
80:   return "adapterName" in config && !("adapter" in config);
81: }
82: 
83: /** State key prefix for thread state */
84: const THREAD_STATE_KEY_PREFIX = "thread-state:";
85: 
86: /**
87:  * Check if a value is an AsyncIterable (like AI SDK's textStream).
88:  */
89: function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
90:   return (
91:     value !== null && typeof value === "object" && Symbol.asyncIterator in value
92:   );
93: }
94: 
95: export class ThreadImpl<TState = Record<string, unknown>>
96:   implements Thread<TState>
97: {
98:   readonly id: string;
99:   readonly channelId: string;
100:   readonly isDM: boolean;
101: 
102:   /** Direct adapter instance (if provided) */
103:   private _adapter?: Adapter;
104:   /** Adapter name for lazy resolution */
105:   private readonly _adapterName?: string;
106:   /** Direct state adapter instance (if provided) */
107:   private _stateAdapterInstance?: StateAdapter;
108:   private _recentMessages: Message[] = [];
109:   private readonly _isSubscribedContext: boolean;
110:   /** Current message context for streaming - provides userId/teamId */
111:   private readonly _currentMessage?: Message;
112:   /** Update interval for fallback streaming */
113:   private readonly _streamingUpdateIntervalMs: number;
114:   /** Placeholder text for fallback streaming (post + edit) */
115:   private readonly _fallbackStreamingPlaceholderText: string | null;
116:   /** Cached channel instance */
117:   private _channel?: Channel<TState>;
118: 
119:   constructor(config: ThreadImplConfig) {
120:     this.id = config.id;
121:     this.channelId = config.channelId;
122:     this.isDM = config.isDM ?? false;
123:     this._isSubscribedContext = config.isSubscribedContext ?? false;
124:     this._currentMessage = config.currentMessage;
125:     this._streamingUpdateIntervalMs = config.streamingUpdateIntervalMs ?? 500;
126:     this._fallbackStreamingPlaceholderText =
127:       config.fallbackStreamingPlaceholderText !== undefined
128:         ? config.fallbackStreamingPlaceholderText
129:         : "...";
130: 
131:     if (isLazyConfig(config)) {
132:       // Lazy resolution mode - store adapter name for later lookup
133:       this._adapterName = config.adapterName;
134:     } else {
135:       // Direct mode - store adapter and state instances
136:       this._adapter = config.adapter;
137:       this._stateAdapterInstance = config.stateAdapter;
138:     }
139: 
140:     if (config.initialMessage) {
141:       this._recentMessages = [config.initialMessage];
142:     }
143:   }
144: 
145:   /**
146:    * Get the adapter for this thread.
147:    * If created with lazy config, resolves from Chat singleton on first access.
148:    */
149:   get adapter(): Adapter {
150:     if (this._adapter) {
151:       return this._adapter;
152:     }
153: 
154:     if (!this._adapterName) {
155:       throw new Error("Thread has no adapter configured");
156:     }
157: 
158:     // Lazy resolution from singleton
159:     const chat = getChatSingleton();
160:     const adapter = chat.getAdapter(this._adapterName);
161:     if (!adapter) {
162:       throw new Error(
163:         `Adapter "${this._adapterName}" not found in Chat singleton`
164:       );
165:     }
166: 
167:     // Cache for subsequent accesses
168:     this._adapter = adapter;
169:     return adapter;
170:   }
171: 
172:   /**
173:    * Get the state adapter for this thread.
174:    * If created with lazy config, resolves from Chat singleton on first access.
175:    */
176:   private get _stateAdapter(): StateAdapter {
177:     if (this._stateAdapterInstance) {
178:       return this._stateAdapterInstance;
179:     }
180: 
181:     // Lazy resolution from singleton
182:     const chat = getChatSingleton();
183:     this._stateAdapterInstance = chat.getState();
184:     return this._stateAdapterInstance;
185:   }
186: 
187:   get recentMessages(): Message[] {
188:     return this._recentMessages;
189:   }
190: 
191:   set recentMessages(messages: Message[]) {
192:     this._recentMessages = messages;
193:   }
194: 
195:   /**
196:    * Get the current thread state.
197:    * Returns null if no state has been set.
198:    */
199:   get state(): Promise<TState | null> {
200:     return this._stateAdapter.get<TState>(
201:       `${THREAD_STATE_KEY_PREFIX}${this.id}`
202:     );
203:   }
204: 
205:   /**
206:    * Set the thread state. Merges with existing state by default.
207:    * State is persisted for 30 days.
208:    */
209:   async setState(
210:     newState: Partial<TState>,
211:     options?: { replace?: boolean }
212:   ): Promise<void> {
213:     const key = `${THREAD_STATE_KEY_PREFIX}${this.id}`;
214: 
215:     if (options?.replace) {
216:       // Replace entire state
217:       await this._stateAdapter.set(key, newState, THREAD_STATE_TTL_MS);
218:     } else {
219:       // Merge with existing state
220:       const existing = await this._stateAdapter.get<TState>(key);
221:       const merged = { ...existing, ...newState };
222:       await this._stateAdapter.set(key, merged, THREAD_STATE_TTL_MS);
223:     }
224:   }
225: 
226:   /**
227:    * Get the Channel containing this thread.
228:    * Lazy-created and cached.
229:    */
230:   get channel(): Channel<TState> {
231:     if (!this._channel) {
232:       const channelId = deriveChannelId(this.adapter, this.id);
233:       this._channel = new ChannelImpl<TState>({
234:         id: channelId,
235:         adapter: this.adapter,
236:         stateAdapter: this._stateAdapter,
237:         isDM: this.isDM,
238:       });
239:     }
240:     return this._channel;
241:   }
242: 
243:   /**
244:    * Iterate messages newest first (backward from most recent).
245:    * Auto-paginates lazily.
246:    */
247:   get messages(): AsyncIterable<Message> {
248:     const adapter = this.adapter;
249:     const threadId = this.id;
250: 
251:     return {
252:       async *[Symbol.asyncIterator]() {
253:         let cursor: string | undefined;
254: 
255:         while (true) {
256:           const result = await adapter.fetchMessages(threadId, {
257:             cursor,
258:             direction: "backward",
259:           });
260: 
261:           // Messages within a page are chronological (oldest first),
262:           // but we want newest first, so reverse the page
263:           const reversed = [...result.messages].reverse();
264:           for (const message of reversed) {
265:             yield message;
266:           }
267: 
268:           if (!result.nextCursor || result.messages.length === 0) {
269:             break;
270:           }
271: 
272:           cursor = result.nextCursor;
273:         }
274:       },
275:     };
276:   }
277: 
278:   get allMessages(): AsyncIterable<Message> {
279:     const adapter = this.adapter;
280:     const threadId = this.id;
281: 
282:     return {
283:       async *[Symbol.asyncIterator]() {
284:         let cursor: string | undefined;
285: 
286:         while (true) {
287:           // Use forward direction to iterate from oldest to newest
288:           const result = await adapter.fetchMessages(threadId, {
289:             limit: 100,
290:             cursor,
291:             direction: "forward",
292:           });
293: 
294:           for (const message of result.messages) {
295:             yield message;
296:           }
297: 
298:           // No more pages if no nextCursor or no messages returned
299:           if (!result.nextCursor || result.messages.length === 0) {
300:             break;
301:           }
302: 
303:           cursor = result.nextCursor;
304:         }
305:       },
306:     };
307:   }
308: 
309:   async isSubscribed(): Promise<boolean> {
310:     // Short-circuit if we know we're in a subscribed context
311:     if (this._isSubscribedContext) {
312:       return true;
313:     }
314:     return this._stateAdapter.isSubscribed(this.id);
315:   }
316: 
317:   async subscribe(): Promise<void> {
318:     await this._stateAdapter.subscribe(this.id);
319:     // Allow adapters to set up platform-specific subscriptions
320:     if (this.adapter.onThreadSubscribe) {
321:       await this.adapter.onThreadSubscribe(this.id);
322:     }
323:   }
324: 
325:   async unsubscribe(): Promise<void> {
326:     await this._stateAdapter.unsubscribe(this.id);
327:   }
328: 
329:   async post(
330:     message: string | PostableMessage | CardJSXElement
331:   ): Promise<SentMessage> {
332:     // Handle AsyncIterable (streaming)
333:     if (isAsyncIterable(message)) {
334:       return this.handleStream(message);
335:     }
336: 
337:     // After filtering out streams, we have an AdapterPostableMessage
338:     // Auto-convert JSX elements to CardElement
339:     let postable: string | AdapterPostableMessage = message as
340:       | string
341:       | AdapterPostableMessage;
342:     if (isJSX(message)) {
343:       const card = toCardElement(message);
344:       if (!card) {
345:         throw new Error("Invalid JSX element: must be a Card element");
346:       }
347:       postable = card;
348:     }
349: 
350:     const rawMessage = await this.adapter.postMessage(this.id, postable);
351: 
352:     // Create a SentMessage with edit/delete capabilities
353:     const result = this.createSentMessage(
354:       rawMessage.id,
355:       postable,
356:       rawMessage.threadId
357:     );
358:     return result;
359:   }
360: 
361:   async postEphemeral(
362:     user: string | Author,
363:     message: AdapterPostableMessage | CardJSXElement,
364:     options: PostEphemeralOptions
365:   ): Promise<EphemeralMessage | null> {
366:     const { fallbackToDM } = options;
367:     const userId = typeof user === "string" ? user : user.userId;
368: 
369:     // Convert JSX to card if needed
370:     let postable: AdapterPostableMessage;
371:     if (isJSX(message)) {
372:       const card = toCardElement(message);
373:       if (!card) {
374:         throw new Error("Invalid JSX element: must be a Card element");
375:       }
376:       postable = card;
377:     } else {
378:       // Safe cast: if not JSX, it must be AdapterPostableMessage
379:       postable = message as AdapterPostableMessage;
380:     }
381: 
382:     // Try native ephemeral if adapter supports it
383:     if (this.adapter.postEphemeral) {
384:       return this.adapter.postEphemeral(this.id, userId, postable);
385:     }
386: 
387:     // No native support - either fallback to DM or return null
388:     if (!fallbackToDM) {
389:       return null;
390:     }
391: 
392:     // Fallback: send via DM
393:     if (this.adapter.openDM) {
394:       const dmThreadId = await this.adapter.openDM(userId);
395:       const result = await this.adapter.postMessage(dmThreadId, postable);
396:       return {
397:         id: result.id,
398:         threadId: dmThreadId,
399:         usedFallback: true,
400:         raw: result.raw,
401:       };
402:     }
403: 
404:     // No DM support either - return null
405:     return null;
406:   }
407: 
408:   /**
409:    * Handle streaming from an AsyncIterable.
410:    * Uses adapter's native streaming if available, otherwise falls back to post+edit.
411:    */
412:   private async handleStream(
413:     textStream: AsyncIterable<string>
414:   ): Promise<SentMessage> {
415:     // Build streaming options from current message context
416:     const options: StreamOptions = {};
417:     if (this._currentMessage) {
418:       options.recipientUserId = this._currentMessage.author.userId;
419:       // Extract teamId from raw Slack payload
420:       const raw = this._currentMessage.raw as {
421:         team_id?: string;
422:         team?: string;
423:       };
424:       options.recipientTeamId = raw?.team_id ?? raw?.team;
425:     }
426: 
427:     // Use native streaming if adapter supports it
428:     if (this.adapter.stream) {
429:       // Wrap stream to collect accumulated text while passing through to adapter
430:       let accumulated = "";
431:       const wrappedStream: AsyncIterable<string> = {
432:         [Symbol.asyncIterator]: () => {
433:           const iterator = textStream[Symbol.asyncIterator]();
434:           return {
435:             async next() {
436:               const result = await iterator.next();
437:               if (!result.done) {
438:                 accumulated += result.value;
439:               }
440:               return result;
441:             },
442:           };
443:         },
444:       };
445: 
446:       const raw = await this.adapter.stream(this.id, wrappedStream, options);
447:       return this.createSentMessage(raw.id, accumulated, raw.threadId);
448:     }
449: 
450:     // Fallback: post + edit with throttling
451:     return this.fallbackStream(textStream, options);
452:   }
453: 
454:   async startTyping(status?: string): Promise<void> {
455:     await this.adapter.startTyping(this.id, status);
456:   }
457: 
458:   /**
459:    * Fallback streaming implementation using post + edit.
460:    * Used when adapter doesn't support native streaming.
461:    * Uses recursive setTimeout to send updates every intervalMs (default 500ms).
462:    * Schedules next update only after current edit completes to avoid overwhelming slow services.
463:    */
464:   private async fallbackStream(
465:     textStream: AsyncIterable<string>,
466:     options?: StreamOptions
467:   ): Promise<SentMessage> {
468:     const intervalMs =
469:       options?.updateIntervalMs ?? this._streamingUpdateIntervalMs;
470:     const placeholderText = this._fallbackStreamingPlaceholderText;
471:     let msg: { id: string; threadId: string; raw: unknown } | null =
472:       placeholderText === null
473:         ? null
474:         : await this.adapter.postMessage(this.id, placeholderText);
475:     let threadIdForEdits = this.id;
476:     let accumulated = "";
477:     let lastEditContent = "";
478:     let stopped = false;
479:     let pendingEdit: Promise<void> | null = null;
480:     let timerId: ReturnType<typeof setTimeout> | null = null;
481: 
482:     if (msg) {
483:       threadIdForEdits = msg.threadId || this.id;
484:       lastEditContent = placeholderText ?? "";
485:     }
486: 
487:     const scheduleNextEdit = (): void => {
488:       timerId = setTimeout(() => {
489:         pendingEdit = doEditAndReschedule();
490:       }, intervalMs);
491:     };
492: 
493:     const doEditAndReschedule = async (): Promise<void> => {
494:       if (stopped || !msg) {
495:         return;
496:       }
497: 
498:       if (accumulated !== lastEditContent) {
499:         const content = accumulated;
500:         try {
501:           await this.adapter.editMessage(threadIdForEdits, msg.id, content);
502:           lastEditContent = content;
503:         } catch {
504:           // Ignore errors, continue
505:         }
506:       }
507: 
508:       // Schedule next check after intervalMs (only after edit completes)
509:       if (!stopped) {
510:         scheduleNextEdit();
511:       }
512:     };
513: 
514:     if (msg) {
515:       scheduleNextEdit();
516:     }
517: 
518:     try {
519:       for await (const chunk of textStream) {
520:         accumulated += chunk;
521:         if (!msg) {
522:           msg = await this.adapter.postMessage(this.id, accumulated);
523:           threadIdForEdits = msg.threadId || this.id;
524:           lastEditContent = accumulated;
525:           scheduleNextEdit();
526:         }
527:       }
528:     } finally {
529:       stopped = true;
530:       if (timerId) {
531:         clearTimeout(timerId);
532:         timerId = null;
533:       }
534:     }
535: 
536:     // Wait for any pending edit to complete
537:     if (pendingEdit) {
538:       await pendingEdit;
539:     }
540: 
541:     if (!msg) {
542:       msg = await this.adapter.postMessage(this.id, accumulated);
543:       threadIdForEdits = msg.threadId || this.id;
544:       lastEditContent = accumulated;
545:     }
546: 
547:     if (accumulated !== lastEditContent) {
548:       await this.adapter.editMessage(threadIdForEdits, msg.id, accumulated);
549:     }
550: 
551:     return this.createSentMessage(msg.id, accumulated, threadIdForEdits);
552:   }
553: 
554:   async refresh(): Promise<void> {
555:     const result = await this.adapter.fetchMessages(this.id, { limit: 50 });
556:     this._recentMessages = result.messages;
557:   }
558: 
559:   mentionUser(userId: string): string {
560:     return `<@${userId}>`;
561:   }
562: 
563:   /**
564:    * Serialize the thread to a plain JSON object.
565:    * Use this to pass thread data to external systems like workflow engines.
566:    *
567:    * @example
568:    * ```typescript
569:    * // Pass to a workflow
570:    * await workflow.start("my-workflow", {
571:    *   thread: thread.toJSON(),
572:    *   message: serializeMessage(message),
573:    * });
574:    * ```
575:    */
576:   toJSON(): SerializedThread {
577:     return {
578:       _type: "chat:Thread",
579:       id: this.id,
580:       channelId: this.channelId,
581:       currentMessage: this._currentMessage?.toJSON(),
582:       isDM: this.isDM,
583:       adapterName: this.adapter.name,
584:     };
585:   }
586: 
587:   /**
588:    * Reconstruct a Thread from serialized JSON data.
589:    *
590:    * Reconstructs a ThreadImpl from serialized data.
591:    * Uses lazy resolution from Chat.getSingleton() for adapter and state.
592:    *
593:    * @param json - Serialized thread data
594:    * @requires Call `chat.registerSingleton()` before deserializing threads
595:    *
596:    * @example
597:    * ```typescript
598:    * const thread = ThreadImpl.fromJSON(serializedThread);
599:    * ```
600:    */
601:   static fromJSON<TState = Record<string, unknown>>(
602:     json: SerializedThread,
603:     adapter?: Adapter
604:   ): ThreadImpl<TState> {
605:     const thread = new ThreadImpl<TState>({
606:       id: json.id,
607:       adapterName: json.adapterName,
608:       channelId: json.channelId,
609:       currentMessage: json.currentMessage
610:         ? Message.fromJSON(json.currentMessage)
611:         : undefined,
612:       isDM: json.isDM,
613:     });
614:     if (adapter) {
615:       thread._adapter = adapter;
616:     }
617:     return thread;
618:   }
619: 
620:   /**
621:    * Serialize a ThreadImpl instance for @workflow/serde.
622:    * This static method is automatically called by workflow serialization.
623:    */
624:   static [WORKFLOW_SERIALIZE](instance: ThreadImpl): SerializedThread {
625:     return instance.toJSON();
626:   }
627: 
628:   /**
629:    * Deserialize a ThreadImpl from @workflow/serde.
630:    * Uses lazy adapter resolution from Chat.getSingleton().
631:    * Requires chat.registerSingleton() to have been called.
632:    */
633:   static [WORKFLOW_DESERIALIZE](data: SerializedThread): ThreadImpl {
634:     return ThreadImpl.fromJSON(data);
635:   }
636: 
637:   private createSentMessage(
638:     messageId: string,
639:     postable: AdapterPostableMessage,
640:     threadIdOverride?: string
641:   ): SentMessage {
642:     const adapter = this.adapter;
643:     // Use the threadId returned by postMessage if available (may differ after thread creation)
644:     const threadId = threadIdOverride || this.id;
645:     const self = this;
646: 
647:     // Extract text and AST from the PostableMessage
648:     const { plainText, formatted, attachments } =
649:       extractMessageContent(postable);
650: 
651:     const sentMessage: SentMessage = {
652:       id: messageId,
653:       threadId,
654:       text: plainText,
655:       formatted,
656:       raw: null, // Will be populated if needed
657:       author: {
658:         userId: "self",
659:         userName: adapter.userName,
660:         fullName: adapter.userName,
661:         isBot: true,
662:         isMe: true,
663:       },
664:       metadata: {
665:         dateSent: new Date(),
666:         edited: false,
667:       },
668:       attachments,
669: 
670:       toJSON() {
671:         return new Message(this).toJSON();
672:       },
673: 
674:       async edit(
675:         newContent: string | PostableMessage | CardJSXElement
676:       ): Promise<SentMessage> {
677:         // Auto-convert JSX elements to CardElement
678:         // edit doesn't support streaming, so use AdapterPostableMessage
679:         let postable: string | AdapterPostableMessage = newContent as
680:           | string
681:           | AdapterPostableMessage;
682:         if (isJSX(newContent)) {
683:           const card = toCardElement(newContent);
684:           if (!card) {
685:             throw new Error("Invalid JSX element: must be a Card element");
686:           }
687:           postable = card;
688:         }
689:         await adapter.editMessage(threadId, messageId, postable);
690:         return self.createSentMessage(messageId, postable);
691:       },
692: 
693:       async delete(): Promise<void> {
694:         await adapter.deleteMessage(threadId, messageId);
695:       },
696: 
697:       async addReaction(emoji: string): Promise<void> {
698:         await adapter.addReaction(threadId, messageId, emoji);
699:       },
700: 
701:       async removeReaction(emoji: string): Promise<void> {
702:         await adapter.removeReaction(threadId, messageId, emoji);
703:       },
704:     };
705: 
706:     return sentMessage;
707:   }
708: 
709:   createSentMessageFromMessage(message: Message): SentMessage {
710:     const adapter = this.adapter;
711:     const threadId = this.id;
712:     const messageId = message.id;
713:     const self = this;
714: 
715:     return {
716:       id: message.id,
717:       threadId: message.threadId,
718:       text: message.text,
719:       formatted: message.formatted,
720:       raw: message.raw,
721:       author: message.author,
722:       metadata: message.metadata,
723:       attachments: message.attachments,
724:       isMention: message.isMention,
725: 
726:       toJSON() {
727:         return message.toJSON();
728:       },
729: 
730:       async edit(
731:         newContent: string | PostableMessage | CardJSXElement
732:       ): Promise<SentMessage> {
733:         let postable: string | AdapterPostableMessage = newContent as
734:           | string
735:           | AdapterPostableMessage;
736:         if (isJSX(newContent)) {
737:           const card = toCardElement(newContent);
738:           if (!card) {
739:             throw new Error("Invalid JSX element: must be a Card element");
740:           }
741:           postable = card;
742:         }
743:         await adapter.editMessage(threadId, messageId, postable);
744:         return self.createSentMessage(messageId, postable, threadId);
745:       },
746: 
747:       async delete(): Promise<void> {
748:         await adapter.deleteMessage(threadId, messageId);
749:       },
750: 
751:       async addReaction(emoji: string): Promise<void> {
752:         await adapter.addReaction(threadId, messageId, emoji);
753:       },
754: 
755:       async removeReaction(emoji: string): Promise<void> {
756:         await adapter.removeReaction(threadId, messageId, emoji);
757:       },
758:     };
759:   }
760: }
761: 
762: /**
763:  * Extract plain text, AST, and attachments from a message.
764:  */
765: function extractMessageContent(message: AdapterPostableMessage): {
766:   plainText: string;
767:   formatted: Root;
768:   attachments: Attachment[];
769: } {
770:   if (typeof message === "string") {
771:     // Raw string - create simple AST
772:     return {
773:       plainText: message,
774:       formatted: root([paragraph([textNode(message)])]),
775:       attachments: [],
776:     };
777:   }
778: 
779:   if ("raw" in message) {
780:     // Raw text - create simple AST
781:     return {
782:       plainText: message.raw,
783:       formatted: root([paragraph([textNode(message.raw)])]),
784:       attachments: message.attachments || [],
785:     };
786:   }
787: 
788:   if ("markdown" in message) {
789:     // Markdown - parse to AST
790:     const ast = parseMarkdown(message.markdown);
791:     return {
792:       plainText: toPlainText(ast),
793:       formatted: ast,
794:       attachments: message.attachments || [],
795:     };
796:   }
797: 
798:   if ("ast" in message) {
799:     // AST provided directly
800:     return {
801:       plainText: toPlainText(message.ast),
802:       formatted: message.ast,
803:       attachments: message.attachments || [],
804:     };
805:   }
806: 
807:   if ("card" in message) {
808:     // PostableCard - generate fallback text from card
809:     const fallbackText =
810:       message.fallbackText || cardToFallbackText(message.card);
811:     return {
812:       plainText: fallbackText,
813:       formatted: root([paragraph([textNode(fallbackText)])]),
814:       attachments: [],
815:     };
816:   }
817: 
818:   if ("type" in message && message.type === "card") {
819:     // Direct CardElement
820:     const fallbackText = cardToFallbackText(message);
821:     return {
822:       plainText: fallbackText,
823:       formatted: root([paragraph([textNode(fallbackText)])]),
824:       attachments: [],
825:     };
826:   }
827: 
828:   // Should never reach here with proper typing
829:   throw new Error("Invalid PostableMessage format");
830: }

(End of file - total 830 lines)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/message.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/message.ts</path>
<type>file</type>
<content>1: /**
2:  * Message class with serialization support for workflow engines.
3:  */
4: 
5: import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
6: import type { Root } from "mdast";
7: import type {
8:   Attachment,
9:   Author,
10:   FormattedContent,
11:   MessageMetadata,
12: } from "./types";
13: 
14: /**
15:  * Input data for creating a Message instance.
16:  * Use this interface when constructing Message objects.
17:  */
18: export interface MessageData<TRawMessage = unknown> {
19:   /** Attachments */
20:   attachments: Attachment[];
21:   /** Message author */
22:   author: Author;
23:   /** Structured formatting as an AST (mdast Root) */
24:   formatted: FormattedContent;
25:   /** Unique message ID */
26:   id: string;
27:   /** Whether the bot is @-mentioned in this message */
28:   isMention?: boolean;
29:   /** Message metadata */
30:   metadata: MessageMetadata;
31:   /** Platform-specific raw payload (escape hatch) */
32:   raw: TRawMessage;
33:   /** Plain text content (all formatting stripped) */
34:   text: string;
35:   /** Thread this message belongs to */
36:   threadId: string;
37: }
38: 
39: /**
40:  * Serialized message data for passing to external systems (e.g., workflow engines).
41:  * Dates are converted to ISO strings, and non-serializable fields are omitted.
42:  */
43: export interface SerializedMessage {
44:   _type: "chat:Message";
45:   attachments: Array<{
46:     type: "image" | "file" | "video" | "audio";
47:     url?: string;
48:     name?: string;
49:     mimeType?: string;
50:     size?: number;
51:     width?: number;
52:     height?: number;
53:   }>;
54:   author: {
55:     userId: string;
56:     userName: string;
57:     fullName: string;
58:     isBot: boolean | "unknown";
59:     isMe: boolean;
60:   };
61:   formatted: Root;
62:   id: string;
63:   isMention?: boolean;
64:   metadata: {
65:     dateSent: string; // ISO string
66:     edited: boolean;
67:     editedAt?: string; // ISO string
68:   };
69:   raw: unknown;
70:   text: string;
71:   threadId: string;
72: }
73: 
74: /**
75:  * A chat message with serialization support for workflow engines.
76:  *
77:  * @example
78:  * ```typescript
79:  * // Create a message
80:  * const message = new Message({
81:  *   id: "msg-1",
82:  *   threadId: "slack:C123:1234.5678",
83:  *   text: "Hello world",
84:  *   formatted: parseMarkdown("Hello world"),
85:  *   raw: {},
86:  *   author: { userId: "U123", userName: "user", fullName: "User", isBot: false, isMe: false },
87:  *   metadata: { dateSent: new Date(), edited: false },
88:  *   attachments: [],
89:  * });
90:  *
91:  * // Serialize for workflow
92:  * const serialized = message.toJSON();
93:  * ```
94:  */
95: export class Message<TRawMessage = unknown> {
96:   /** Unique message ID */
97:   readonly id: string;
98:   /** Thread this message belongs to */
99:   readonly threadId: string;
100: 
101:   /** Plain text content (all formatting stripped) */
102:   text: string;
103:   /**
104:    * Structured formatting as an AST (mdast Root).
105:    * This is the canonical representation - use this for processing.
106:    * Use `stringifyMarkdown(message.formatted)` to get markdown string.
107:    */
108:   formatted: FormattedContent;
109:   /** Platform-specific raw payload (escape hatch) */
110:   raw: TRawMessage;
111: 
112:   /** Message author */
113:   author: Author;
114:   /** Message metadata */
115:   metadata: MessageMetadata;
116:   /** Attachments */
117:   attachments: Attachment[];
118: 
119:   /**
120:    * Whether the bot is @-mentioned in this message.
121:    *
122:    * This is set by the Chat SDK before passing the message to handlers.
123:    * It checks for `@username` in the message text using the adapter's
124:    * configured `userName` and optional `botUserId`.
125:    *
126:    * @example
127:    * ```typescript
128:    * chat.onSubscribedMessage(async (thread, message) => {
129:    *   if (message.isMention) {
130:    *     await thread.post("You mentioned me!");
131:    *   }
132:    * });
133:    * ```
134:    */
135:   isMention?: boolean;
136: 
137:   constructor(data: MessageData<TRawMessage>) {
138:     this.id = data.id;
139:     this.threadId = data.threadId;
140:     this.text = data.text;
141:     this.formatted = data.formatted;
142:     this.raw = data.raw;
143:     this.author = data.author;
144:     this.metadata = data.metadata;
145:     this.attachments = data.attachments;
146:     this.isMention = data.isMention;
147:   }
148: 
149:   /**
150:    * Serialize the message to a plain JSON object.
151:    * Use this to pass message data to external systems like workflow engines.
152:    *
153:    * Note: Attachment `data` (Buffer) and `fetchData` (function) are omitted
154:    * as they're not serializable.
155:    */
156:   toJSON(): SerializedMessage {
157:     return {
158:       _type: "chat:Message",
159:       id: this.id,
160:       threadId: this.threadId,
161:       text: this.text,
162:       formatted: this.formatted,
163:       raw: this.raw,
164:       author: {
165:         userId: this.author.userId,
166:         userName: this.author.userName,
167:         fullName: this.author.fullName,
168:         isBot: this.author.isBot,
169:         isMe: this.author.isMe,
170:       },
171:       metadata: {
172:         dateSent: this.metadata.dateSent.toISOString(),
173:         edited: this.metadata.edited,
174:         editedAt: this.metadata.editedAt?.toISOString(),
175:       },
176:       attachments: this.attachments.map((att) => ({
177:         type: att.type,
178:         url: att.url,
179:         name: att.name,
180:         mimeType: att.mimeType,
181:         size: att.size,
182:         width: att.width,
183:         height: att.height,
184:       })),
185:       isMention: this.isMention,
186:     };
187:   }
188: 
189:   /**
190:    * Reconstruct a Message from serialized JSON data.
191:    * Converts ISO date strings back to Date objects.
192:    */
193:   static fromJSON<TRawMessage = unknown>(
194:     json: SerializedMessage
195:   ): Message<TRawMessage> {
196:     return new Message<TRawMessage>({
197:       id: json.id,
198:       threadId: json.threadId,
199:       text: json.text,
200:       formatted: json.formatted,
201:       raw: json.raw as TRawMessage,
202:       author: json.author,
203:       metadata: {
204:         dateSent: new Date(json.metadata.dateSent),
205:         edited: json.metadata.edited,
206:         editedAt: json.metadata.editedAt
207:           ? new Date(json.metadata.editedAt)
208:           : undefined,
209:       },
210:       attachments: json.attachments,
211:       isMention: json.isMention,
212:     });
213:   }
214: 
215:   /**
216:    * Serialize a Message instance for @workflow/serde.
217:    * This static method is automatically called by workflow serialization.
218:    */
219:   static [WORKFLOW_SERIALIZE](instance: Message): SerializedMessage {
220:     return instance.toJSON();
221:   }
222: 
223:   /**
224:    * Deserialize a Message from @workflow/serde.
225:    * This static method is automatically called by workflow deserialization.
226:    */
227:   static [WORKFLOW_DESERIALIZE](data: SerializedMessage): Message {
228:     return Message.fromJSON(data);
229:   }
230: }

(End of file - total 230 lines)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/cards.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/cards.ts</path>
<type>file</type>
<content>1: /**
2:  * Card elements for cross-platform rich messaging.
3:  *
4:  * Provides a builder API for creating rich cards that automatically
5:  * convert to platform-specific formats:
6:  * - Slack: Block Kit
7:  * - Teams: Adaptive Cards
8:  * - Google Chat: Card v2
9:  *
10:  * Supports both function-call and JSX syntax:
11:  *
12:  * @example Function API
13:  * ```ts
14:  * import { Card, Text, Actions, Button } from "chat";
15:  *
16:  * await thread.post(
17:  *   Card({
18:  *     title: "Order #1234",
19:  *     children: [
20:  *       Text("Total: $50.00"),
21:  *       Actions([
22:  *         Button({ id: "approve", label: "Approve", style: "primary" }),
23:  *         Button({ id: "reject", label: "Reject", style: "danger" }),
24:  *       ]),
25:  *     ],
26:  *   })
27:  * );
28:  * ```
29:  *
30:  * @example JSX API (requires jsxImportSource: "chat" in tsconfig)
31:  * ```tsx
32:  * /** @jsxImportSource chat *\/
33:  * import { Card, Text, Actions, Button } from "chat";
34:  *
35:  * await thread.post(
36:  *   <Card title="Order #1234">
37:  *     <Text>Total: $50.00</Text>
38:  *     <Actions>
39:  *       <Button id="approve" style="primary">Approve</Button>
40:  *       <Button id="reject" style="danger">Reject</Button>
41:  *     </Actions>
42:  *   </Card>
43:  * );
44:  * ```
45:  */
46: 
47: import type { RadioSelectElement, SelectElement } from "./modals";
48: 
49: // ============================================================================
50: // Card Element Types
51: // ============================================================================
52: 
53: /** Button style options */
54: export type ButtonStyle = "primary" | "danger" | "default";
55: 
56: /** Text style options */
57: export type TextStyle = "plain" | "bold" | "muted";
58: 
59: /** Button element for interactive actions */
60: export interface ButtonElement {
61:   /** Unique action ID for callback routing */
62:   id: string;
63:   /** Button label text */
64:   label: string;
65:   /** Visual style */
66:   style?: ButtonStyle;
67:   type: "button";
68:   /** Optional payload value sent with action callback */
69:   value?: string;
70: }
71: 
72: /** Link button element that opens a URL */
73: export interface LinkButtonElement {
74:   /** Button label text */
75:   label: string;
76:   /** Visual style */
77:   style?: ButtonStyle;
78:   type: "link-button";
79:   /** URL to open when clicked */
80:   url: string;
81: }
82: 
83: /** Text content element */
84: export interface TextElement {
85:   /** Text content (supports markdown in some platforms) */
86:   content: string;
87:   /** Text style */
88:   style?: TextStyle;
89:   type: "text";
90: }
91: 
92: /** Image element */
93: export interface ImageElement {
94:   /** Alt text for accessibility */
95:   alt?: string;
96:   type: "image";
97:   /** Image URL */
98:   url: string;
99: }
100: 
101: /** Visual divider/separator */
102: export interface DividerElement {
103:   type: "divider";
104: }
105: 
106: /** Container for action buttons and selects */
107: export interface ActionsElement {
108:   /** Button, link button, select, and radio select elements */
109:   children: (
110:     | ButtonElement
111:     | LinkButtonElement
112:     | SelectElement
113:     | RadioSelectElement
114:   )[];
115:   type: "actions";
116: }
117: 
118: /** Section container for grouping elements */
119: export interface SectionElement {
120:   /** Section children */
121:   children: CardChild[];
122:   type: "section";
123: }
124: 
125: /** Inline hyperlink element */
126: export interface LinkElement {
127:   /** Link label text */
128:   label: string;
129:   type: "link";
130:   /** URL to link to */
131:   url: string;
132: }
133: 
134: /** Field for key-value display */
135: export interface FieldElement {
136:   /** Field label */
137:   label: string;
138:   type: "field";
139:   /** Field value */
140:   value: string;
141: }
142: 
143: /** Fields container for multi-column layout */
144: export interface FieldsElement {
145:   /** Field elements */
146:   children: FieldElement[];
147:   type: "fields";
148: }
149: 
150: /** Union of all card child element types */
151: export type CardChild =
152:   | TextElement
153:   | ImageElement
154:   | DividerElement
155:   | ActionsElement
156:   | SectionElement
157:   | FieldsElement
158:   | LinkElement;
159: 
160: /** Union of all element types (including nested children) */
161: type AnyCardElement =
162:   | CardChild
163:   | CardElement
164:   | ButtonElement
165:   | LinkButtonElement
166:   | LinkElement
167:   | FieldElement
168:   | SelectElement
169:   | RadioSelectElement;
170: 
171: /** Root card element */
172: export interface CardElement {
173:   /** Card content */
174:   children: CardChild[];
175:   /** Header image URL */
176:   imageUrl?: string;
177:   /** Card subtitle */
178:   subtitle?: string;
179:   /** Card title */
180:   title?: string;
181:   type: "card";
182: }
183: 
184: /** Type guard for CardElement */
185: export function isCardElement(value: unknown): value is CardElement {
186:   return (
187:     typeof value === "object" &&
188:     value !== null &&
189:     "type" in value &&
190:     (value as CardElement).type === "card"
191:   );
192: }
193: 
194: // ============================================================================
195: // Builder Functions
196: // ============================================================================
197: 
198: /** Options for Card */
199: export interface CardOptions {
200:   children?: CardChild[];
201:   imageUrl?: string;
202:   subtitle?: string;
203:   title?: string;
204: }
205: 
206: /**
207:  * Create a Card element.
208:  *
209:  * @example
210:  * ```ts
211:  * Card({
212:  *   title: "Welcome",
213:  *   children: [Text("Hello!")],
214:  * })
215:  * ```
216:  */
217: export function Card(options: CardOptions = {}): CardElement {
218:   return {
219:     type: "card",
220:     title: options.title,
221:     subtitle: options.subtitle,
222:     imageUrl: options.imageUrl,
223:     children: options.children ?? [],
224:   };
225: }
226: 
227: /**
228:  * Create a Text element.
229:  *
230:  * @example
231:  * ```ts
232:  * Text("Hello, world!")
233:  * Text("Important", { style: "bold" })
234:  * ```
235:  */
236: export function Text(
237:   content: string,
238:   options: { style?: TextStyle } = {}
239: ): TextElement {
240:   return {
241:     type: "text",
242:     content,
243:     style: options.style,
244:   };
245: }
246: 
247: /**
248:  * Alias for Text that avoids conflicts with DOM's global Text constructor.
249:  * Use this when importing in environments where `Text` would conflict.
250:  *
251:  * @example
252:  * ```ts
253:  * import { CardText } from "chat";
254:  * CardText("Hello, world!")
255:  * ```
256:  */
257: export const CardText = Text;
258: 
259: /**
260:  * Create an Image element.
261:  *
262:  * @example
263:  * ```ts
264:  * Image({ url: "https://example.com/image.png", alt: "Description" })
265:  * ```
266:  */
267: export function Image(options: { url: string; alt?: string }): ImageElement {
268:   return {
269:     type: "image",
270:     url: options.url,
271:     alt: options.alt,
272:   };
273: }
274: 
275: /**
276:  * Create a Divider element.
277:  *
278:  * @example
279:  * ```ts
280:  * Divider()
281:  * ```
282:  */
283: export function Divider(): DividerElement {
284:   return { type: "divider" };
285: }
286: 
287: /**
288:  * Create a Section container.
289:  *
290:  * @example
291:  * ```ts
292:  * Section([
293:  *   Text("Grouped content"),
294:  *   Image({ url: "..." }),
295:  * ])
296:  * ```
297:  */
298: export function Section(children: CardChild[]): SectionElement {
299:   return {
300:     type: "section",
301:     children,
302:   };
303: }
304: 
305: /**
306:  * Create an Actions container for buttons and selects.
307:  *
308:  * @example
309:  * ```ts
310:  * Actions([
311:  *   Button({ id: "ok", label: "OK" }),
312:  *   Button({ id: "cancel", label: "Cancel" }),
313:  *   LinkButton({ url: "https://example.com", label: "Learn More" }),
314:  *   Select({ id: "priority", label: "Priority", options: [...] }),
315:  *   RadioSelect({ id: "status", label: "Status", options: [...] }),
316:  * ])
317:  * ```
318:  */
319: export function Actions(
320:   children: (
321:     | ButtonElement
322:     | LinkButtonElement
323:     | SelectElement
324:     | RadioSelectElement
325:   )[]
326: ): ActionsElement {
327:   return {
328:     type: "actions",
329:     children,
330:   };
331: }
332: 
333: /** Options for Button */
334: export interface ButtonOptions {
335:   /** Unique action ID for callback routing */
336:   id: string;
337:   /** Button label text */
338:   label: string;
339:   /** Visual style */
340:   style?: ButtonStyle;
341:   /** Optional payload value sent with action callback */
342:   value?: string;
343: }
344: 
345: /**
346:  * Create a Button element.
347:  *
348:  * @example
349:  * ```ts
350:  * Button({ id: "submit", label: "Submit", style: "primary" })
351:  * Button({ id: "delete", label: "Delete", style: "danger", value: "item-123" })
352:  * ```
353:  */
354: export function Button(options: ButtonOptions): ButtonElement {
355:   return {
356:     type: "button",
357:     id: options.id,
358:     label: options.label,
359:     style: options.style,
360:     value: options.value,
361:   };
362: }
363: 
364: /** Options for LinkButton */
365: export interface LinkButtonOptions {
366:   /** Button label text */
367:   label: string;
368:   /** Visual style */
369:   style?: ButtonStyle;
370:   /** URL to open when clicked */
371:   url: string;
372: }
373: 
374: /**
375:  * Create a LinkButton element that opens a URL when clicked.
376:  *
377:  * @example
378:  * ```ts
379:  * LinkButton({ url: "https://example.com", label: "View Docs" })
380:  * LinkButton({ url: "https://example.com", label: "Learn More", style: "primary" })
381:  * ```
382:  */
383: export function LinkButton(options: LinkButtonOptions): LinkButtonElement {
384:   return {
385:     type: "link-button",
386:     url: options.url,
387:     label: options.label,
388:     style: options.style,
389:   };
390: }
391: 
392: /**
393:  * Create a Field element for key-value display.
394:  *
395:  * @example
396:  * ```ts
397:  * Field({ label: "Status", value: "Active" })
398:  * ```
399:  */
400: export function Field(options: { label: string; value: string }): FieldElement {
401:   return {
402:     type: "field",
403:     label: options.label,
404:     value: options.value,
405:   };
406: }
407: 
408: /**
409:  * Create a Fields container for multi-column layout.
410:  *
411:  * @example
412:  * ```ts
413:  * Fields([
414:  *   Field({ label: "Name", value: "John" }),
415:  *   Field({ label: "Email", value: "john@example.com" }),
416:  * ])
417:  * ```
418:  */
419: export function Fields(children: FieldElement[]): FieldsElement {
420:   return {
421:     type: "fields",
422:     children,
423:   };
424: }
425: 
426: /**
427:  * Create a CardLink element for inline hyperlinks.
428:  *
429:  * @example
430:  * ```ts
431:  * CardLink({ url: "https://example.com", label: "Visit Site" })
432:  * ```
433:  */
434: export function CardLink(options: { url: string; label: string }): LinkElement {
435:   return {
436:     type: "link",
437:     url: options.url,
438:     label: options.label,
439:   };
440: }
441: 
442: // ============================================================================
443: // React Element Support
444: // ============================================================================
445: 
446: /** React element shape (minimal typing to avoid React dependency) */
447: interface ReactElement {
448:   $$typeof: symbol;
449:   props: Record<string, unknown>;
450:   type: unknown;
451: }
452: 
453: /**
454:  * Check if a value is a React element.
455:  */
456: function isReactElement(value: unknown): value is ReactElement {
457:   if (typeof value !== "object" || value === null) {
458:     return false;
459:   }
460:   const maybeElement = value as { $$typeof?: unknown };
461:   if (typeof maybeElement.$$typeof !== "symbol") {
462:     return false;
463:   }
464:   const symbolStr = maybeElement.$$typeof.toString();
465:   return (
466:     symbolStr.includes("react.element") ||
467:     symbolStr.includes("react.transitional.element")
468:   );
469: }
470: 
471: /**
472:  * Map of component functions to their names for React element conversion.
473:  */
474: const componentMap = new Map<unknown, string>([
475:   [Card, "Card"],
476:   [Text, "Text"],
477:   [Image, "Image"],
478:   [Divider, "Divider"],
479:   [Section, "Section"],
480:   [Actions, "Actions"],
481:   [Button, "Button"],
482:   [LinkButton, "LinkButton"],
483:   [CardLink, "CardLink"],
484:   [Field, "Field"],
485:   [Fields, "Fields"],
486: ]);
487: 
488: /**
489:  * Convert a React element tree to a CardElement tree.
490:  * This allows using React's JSX with our card components.
491:  *
492:  * @example
493:  * ```tsx
494:  * import React from "react";
495:  * import { Card, Text, fromReactElement } from "chat";
496:  *
497:  * const element = (
498:  *   <Card title="Hello">
499:  *     <Text>World</Text>
500:  *   </Card>
501:  * );
502:  *
503:  * const card = fromReactElement(element);
504:  * await thread.post(card);
505:  * ```
506:  */
507: export function fromReactElement(element: unknown): AnyCardElement | null {
508:   if (!isReactElement(element)) {
509:     // Already a card element or primitive
510:     if (isCardElement(element)) {
511:       return element;
512:     }
513:     if (typeof element === "object" && element !== null && "type" in element) {
514:       return element as CardChild;
515:     }
516:     return null;
517:   }
518: 
519:   const { type, props } = element;
520:   const componentName = componentMap.get(type);
521: 
522:   if (!componentName) {
523:     // Check if it's an HTML element (string type like "div", "a", "span")
524:     if (typeof type === "string") {
525:       throw new Error(
526:         `HTML element <${type}> is not supported in card elements. ` +
527:           "Use Card, Text, Section, Actions, Button, Fields, Field, Image, or Divider components instead."
528:       );
529:     }
530: 
531:     // Unknown custom component - try to extract children
532:     if (props.children) {
533:       return convertChildren(props.children)[0] ?? null;
534:     }
535:     return null;
536:   }
537: 
538:   // Convert children recursively
539:   const convertedChildren = props.children
540:     ? convertChildren(props.children)
541:     : [];
542: 
543:   // Helper to filter for CardChild elements
544:   const isCardChild = (el: AnyCardElement): el is CardChild =>
545:     el.type !== "card" &&
546:     el.type !== "button" &&
547:     el.type !== "link-button" &&
548:     el.type !== "field" &&
549:     el.type !== "select" &&
550:     el.type !== "radio_select";
551: 
552:   // Call the appropriate builder function based on component type
553:   switch (componentName) {
554:     case "Card":
555:       return Card({
556:         title: props.title as string | undefined,
557:         subtitle: props.subtitle as string | undefined,
558:         imageUrl: props.imageUrl as string | undefined,
559:         children: convertedChildren.filter(isCardChild),
560:       });
561: 
562:     case "Text": {
563:       // JSX: <Text style="bold">content</Text>
564:       const content = extractTextContent(props.children);
565:       return Text(content, { style: props.style as TextStyle | undefined });
566:     }
567: 
568:     case "Image":
569:       return Image({
570:         url: props.url as string,
571:         alt: props.alt as string | undefined,
572:       });
573: 
574:     case "Divider":
575:       return Divider();
576: 
577:     case "Section":
578:       return Section(convertedChildren.filter(isCardChild));
579: 
580:     case "Actions":
581:       return Actions(
582:         convertedChildren.filter(
583:           (
584:             c
585:           ): c is
586:             | ButtonElement
587:             | LinkButtonElement
588:             | SelectElement
589:             | RadioSelectElement =>
590:             c.type === "button" ||
591:             c.type === "link-button" ||
592:             c.type === "select" ||
593:             c.type === "radio_select"
594:         )
595:       );
596: 
597:     case "Button": {
598:       // JSX: <Button id="x" style="primary">Label</Button>
599:       const label = extractTextContent(props.children);
600:       return Button({
601:         id: props.id as string,
602:         label: (props.label as string | undefined) ?? label,
603:         style: props.style as ButtonStyle | undefined,
604:         value: props.value as string | undefined,
605:       });
606:     }
607: 
608:     case "LinkButton": {
609:       // JSX: <LinkButton url="https://..." style="primary">Label</LinkButton>
610:       const label = extractTextContent(props.children);
611:       return LinkButton({
612:         url: props.url as string,
613:         label: (props.label as string | undefined) ?? label,
614:         style: props.style as ButtonStyle | undefined,
615:       });
616:     }
617: 
618:     case "CardLink": {
619:       const label = extractTextContent(props.children);
620:       return CardLink({
621:         url: props.url as string,
622:         label: (props.label as string | undefined) ?? label,
623:       });
624:     }
625: 
626:     case "Field":
627:       return Field({
628:         label: props.label as string,
629:         value: props.value as string,
630:       });
631: 
632:     case "Fields":
633:       return Fields(
634:         convertedChildren.filter((c): c is FieldElement => c.type === "field")
635:       );
636: 
637:     default:
638:       return null;
639:   }
640: }
641: 
642: /**
643:  * Convert React children to card elements.
644:  */
645: function convertChildren(children: unknown): AnyCardElement[] {
646:   if (children == null) {
647:     return [];
648:   }
649: 
650:   if (Array.isArray(children)) {
651:     return children.flatMap(convertChildren);
652:   }
653: 
654:   const converted = fromReactElement(children);
655:   if (converted && typeof converted === "object" && "type" in converted) {
656:     // If it's a card, extract its children
657:     if (converted.type === "card") {
658:       return (converted as CardElement).children;
659:     }
660:     return [converted];
661:   }
662: 
663:   return [];
664: }
665: 
666: /**
667:  * Extract text content from React children.
668:  */
669: function extractTextContent(children: unknown): string {
670:   if (typeof children === "string") {
671:     return children;
672:   }
673:   if (typeof children === "number") {
674:     return String(children);
675:   }
676:   if (Array.isArray(children)) {
677:     return children.map(extractTextContent).join("");
678:   }
679:   return "";
680: }
681: 
682: // ============================================================================
683: // Fallback Text Generation
684: // ============================================================================
685: 
686: /**
687:  * Generate plain text fallback from a CardElement.
688:  * Used for platforms/clients that can't render rich cards,
689:  * and for the SentMessage.text property.
690:  */
691: export function cardToFallbackText(card: CardElement): string {
692:   const parts: string[] = [];
693: 
694:   if (card.title) {
695:     parts.push(card.title);
696:   }
697: 
698:   if (card.subtitle) {
699:     parts.push(card.subtitle);
700:   }
701: 
702:   for (const child of card.children) {
703:     const text = childToFallbackText(child);
704:     if (text) {
705:       parts.push(text);
706:     }
707:   }
708: 
709:   return parts.join("\n");
710: }
711: 
712: /**
713:  * Generate fallback text from a card child element.
714:  */
715: function childToFallbackText(child: CardChild): string | null {
716:   switch (child.type) {
717:     case "text":
718:       return child.content;
719:     case "link":
720:       return `${child.label} (${child.url})`;
721:     case "fields":
722:       return child.children.map((f) => `${f.label}: ${f.value}`).join("\n");
723:     case "actions":
724:       // Actions are interactive-only — exclude from fallback text.
725:       // See: https://docs.slack.dev/reference/methods/chat.postMessage
726:       return null;
727:     case "section":
728:       return child.children
729:         .map((c) => childToFallbackText(c))
730:         .filter(Boolean)
731:         .join("\n");
732:     default:
733:       return null;
734:   }
735: }

(End of file - total 735 lines)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/modals.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/src/modals.ts</path>
<type>file</type>
<content>1: /**
2:  * Modal elements for form dialogs.
3:  */
4: 
5: import type { FieldsElement, TextElement } from "./cards";
6: 
7: // ============================================================================
8: // Modal Element Types
9: // ============================================================================
10: 
11: export const VALID_MODAL_CHILD_TYPES = [
12:   "text_input",
13:   "select",
14:   "radio_select",
15:   "text",
16:   "fields",
17: ] as const;
18: 
19: export type ModalChild =
20:   | TextInputElement
21:   | SelectElement
22:   | RadioSelectElement
23:   | TextElement
24:   | FieldsElement;
25: 
26: export interface ModalElement {
27:   callbackId: string;
28:   children: ModalChild[];
29:   closeLabel?: string;
30:   notifyOnClose?: boolean;
31:   /** Arbitrary string passed through the modal lifecycle (e.g., JSON context). */
32:   privateMetadata?: string;
33:   submitLabel?: string;
34:   title: string;
35:   type: "modal";
36: }
37: 
38: export interface TextInputElement {
39:   id: string;
40:   initialValue?: string;
41:   label: string;
42:   maxLength?: number;
43:   multiline?: boolean;
44:   optional?: boolean;
45:   placeholder?: string;
46:   type: "text_input";
47: }
48: 
49: export interface SelectElement {
50:   id: string;
51:   initialOption?: string;
52:   label: string;
53:   optional?: boolean;
54:   options: SelectOptionElement[];
55:   placeholder?: string;
56:   type: "select";
57: }
58: 
59: export interface SelectOptionElement {
60:   description?: string;
61:   label: string;
62:   value: string;
63: }
64: 
65: export interface RadioSelectElement {
66:   id: string;
67:   initialOption?: string;
68:   label: string;
69:   optional?: boolean;
70:   options: SelectOptionElement[];
71:   type: "radio_select";
72: }
73: 
74: export function isModalElement(value: unknown): value is ModalElement {
75:   return (
76:     typeof value === "object" &&
77:     value !== null &&
78:     "type" in value &&
79:     (value as ModalElement).type === "modal"
80:   );
81: }
82: 
83: export function filterModalChildren(children: unknown[]): ModalChild[] {
84:   const validChildren = children.filter(
85:     (c): c is ModalChild =>
86:       typeof c === "object" &&
87:       c !== null &&
88:       "type" in c &&
89:       VALID_MODAL_CHILD_TYPES.includes(
90:         (c as { type: string }).type as (typeof VALID_MODAL_CHILD_TYPES)[number]
91:       )
92:   );
93:   if (validChildren.length < children.length) {
94:     console.warn(
95:       "[chat] Modal contains unsupported child elements that were ignored"
96:     );
97:   }
98:   return validChildren;
99: }
100: 
101: // ============================================================================
102: // Builder Functions
103: // ============================================================================
104: 
105: export interface ModalOptions {
106:   callbackId: string;
107:   children?: ModalChild[];
108:   closeLabel?: string;
109:   notifyOnClose?: boolean;
110:   /** Arbitrary string passed through the modal lifecycle (e.g., JSON context). */
111:   privateMetadata?: string;
112:   submitLabel?: string;
113:   title: string;
114: }
115: 
116: export function Modal(options: ModalOptions): ModalElement {
117:   return {
118:     type: "modal",
119:     callbackId: options.callbackId,
120:     title: options.title,
121:     submitLabel: options.submitLabel,
122:     closeLabel: options.closeLabel,
123:     notifyOnClose: options.notifyOnClose,
124:     privateMetadata: options.privateMetadata,
125:     children: options.children ?? [],
126:   };
127: }
128: 
129: export interface TextInputOptions {
130:   id: string;
131:   initialValue?: string;
132:   label: string;
133:   maxLength?: number;
134:   multiline?: boolean;
135:   optional?: boolean;
136:   placeholder?: string;
137: }
138: 
139: export function TextInput(options: TextInputOptions): TextInputElement {
140:   return {
141:     type: "text_input",
142:     id: options.id,
143:     label: options.label,
144:     placeholder: options.placeholder,
145:     initialValue: options.initialValue,
146:     multiline: options.multiline,
147:     optional: options.optional,
148:     maxLength: options.maxLength,
149:   };
150: }
151: 
152: export interface SelectOptions {
153:   id: string;
154:   initialOption?: string;
155:   label: string;
156:   optional?: boolean;
157:   options: SelectOptionElement[];
158:   placeholder?: string;
159: }
160: 
161: export function Select(options: SelectOptions): SelectElement {
162:   if (!options.options || options.options.length === 0) {
163:     throw new Error("Select requires at least one option");
164:   }
165:   return {
166:     type: "select",
167:     id: options.id,
168:     label: options.label,
169:     placeholder: options.placeholder,
170:     options: options.options,
171:     initialOption: options.initialOption,
172:     optional: options.optional,
173:   };
174: }
175: 
176: export function SelectOption(options: {
177:   label: string;
178:   value: string;
179:   description?: string;
180: }): SelectOptionElement {
181:   return {
182:     label: options.label,
183:     value: options.value,
184:     description: options.description,
185:   };
186: }
187: 
188: export interface RadioSelectOptions {
189:   id: string;
190:   initialOption?: string;
191:   label: string;
192:   optional?: boolean;
193:   options: SelectOptionElement[];
194: }
195: 
196: export function RadioSelect(options: RadioSelectOptions): RadioSelectElement {
197:   if (!options.options || options.options.length === 0) {
198:     throw new Error("RadioSelect requires at least one option");
199:   }
200:   return {
201:     type: "radio_select",
202:     id: options.id,
203:     label: options.label,
204:     options: options.options,
205:     initialOption: options.initialOption,
206:     optional: options.optional,
207:   };
208: }
209: 
210: // ============================================================================
211: // JSX Support
212: // ============================================================================
213: 
214: interface ReactElement {
215:   $$typeof: symbol;
216:   props: Record<string, unknown>;
217:   type: unknown;
218: }
219: 
220: function isReactElement(value: unknown): value is ReactElement {
221:   if (typeof value !== "object" || value === null) {
222:     return false;
223:   }
224:   const maybeElement = value as { $$typeof?: unknown };
225:   if (typeof maybeElement.$$typeof !== "symbol") {
226:     return false;
227:   }
228:   const symbolStr = maybeElement.$$typeof.toString();
229:   return (
230:     symbolStr.includes("react.element") ||
231:     symbolStr.includes("react.transitional.element")
232:   );
233: }
234: 
235: type AnyModalElement = ModalElement | ModalChild | SelectOptionElement;
236: 
237: const modalComponentMap = new Map<unknown, string>([
238:   [Modal, "Modal"],
239:   [TextInput, "TextInput"],
240:   [Select, "Select"],
241:   [RadioSelect, "RadioSelect"],
242:   [SelectOption, "SelectOption"],
243: ]);
244: 
245: export function fromReactModalElement(
246:   element: unknown
247: ): AnyModalElement | null {
248:   if (!isReactElement(element)) {
249:     if (isModalElement(element)) {
250:       return element;
251:     }
252:     if (typeof element === "object" && element !== null && "type" in element) {
253:       return element as ModalChild;
254:     }
255:     return null;
256:   }
257: 
258:   const { type, props } = element;
259:   const componentName = modalComponentMap.get(type);
260: 
261:   if (!componentName) {
262:     if (props.children) {
263:       return convertModalChildren(props.children)[0] ?? null;
264:     }
265:     return null;
266:   }
267: 
268:   const convertedChildren = props.children
269:     ? convertModalChildren(props.children)
270:     : [];
271: 
272:   switch (componentName) {
273:     case "Modal":
274:       return Modal({
275:         callbackId: props.callbackId as string,
276:         title: props.title as string,
277:         submitLabel: props.submitLabel as string | undefined,
278:         closeLabel: props.closeLabel as string | undefined,
279:         notifyOnClose: props.notifyOnClose as boolean | undefined,
280:         privateMetadata: props.privateMetadata as string | undefined,
281:         children: filterModalChildren(convertedChildren),
282:       });
283: 
284:     case "TextInput":
285:       return TextInput({
286:         id: props.id as string,
287:         label: props.label as string,
288:         placeholder: props.placeholder as string | undefined,
289:         initialValue: props.initialValue as string | undefined,
290:         multiline: props.multiline as boolean | undefined,
291:         optional: props.optional as boolean | undefined,
292:         maxLength: props.maxLength as number | undefined,
293:       });
294: 
295:     case "Select":
296:       return Select({
297:         id: props.id as string,
298:         label: props.label as string,
299:         placeholder: props.placeholder as string | undefined,
300:         options: convertedChildren.filter(
301:           (c): c is SelectOptionElement =>
302:             c !== null && "label" in c && "value" in c && !("type" in c)
303:         ),
304:         initialOption: props.initialOption as string | undefined,
305:         optional: props.optional as boolean | undefined,
306:       });
307: 
308:     case "RadioSelect":
309:       return RadioSelect({
310:         id: props.id as string,
311:         label: props.label as string,
312:         options: convertedChildren.filter(
313:           (c): c is SelectOptionElement =>
314:             c !== null && "label" in c && "value" in c && !("type" in c)
315:         ),
316:         initialOption: props.initialOption as string | undefined,
317:         optional: props.optional as boolean | undefined,
318:       });
319: 
320:     case "SelectOption":
321:       return SelectOption({
322:         label: props.label as string,
323:         value: props.value as string,
324:         description: props.description as string | undefined,
325:       });
326: 
327:     default:
328:       return null;
329:   }
330: }
331: 
332: function convertModalChildren(children: unknown): AnyModalElement[] {
333:   if (children == null) {
334:     return [];
335:   }
336: 
337:   if (Array.isArray(children)) {
338:     return children.flatMap(convertModalChildren);
339:   }
340: 
341:   const converted = fromReactModalElement(children);
342:   if (converted) {
343:     if (isModalElement(converted)) {
344:       return converted.children;
345:     }
346:     return [converted];
347:   }
348: 
349:   return [];
350: }

(End of file - total 350 lines)
</content>
```


*Completed in 6.1s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Now let me read the Discord and Slack adapter implementations:

> ⚠️ **Large tool output** (61,150 chars, truncated to 30,000)

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/index.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/index.ts</path>
<type>file</type>
<content>1: /**
2:  * Discord adapter for chat-sdk.
3:  *
4:  * Uses Discord's HTTP Interactions API (not Gateway WebSocket) for
5:  * serverless compatibility. Webhook signature verification uses Ed25519.
6:  */
7: 
8: import {
9:   extractCard,
10:   extractFiles,
11:   NetworkError,
12:   toBuffer,
13:   ValidationError,
14: } from "@chat-adapter/shared";
15: import type {
16:   ActionEvent,
17:   Adapter,
18:   AdapterPostableMessage,
19:   ChannelInfo,
20:   ChatInstance,
21:   EmojiValue,
22:   FetchOptions,
23:   FetchResult,
24:   FormattedContent,
25:   ListThreadsOptions,
26:   ListThreadsResult,
27:   Logger,
28:   RawMessage,
29:   ThreadInfo,
30:   ThreadSummary,
31:   WebhookOptions,
32: } from "chat";
33: import {
34:   ConsoleLogger,
35:   convertEmojiPlaceholders,
36:   defaultEmojiResolver,
37:   getEmoji,
38:   Message,
39: } from "chat";
40: import {
41:   Client,
42:   type Message as DiscordJsMessage,
43:   Events,
44:   GatewayIntentBits,
45:   Partials,
46: } from "discord.js";
47: import {
48:   type APIEmbed,
49:   type APIMessage,
50:   ChannelType,
51:   InteractionType,
52: } from "discord-api-types/v10";
53: import {
54:   InteractionResponseType as DiscordInteractionResponseType,
55:   verifyKey,
56: } from "discord-interactions";
57: import { cardToDiscordPayload, cardToFallbackText } from "./cards";
58: import { DiscordFormatConverter } from "./markdown";
59: import {
60:   type DiscordActionRow,
61:   type DiscordAdapterConfig,
62:   type DiscordForwardedEvent,
63:   type DiscordGatewayEventType,
64:   type DiscordGatewayMessageData,
65:   type DiscordGatewayReactionData,
66:   type DiscordInteraction,
67:   type DiscordInteractionResponse,
68:   type DiscordMessagePayload,
69:   type DiscordThreadId,
70:   InteractionResponseType,
71: } from "./types";
72: 
73: const DISCORD_API_BASE = "https://discord.com/api/v10";
74: const DISCORD_MAX_CONTENT_LENGTH = 2000;
75: const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
76: const HEX_PATTERN = /^[0-9a-f]+$/;
77: 
78: export class DiscordAdapter implements Adapter<DiscordThreadId, unknown> {
79:   readonly name = "discord";
80:   readonly userName: string;
81:   readonly botUserId?: string;
82: 
83:   private readonly botToken: string;
84:   private readonly publicKey: string;
85:   private readonly applicationId: string;
86:   private readonly mentionRoleIds: string[];
87:   private chat: ChatInstance | null = null;
88:   private readonly logger: Logger;
89:   private readonly formatConverter = new DiscordFormatConverter();
90: 
91:   constructor(
92:     config: DiscordAdapterConfig & { logger: Logger; userName?: string }
93:   ) {
94:     this.botToken = config.botToken;
95:     this.publicKey = config.publicKey.trim().toLowerCase();
96:     this.applicationId = config.applicationId;
97:     this.mentionRoleIds = config.mentionRoleIds ?? [];
98:     this.botUserId = config.applicationId; // Discord app ID is the bot's user ID
99:     this.logger = config.logger;
100:     this.userName = config.userName ?? "bot";
101: 
102:     // Validate public key format
103:     if (!HEX_64_PATTERN.test(this.publicKey)) {
104:       this.logger.error("Invalid Discord public key format", {
105:         length: this.publicKey.length,
106:         isHex: HEX_PATTERN.test(this.publicKey),
107:       });
108:     }
109:   }
110: 
111:   async initialize(chat: ChatInstance): Promise<void> {
112:     this.chat = chat;
113:     this.logger.info("Discord adapter initialized", {
114:       applicationId: this.applicationId,
115:       // Log full public key for debugging - it's public, not secret
116:       publicKey: this.publicKey,
117:     });
118:   }
119: 
120:   /**
121:    * Handle incoming Discord webhook (HTTP Interactions or forwarded Gateway events).
122:    */
123:   async handleWebhook(
124:     request: Request,
125:     options?: WebhookOptions
126:   ): Promise<Response> {
127:     // Get raw body bytes for signature verification
128:     const bodyBuffer = await request.arrayBuffer();
129:     const bodyBytes = new Uint8Array(bodyBuffer);
130:     const body = new TextDecoder().decode(bodyBytes);
131: 
132:     // Check if this is a forwarded Gateway event (uses bot token for auth)
133:     const gatewayToken = request.headers.get("x-discord-gateway-token");
134:     if (gatewayToken) {
135:       if (gatewayToken !== this.botToken) {
136:         this.logger.warn("Invalid gateway token");
137:         return new Response("Invalid gateway token", { status: 401 });
138:       }
139:       this.logger.info("Discord forwarded Gateway event received");
140:       try {
141:         const event = JSON.parse(body) as DiscordForwardedEvent;
142:         return this.handleForwardedGatewayEvent(event, options);
143:       } catch {
144:         return new Response("Invalid JSON", { status: 400 });
145:       }
146:     }
147: 
148:     this.logger.info("Discord webhook received", {
149:       bodyLength: body.length,
150:       bodyBytesLength: bodyBytes.length,
151:       hasSignature: !!request.headers.get("x-signature-ed25519"),
152:       hasTimestamp: !!request.headers.get("x-signature-timestamp"),
153:     });
154: 
155:     // Verify Ed25519 signature using raw bytes
156:     const signature = request.headers.get("x-signature-ed25519");
157:     const timestamp = request.headers.get("x-signature-timestamp");
158: 
159:     const signatureValid = await this.verifySignature(
160:       bodyBytes,
161:       signature,
162:       timestamp
163:     );
164:     if (!signatureValid) {
165:       this.logger.warn("Discord signature verification failed, returning 401");
166:       return new Response("Invalid signature", { status: 401 });
167:     }
168:     this.logger.info("Discord signature verification passed");
169: 
170:     let interaction: DiscordInteraction;
171:     try {
172:       interaction = JSON.parse(body);
173:     } catch {
174:       return new Response("Invalid JSON", { status: 400 });
175:     }
176: 
177:     this.logger.info("Discord interaction parsed", {
178:       type: interaction.type,
179:       typeIsPing: interaction.type === InteractionType.Ping,
180:       expectedPingType: InteractionType.Ping,
181:       id: interaction.id,
182:     });
183: 
184:     // Handle PING (Discord verification)
185:     if (interaction.type === InteractionType.Ping) {
186:       // Use official discord-interactions response type
187:       const responseBody = JSON.stringify({
188:         type: DiscordInteractionResponseType.PONG,
189:       });
190:       this.logger.info("Discord PING received, responding with PONG", {
191:         responseBody,
192:         responseType: DiscordInteractionResponseType.PONG,
193:       });
194:       return new Response(responseBody, {
195:         status: 200,
196:         headers: { "Content-Type": "application/json" },
197:       });
198:     }
199: 
200:     // Handle MESSAGE_COMPONENT (button clicks)
201:     if (interaction.type === InteractionType.MessageComponent) {
202:       this.handleComponentInteraction(interaction, options);
203:       // ACK the interaction immediately
204:       return this.respondToInteraction({
205:         type: InteractionResponseType.DeferredUpdateMessage,
206:       });
207:     }
208: 
209:     // Handle APPLICATION_COMMAND (slash commands - not implemented yet)
210:     if (interaction.type === InteractionType.ApplicationCommand) {
211:       // For now, just ACK
212:       return this.respondToInteraction({
213:         type: InteractionResponseType.DeferredChannelMessageWithSource,
214:       });
215:     }
216: 
217:     return new Response("Unknown interaction type", { status: 400 });
218:   }
219: 
220:   /**
221:    * Verify Discord's Ed25519 signature using official discord-interactions library.
222:    */
223:   private async verifySignature(
224:     bodyBytes: Uint8Array,
225:     signature: string | null,
226:     timestamp: string | null
227:   ): Promise<boolean> {
228:     if (!(signature && timestamp)) {
229:       this.logger.warn(
230:         "Discord signature verification failed: missing headers",
231:         {
232:           hasSignature: !!signature,
233:           hasTimestamp: !!timestamp,
234:         }
235:       );
236:       return false;
237:     }
238: 
239:     try {
240:       // Log exactly what we're verifying
241:       this.logger.info("Discord signature verification attempt", {
242:         bodyBytesLength: bodyBytes.length,
243:         signatureLength: signature.length,
244:         timestampLength: timestamp.length,
245:         publicKeyLength: this.publicKey.length,
246:         timestamp,
247:         signaturePrefix: signature.slice(0, 16),
248:         publicKey: this.publicKey,
249:       });
250: 
251:       // Use the official discord-interactions library for verification with raw bytes
252:       const isValid = await verifyKey(
253:         bodyBytes,
254:         signature,
255:         timestamp,
256:         this.publicKey
257:       );
258: 
259:       if (!isValid) {
260:         const bodyString = new TextDecoder().decode(bodyBytes);
261:         this.logger.warn(
262:           "Discord signature verification failed: invalid signature",
263:           {
264:             publicKeyLength: this.publicKey.length,
265:             signatureLength: signature.length,
266:             publicKeyPrefix: this.publicKey.slice(0, 8),
267:             publicKeySuffix: this.publicKey.slice(-8),
268:             timestamp,
269:             bodyLength: bodyBytes.length,
270:             bodyPrefix: bodyString.slice(0, 50),
271:           }
272:         );
273:       }
274: 
275:       return isValid;
276:     } catch (error) {
277:       this.logger.warn("Discord signature verification failed: exception", {
278:         error,
279:       });
280:       return false;
281:     }
282:   }
283: 
284:   /**
285:    * Create a JSON response for Discord interactions.
286:    */
287:   private respondToInteraction(response: DiscordInteractionResponse): Response {
288:     return Response.json(response);
289:   }
290: 
291:   /**
292:    * Handle MESSAGE_COMPONENT interactions (button clicks).
293:    */
294:   private handleComponentInteraction(
295:     interaction: DiscordInteraction,
296:     options?: WebhookOptions
297:   ): void {
298:     if (!this.chat) {
299:       this.logger.warn("Chat instance not initialized, ignoring interaction");
300:       return;
301:     }
302: 
303:     const customId = interaction.data?.custom_id;
304:     if (!customId) {
305:       this.logger.warn("No custom_id in component interaction");
306:       return;
307:     }
308: 
309:     const user = interaction.member?.user || interaction.user;
310:     if (!user) {
311:       this.logger.warn("No user in component interaction");
312:       return;
313:     }
314: 
315:     const interactionChannelId = interaction.channel_id;
316:     const guildId = interaction.guild_id || "@me";
317:     const messageId = interaction.message?.id;
318: 
319:     if (!(interactionChannelId && messageId)) {
320:       this.logger.warn("Missing channel_id or message_id in interaction");
321:       return;
322:     }
323: 
324:     // Detect if the interaction is inside a thread channel
325:     // Discord channel types: 11 = public thread, 12 = private thread
326:     const channel = interaction.channel;
327:     const isThread = channel?.type === 11 || channel?.type === 12;
328:     const parentChannelId =
329:       isThread && channel?.parent_id ? channel.parent_id : interactionChannelId;
330: 
331:     const threadId = isThread
332:       ? this.encodeThreadId({
333:           guildId,
334:           channelId: parentChannelId,
335:           threadId: interactionChannelId,
336:         })
337:       : this.encodeThreadId({
338:           guildId,
339:           channelId: interactionChannelId,
340:         });
341: 
342:     const actionEvent: Omit<ActionEvent, "thread" | "openModal"> & {
343:       adapter: DiscordAdapter;
344:     } = {
345:       actionId: customId,
346:       value: customId, // Discord custom_id often contains the value
347:       user: {
348:         userId: user.id,
349:         userName: user.username,
350:         fullName: user.global_name || user.username,
351:         isBot: user.bot ?? false,
352:         isMe: false,
353:       },
354:       messageId,
355:       threadId,
356:       adapter: this,
357:       raw: interaction,
358:     };
359: 
360:     this.logger.debug("Processing Discord button action", {
361:       actionId: customId,
362:       messageId,
363:       threadId,
364:     });
365: 
366:     this.chat.processAction(actionEvent, options);
367:   }
368: 
369:   /**
370:    * Handle a forwarded Gateway event received via webhook.
371:    */
372:   private async handleForwardedGatewayEvent(
373:     event: DiscordForwardedEvent,
374:     options?: WebhookOptions
375:   ): Promise<Response> {
376:     this.logger.info("Processing forwarded Gateway event", {
377:       type: event.type,
378:       timestamp: event.timestamp,
379:     });
380: 
381:     switch (event.type) {
382:       case "GATEWAY_MESSAGE_CREATE":
383:         await this.handleForwardedMessage(
384:           event.data as DiscordGatewayMessageData,
385:           options
386:         );
387:         break;
388:       case "GATEWAY_MESSAGE_REACTION_ADD":
389:         await this.handleForwardedReaction(
390:           event.data as DiscordGatewayReactionData,
391:           true,
392:           options
393:         );
394:         break;
395:       case "GATEWAY_MESSAGE_REACTION_REMOVE":
396:         await this.handleForwardedReaction(
397:           event.data as DiscordGatewayReactionData,
398:           false,
399:           options
400:         );
401:         break;
402:       default:
403:         // Other Gateway events are forwarded but not processed - this is expected
404:         this.logger.debug("Forwarded Gateway event (no handler)", {
405:           type: event.type,
406:         });
407:     }
408: 
409:     return new Response(JSON.stringify({ ok: true }), {
410:       status: 200,
411:       headers: { "Content-Type": "application/json" },
412:     });
413:   }
414: 
415:   /**
416:    * Handle a forwarded MESSAGE_CREATE event.
417:    */
418:   private async handleForwardedMessage(
419:     data: DiscordGatewayMessageData,
420:     _options?: WebhookOptions
421:   ): Promise<void> {
422:     if (!this.chat) {
423:       return;
424:     }
425: 
426:     const guildId = data.guild_id || "@me";
427:     const channelId = data.channel_id;
428: 
429:     // Use thread info if provided, otherwise use channel
430:     let discordThreadId: string | undefined;
431:     let parentChannelId = channelId;
432: 
433:     if (data.thread) {
434:       discordThreadId = data.thread.id;
435:       parentChannelId = data.thread.parent_id;
436:     } else if (data.channel_type === 11 || data.channel_type === 12) {
437:       // Message is in a thread (11 = public, 12 = private) but we don't have parent info
438:       // Fetch the channel to get parent_id
439:       try {
440:         const response = await this.discordFetch(
441:           `/channels/${channelId}`,
442:           "GET"
443:         );
444:         const channel = (await response.json()) as { parent_id?: string };
445:         if (channel.parent_id) {
446:           discordThreadId = channelId;
447:           parentChannelId = channel.parent_id;
448:           this.logger.debug("Fetched thread parent for forwarded message", {
449:             threadId: channelId,
450:             parentId: channel.parent_id,
451:           });
452:         }
453:       } catch (error) {
454:         this.logger.error("Failed to fetch thread parent", {
455:           error: String(error),
456:           channelId,
457:         });
458:       }
459:     }
460: 
461:     // Check if bot is mentioned (by user ID or configured role IDs)
462:     const isUserMentioned =
463:       data.is_mention || data.mentions.some((m) => m.id === this.applicationId);
464:     const isRoleMentioned =
465:       this.mentionRoleIds.length > 0 &&
466:       data.mention_roles?.some((roleId) =>
467:         this.mentionRoleIds.includes(roleId)
468:       );
469:     const isMentioned = isUserMentioned || isRoleMentioned;
470: 
471:     // If mentioned and not in a thread, create one
472:     if (!discordThreadId && isMentioned) {
473:       try {
474:         const newThread = await this.createDiscordThread(channelId, data.id);
475:         discordThreadId = newThread.id;
476:         this.logger.debug("Created Discord thread for forwarded mention", {
477:           channelId,
478:           messageId: data.id,
479:           threadId: newThread.id,
480:         });
481:       } catch (error) {
482:         this.logger.error("Failed to create Discord thread for mention", {
483:           error: String(error),
484:           messageId: data.id,
485:         });
486:       }
487:     }
488: 
489:     const threadId = this.encodeThreadId({
490:       guildId,
491:       channelId: parentChannelId,
492:       threadId: discordThreadId,
493:     });
494: 
495:     // Convert to SDK Message format
496:     const chatMessage = new Message({
497:       id: data.id,
498:       threadId,
499:       text: data.content,
500:       formatted: this.formatConverter.toAst(data.content),
501:       author: {
502:         userId: data.author.id,
503:         userName: data.author.username,
504:         fullName: data.author.global_name || data.author.username,
505:         isBot: data.author.bot === true, // Discord returns null for non-bots
506:         isMe: data.author.id === this.applicationId,
507:       },
508:       metadata: {
509:         dateSent: new Date(data.timestamp),
510:         edited: false,
511:       },
512:       attachments: data.attachments.map((a) => ({
513:         type: this.getAttachmentType(a.content_type),
514:         url: a.url,
515:         name: a.filename,
516:         mimeType: a.content_type,
517:         size: a.size,
518:       })),
519:       raw: data,
520:       isMention: isMentioned,
521:     });
522: 
523:     try {
524:       await this.chat.handleIncomingMessage(this, threadId, chatMessage);
525:     } catch (error) {
526:       this.logger.error("Error handling forwarded message", {
527:         error: String(error),
528:         messageId: data.id,
529:       });
530:     }
531:   }
532: 
533:   /**
534:    * Handle a forwarded REACTION_ADD or REACTION_REMOVE event.
535:    */
536:   private async handleForwardedReaction(
537:     data: DiscordGatewayReactionData,
538:     added: boolean,
539:     _options?: WebhookOptions
540:   ): Promise<void> {
541:     if (!this.chat) {
542:       return;
543:     }
544: 
545:     const guildId = data.guild_id || "@me";
546:     const channelId = data.channel_id;
547: 
548:     const threadId = this.encodeThreadId({
549:       guildId,
550:       channelId,
551:     });
552: 
553:     // Normalize emoji
554:     const emojiName = data.emoji.name || "unknown";
555:     const normalizedEmoji = this.normalizeDiscordEmoji(emojiName);
556: 
557:     // Get user info from either data.user (DMs) or data.member.user (guilds)
558:     const userInfo = data.user ?? data.member?.user;
559:     if (!userInfo) {
560:       this.logger.warn("Reaction event missing user info", { data });
561:       return;
562:     }
563: 
564:     const reactionEvent = {
565:       adapter: this as Adapter,
566:       threadId,
567:       messageId: data.message_id,
568:       emoji: normalizedEmoji,
569:       rawEmoji: data.emoji.id ? `<:${emojiName}:${data.emoji.id}>` : emojiName,
570:       added,
571:       user: {
572:         userId: userInfo.id,
573:         userName: userInfo.username,
574:         fullName: userInfo.username,
575:         isBot: userInfo.bot === true, // Discord returns null for non-bots
576:         isMe: userInfo.id === this.applicationId,
577:       },
578:       raw: data,
579:     };
580: 
581:     this.chat.processReaction(reactionEvent);
582:   }
583: 
584:   /**
585:    * Post a message to a Discord channel or thread.
586:    */
587:   async postMessage(
588:     threadId: string,
589:     message: AdapterPostableMessage
590:   ): Promise<RawMessage<unknown>> {
591:     let { channelId, threadId: discordThreadId } =
592:       this.decodeThreadId(threadId);
593:     const actualThreadId = threadId;
594: 
595:     // If in a thread, post to the thread channel
596:     if (discordThreadId) {
597:       channelId = discordThreadId;
598:     }
599: 
600:     // Build message payload
601:     const payload: DiscordMessagePayload = {};
602:     const embeds: APIEmbed[] = [];
603:     const components: DiscordActionRow[] = [];
604: 
605:     // Check for card
606:     const card = extractCard(message);
607:     if (card) {
608:       const cardPayload = cardToDiscordPayload(card);
609:       embeds.push(...cardPayload.embeds);
610:       components.push(...cardPayload.components);
611:       // Fallback text (truncated to Discord's limit)
612:       payload.content = this.truncateContent(cardToFallbackText(card));
613:     } else {
614:       // Regular text message (truncated to Discord's limit)
615:       payload.content = this.truncateContent(
616:         convertEmojiPlaceholders(
617:           this.formatConverter.renderPostable(message),
618:           "discord"
619:         )
620:       );
621:     }
622: 
623:     if (embeds.length > 0) {
624:       payload.embeds = embeds;
625:     }
626:     if (components.length > 0) {
627:       payload.components = components;
628:     }
629: 
630:     // Handle file uploads
631:     const files = extractFiles(message);
632:     if (files.length > 0) {
633:       return this.postMessageWithFiles(
634:         channelId,
635:         actualThreadId,
636:         payload,
637:         files
638:       );
639:     }
640: 
641:     this.logger.debug("Discord API: POST message", {
642:       channelId,
643:       contentLength: payload.content?.length || 0,
644:       embedCount: embeds.length,
645:       componentCount: components.length,
646:     });
647: 
648:     const response = await this.discordFetch(
649:       `/channels/${channelId}/messages`,
650:       "POST",
651:       payload
652:     );
653: 
654:     const result = (await response.json()) as APIMessage;
655: 
656:     this.logger.debug("Discord API: POST message response", {
657:       messageId: result.id,
658:     });
659: 
660:     return {
661:       id: result.id,
662:       threadId: actualThreadId,
663:       raw: result,
664:     };
665:   }
666: 
667:   /**
668:    * Create a Discord thread from a message.
669:    */
670:   private async createDiscordThread(
671:     channelId: string,
672:     messageId: string
673:   ): Promise<{ id: string; name: string }> {
674:     const threadName = `Thread ${new Date().toLocaleString()}`;
675: 
676:     this.logger.debug("Discord API: POST thread", {
677:       channelId,
678:       messageId,
679:       threadName,
680:     });
681: 
682:     const response = await this.discordFetch(
683:       `/channels/${channelId}/messages/${messageId}/threads`,
684:       "POST",
685:       {
686:         name: threadName,
687:         auto_archive_duration: 1440, // 24 hours
688:       }
689:     );
690: 
691:     const result = (await response.json()) as { id: string; name: string };
692: 
693:     this.logger.debug("Discord API: POST thread response", {
694:       threadId: result.id,
695:       threadName: result.name,
696:     });
697: 
698:     return result;
699:   }
700: 
701:   /**
702:    * Truncate content to Discord's maximum length.
703:    */
704:   private truncateContent(content: string): string {
705:     if (content.length <= DISCORD_MAX_CONTENT_LENGTH) {
706:       return content;
707:     }
708:     // Truncate and add ellipsis
709:     return `${content.slice(0, DISCORD_MAX_CONTENT_LENGTH - 3)}...`;
710:   }
711: 
712:   /**
713:    * Post a message with file attachments.
714:    */
715:   private async postMessageWithFiles(
716:     channelId: string,
717:     threadId: string,
718:     payload: DiscordMessagePayload,
719:     files: Array<{
720:       filename: string;
721:       data: Buffer | Blob | ArrayBuffer;
722:       mimeType?: string;
723:     }>
724:   ): Promise<RawMessage<unknown>> {
725:     const formData = new FormData();
726: 
727:     // Add JSON payload
728:     formData.append("payload_json", JSON.stringify(payload));
729: 
730:     // Add files
731:     for (let i = 0; i < files.length; i++) {
732:       const file = files[i];
733:       if (!file) {
734:         continue;
735:       }
736:       const buffer = await toBuffer(file.data, {
737:         platform: "discord" as "slack",
738:       });
739:       if (!buffer) {
740:         continue;
741:       }
742:       const blob = new Blob([new Uint8Array(buffer)], {
743:         type: file.mimeType || "application/octet-stream",
744:       });
745:       formData.append(`files[${i}]`, blob, file.filename);
746:     }
747: 
748:     const response = await fetch(
749:       `${DISCORD_API_BASE}/channels/${channelId}/messages`,
750:       {
751:         method: "POST",
752:         headers: {
753:           Authorization: `Bot ${this.botToken}`,
754:         },
755:         body: formData,
756:       }
757:     );
758: 
759:     if (!response.ok) {
760:       const error = await response.text();
761:       throw new NetworkError(
762:         "discord",
763:         `Failed to post message: ${response.status} ${error}`
764:       );
765:     }
766: 
767:     const result = (await response.json()) as APIMessage;
768: 
769:     return {
770:       id: result.id,
771:       threadId,
772:       raw: result,
773:     };
774:   }
775: 
776:   /**
777:    * Edit an existing Discord message.
778:    */
779:   async editMessage(
780:     threadId: string,
781:     messageId: string,
782:     message: AdapterPostableMessage
783:   ): Promise<RawMessage<unknown>> {
784:     const { channelId, threadId: discordThreadId } =
785:       this.decodeThreadId(threadId);
786:     // Use thread channel ID if in a thread, otherwise use channel ID
787:     const targetChannelId = discordThreadId || channelId;
788: 
789:     // Build message payload
790:     const payload: DiscordMessagePayload = {};
791:     const embeds: APIEmbed[] = [];
792:     const components: DiscordActionRow[] = [];
793: 
794:     // Check for card
795:     const card = extractCard(message);
796:     if (card) {
797:       const cardPayload = cardToDiscordPayload(card);
798:       embeds.push(...cardPayload.embeds);
799:       components.push(...cardPayload.components);
800:       // Fallback text (truncated to Discord's limit)
801:       payload.content = this.truncateContent(cardToFallbackText(card));
802:     } else {
803:       // Regular text message (truncated to Discord's limit)
804:       payload.content = this.truncateContent(
805:         convertEmojiPlaceholders(
806:           this.formatConverter.renderPostable(message),
807:           "discord"
808:         )
809:       );
810:     }
811: 
812:     if (embeds.length > 0) {
813:       payload.embeds = embeds;
814:     }
815:     if (components.length > 0) {
816:       payload.components = components;
817:     }
818: 
819:     this.logger.debug("Discord API: PATCH message", {
820:       channelId: targetChannelId,
821:       messageId,
822:       contentLength: payload.content?.length || 0,
823:     });
824: 
825:     const response = await this.discordFetch(
826:       `/channels/${targetChannelId}/messages/${messageId}`,
827:       "PATCH",
828:       payload
829:     );
830: 
831:     const result = (await response.json()) as APIMessage;
832: 
833:     this.logger.debug("Discord API: PATCH message response", {
834:       messageId: result.id,
835:     });
836: 
837:     return {
838:       id: result.id,
839:       threadId,
840:       raw: result,
841:     };
842:   }
843: 
844:   /**
845:    * Delete a Discord message.
846:    */
847:   async deleteMessage(threadId: string, messageId: string): Promise<void> {
848:     const { channelId } = this.decodeThreadId(threadId);
849: 
850:     this.logger.debug("Discord API: DELETE message", {
851:       channelId,
852:       messageId,
853:     });
854: 
855:     await this.discordFetch(
856:       `/channels/${channelId}/messages/${messageId}`,
857:       "DELETE"
858:     );
859: 
860:     this.logger.debug("Discord API: DELETE message response", { ok: true });
861:   }
862: 
863:   /**
864:    * Add a reaction to a Discord message.
865:    */
866:   async addReaction(
867:     threadId: string,
868:     messageId: string,
869:     emoji: EmojiValue | string
870:   ): Promise<void> {
871:     const { channelId } = this.decodeThreadId(threadId);
872:     const emojiEncoded = this.encodeEmoji(emoji);
873: 
874:     this.logger.debug("Discord API: PUT reaction", {
875:       channelId,
876:       messageId,
877:       emoji: emojiEncoded,
878:     });
879: 
880:     await this.discordFetch(
881:       `/channels/${channelId}/messages/${messageId}/reactions/${emojiEncoded}/@me`,
882:       "PUT"
883:     );
884: 
885:     this.logger.debug("Discord API: PUT reaction response", { ok: true });
886:   }
887: 
888:   /**
889:    * Remove a reaction from a Discord message.
890:    */
891:   async removeReaction(
892:     threadId: string,
893:     messageId: string,
894:     emoji: EmojiValue | string
895:   ): Promise<void> {
896:     const { channelId } = this.decodeThreadId(threadId);
897:     const emojiEncoded = this.encodeEmoji(emoji);
898: 
899:     this.logger.debug("Discord API: DELETE reaction", {
900:       channelId,
901:       messageId,
902:       emoji: emojiEncoded,
903:     });
904: 
905:     await this.discordF
...(truncated)
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/types.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/types.ts</path>
<type>file</type>
<content>1: /**
2:  * Discord adapter types.
3:  */
4: 
5: import type {
6:   APIEmbed,
7:   APIMessage,
8:   ButtonStyle,
9:   ChannelType,
10:   InteractionType,
11: } from "discord-api-types/v10";
12: 
13: /**
14:  * Discord adapter configuration.
15:  */
16: export interface DiscordAdapterConfig {
17:   /** Discord application ID */
18:   applicationId: string;
19:   /** Discord bot token */
20:   botToken: string;
21:   /** Role IDs that should trigger mention handlers (in addition to direct user mentions) */
22:   mentionRoleIds?: string[];
23:   /** Discord application public key for webhook signature verification */
24:   publicKey: string;
25: }
26: 
27: /**
28:  * Discord thread ID components.
29:  * Used for encoding/decoding thread IDs.
30:  */
31: export interface DiscordThreadId {
32:   /** Channel ID */
33:   channelId: string;
34:   /** Guild ID, or "@me" for DMs */
35:   guildId: string;
36:   /** Thread ID (if message is in a thread) */
37:   threadId?: string;
38: }
39: 
40: /**
41:  * Incoming Discord interaction from webhook.
42:  */
43: export interface DiscordInteraction {
44:   application_id: string;
45:   channel?: {
46:     id: string;
47:     type: ChannelType;
48:     name?: string;
49:     /** Parent channel ID (present when channel is a thread) */
50:     parent_id?: string;
51:   };
52:   channel_id?: string;
53:   data?: DiscordInteractionData;
54:   guild_id?: string;
55:   id: string;
56:   member?: {
57:     user: DiscordUser;
58:     nick?: string;
59:     roles: string[];
60:     joined_at: string;
61:   };
62:   message?: APIMessage;
63:   token: string;
64:   type: InteractionType;
65:   user?: DiscordUser;
66:   version: number;
67: }
68: 
69: /**
70:  * Discord user object.
71:  */
72: export interface DiscordUser {
73:   avatar?: string;
74:   bot?: boolean;
75:   discriminator: string;
76:   global_name?: string;
77:   id: string;
78:   username: string;
79: }
80: 
81: /**
82:  * Discord interaction data (for components/commands).
83:  */
84: export interface DiscordInteractionData {
85:   component_type?: number;
86:   custom_id?: string;
87:   name?: string;
88:   options?: DiscordCommandOption[];
89:   type?: number;
90:   values?: string[];
91: }
92: 
93: /**
94:  * Discord command option.
95:  */
96: export interface DiscordCommandOption {
97:   name: string;
98:   options?: DiscordCommandOption[];
99:   type: number;
100:   value?: string | number | boolean;
101: }
102: 
103: /**
104:  * Discord emoji.
105:  */
106: export interface DiscordEmoji {
107:   animated?: boolean;
108:   id?: string;
109:   name: string;
110: }
111: 
112: /**
113:  * Discord button component.
114:  */
115: export interface DiscordButton {
116:   custom_id?: string;
117:   disabled?: boolean;
118:   emoji?: DiscordEmoji;
119:   label?: string;
120:   style: ButtonStyle;
121:   type: 2; // Component type for button
122:   url?: string;
123: }
124: 
125: /**
126:  * Discord action row component.
127:  */
128: export interface DiscordActionRow {
129:   components: DiscordButton[];
130:   type: 1; // Component type for action row
131: }
132: 
133: /**
134:  * Discord message create payload.
135:  */
136: export interface DiscordMessagePayload {
137:   allowed_mentions?: {
138:     parse?: ("roles" | "users" | "everyone")[];
139:     roles?: string[];
140:     users?: string[];
141:     replied_user?: boolean;
142:   };
143:   attachments?: {
144:     id: string;
145:     filename: string;
146:     description?: string;
147:   }[];
148:   components?: DiscordActionRow[];
149:   content?: string;
150:   embeds?: APIEmbed[];
151:   message_reference?: {
152:     message_id: string;
153:     fail_if_not_exists?: boolean;
154:   };
155: }
156: 
157: /**
158:  * Discord interaction response types.
159:  * Note: Only the types currently used are defined here.
160:  * Additional types: ChannelMessageWithSource (4), UpdateMessage (7)
161:  */
162: export const InteractionResponseType = {
163:   /** ACK and edit later (deferred) */
164:   DeferredChannelMessageWithSource: 5,
165:   /** ACK component interaction, update message later */
166:   DeferredUpdateMessage: 6,
167: } as const;
168: 
169: export type InteractionResponseType =
170:   (typeof InteractionResponseType)[keyof typeof InteractionResponseType];
171: 
172: /**
173:  * Discord interaction response.
174:  */
175: export interface DiscordInteractionResponse {
176:   data?: DiscordMessagePayload;
177:   type: InteractionResponseType;
178: }
179: 
180: // ============================================================================
181: // Gateway Forwarded Events
182: // These types represent Gateway WebSocket events forwarded to the webhook endpoint
183: // ============================================================================
184: 
185: /**
186:  * Known Gateway event types that have specific handlers.
187:  * Other event types are still forwarded but processed generically.
188:  */
189: export type DiscordGatewayEventType =
190:   | "GATEWAY_MESSAGE_CREATE"
191:   | "GATEWAY_MESSAGE_REACTION_ADD"
192:   | "GATEWAY_MESSAGE_REACTION_REMOVE"
193:   | `GATEWAY_${string}`; // Allow any Gateway event type
194: 
195: /**
196:  * A Gateway event forwarded to the webhook endpoint.
197:  * All Gateway events are forwarded, even ones without specific handlers.
198:  */
199: export interface DiscordForwardedEvent {
200:   /** Event-specific data - structure varies by event type */
201:   data: DiscordGatewayMessageData | DiscordGatewayReactionData | unknown;
202:   /** Unix timestamp when the event was received */
203:   timestamp: number;
204:   /** Event type identifier (prefixed with GATEWAY_) */
205:   type: DiscordGatewayEventType;
206: }
207: 
208: /**
209:  * Message data from a MESSAGE_CREATE Gateway event.
210:  */
211: export interface DiscordGatewayMessageData {
212:   /** File attachments */
213:   attachments: Array<{
214:     id: string;
215:     url: string;
216:     filename: string;
217:     content_type?: string;
218:     size: number;
219:   }>;
220:   /** Message author */
221:   author: {
222:     id: string;
223:     username: string;
224:     global_name?: string;
225:     bot: boolean;
226:   };
227:   /** Channel where the message was sent */
228:   channel_id: string;
229:   /** Channel type (11 = public thread, 12 = private thread) */
230:   channel_type?: number;
231:   /** Message content */
232:   content: string;
233:   /** Guild ID, or null for DMs */
234:   guild_id: string | null;
235:   /** Message ID */
236:   id: string;
237:   /** Whether the bot was mentioned */
238:   is_mention?: boolean;
239:   /** Role IDs mentioned in the message */
240:   mention_roles?: string[];
241:   /** Users mentioned in the message */
242:   mentions: Array<{ id: string; username: string }>;
243:   /** Thread info if message is in a thread */
244:   thread?: {
245:     id: string;
246:     parent_id: string;
247:   };
248:   /** ISO timestamp */
249:   timestamp: string;
250: }
251: 
252: /**
253:  * Reaction data from REACTION_ADD or REACTION_REMOVE Gateway events.
254:  */
255: export interface DiscordGatewayReactionData {
256:   /** Channel containing the message */
257:   channel_id: string;
258:   /** Emoji used for the reaction */
259:   emoji: {
260:     name: string | null;
261:     id: string | null;
262:   };
263:   /** Guild ID, or null for DMs */
264:   guild_id: string | null;
265:   /** Member details (for guild reactions) */
266:   member?: {
267:     user: {
268:       id: string;
269:       username: string;
270:       global_name?: string;
271:       bot?: boolean;
272:     };
273:   };
274:   /** ID of the message that was reacted to */
275:   message_id: string;
276:   /** User details (for DMs) */
277:   user?: {
278:     id: string;
279:     username: string;
280:     bot?: boolean;
281:   };
282:   /** User who added/removed the reaction */
283:   user_id: string;
284: }

(End of file - total 284 lines)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/cards.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/cards.ts</path>
<type>file</type>
<content>1: /**
2:  * Discord Embed and Component converter for cross-platform cards.
3:  *
4:  * Converts CardElement to Discord Embeds and Action Row Components.
5:  * @see https://discord.com/developers/docs/resources/message#embed-object
6:  * @see https://discord.com/developers/docs/interactions/message-components
7:  */
8: 
9: import type {
10:   ActionsElement,
11:   ButtonElement,
12:   CardChild,
13:   CardElement,
14:   FieldsElement,
15:   LinkButtonElement,
16:   SectionElement,
17:   TextElement,
18: } from "chat";
19: import { convertEmojiPlaceholders } from "chat";
20: import type { APIEmbed, APIEmbedField } from "discord-api-types/v10";
21: import { ButtonStyle } from "discord-api-types/v10";
22: import type { DiscordActionRow, DiscordButton } from "./types";
23: 
24: /**
25:  * Convert emoji placeholders to Discord format.
26:  */
27: function convertEmoji(text: string): string {
28:   return convertEmojiPlaceholders(text, "discord");
29: }
30: 
31: /**
32:  * Convert a CardElement to Discord message payload (embeds + components).
33:  */
34: export function cardToDiscordPayload(card: CardElement): {
35:   embeds: APIEmbed[];
36:   components: DiscordActionRow[];
37: } {
38:   const embed: APIEmbed = {};
39:   const fields: APIEmbedField[] = [];
40:   const components: DiscordActionRow[] = [];
41: 
42:   // Set title and description (with emoji conversion)
43:   if (card.title) {
44:     embed.title = convertEmoji(card.title);
45:   }
46: 
47:   if (card.subtitle) {
48:     embed.description = convertEmoji(card.subtitle);
49:   }
50: 
51:   // Set header image
52:   if (card.imageUrl) {
53:     embed.image = {
54:       url: card.imageUrl,
55:     };
56:   }
57: 
58:   // Set color (default to Discord blurple)
59:   embed.color = 0x5865f2;
60: 
61:   // Process children
62:   const textParts: string[] = [];
63: 
64:   for (const child of card.children) {
65:     processChild(child, textParts, fields, components);
66:   }
67: 
68:   // If we have text parts and no description, set them as description
69:   if (textParts.length > 0) {
70:     if (embed.description) {
71:       embed.description += `\n\n${textParts.join("\n\n")}`;
72:     } else {
73:       embed.description = textParts.join("\n\n");
74:     }
75:   }
76: 
77:   // Add fields if we have any
78:   if (fields.length > 0) {
79:     embed.fields = fields;
80:   }
81: 
82:   return {
83:     embeds: [embed],
84:     components,
85:   };
86: }
87: 
88: /**
89:  * Process a card child element.
90:  */
91: function processChild(
92:   child: CardChild,
93:   textParts: string[],
94:   fields: APIEmbedField[],
95:   components: DiscordActionRow[]
96: ): void {
97:   switch (child.type) {
98:     case "text":
99:       textParts.push(convertTextElement(child));
100:       break;
101:     case "image":
102:       // Discord embeds can only have one image, handled at card level
103:       // Additional images could be added as separate embeds
104:       break;
105:     case "divider":
106:       // No direct equivalent, add a horizontal line marker
107:       textParts.push("───────────");
108:       break;
109:     case "actions":
110:       components.push(...convertActionsToRows(child));
111:       break;
112:     case "section":
113:       processSectionElement(child, textParts, fields, components);
114:       break;
115:     case "fields":
116:       convertFieldsElement(child, fields);
117:       break;
118:     case "link":
119:       textParts.push(`[${convertEmoji(child.label)}](${child.url})`);
120:       break;
121:     default:
122:       break;
123:   }
124: }
125: 
126: /**
127:  * Convert a text element to Discord markdown.
128:  */
129: function convertTextElement(element: TextElement): string {
130:   let text = convertEmoji(element.content);
131: 
132:   // Apply style
133:   if (element.style === "bold") {
134:     text = `**${text}**`;
135:   } else if (element.style === "muted") {
136:     // Discord doesn't have muted, use italic as approximation
137:     text = `*${text}*`;
138:   }
139: 
140:   return text;
141: }
142: 
143: /**
144:  * Convert an actions element to Discord action rows.
145:  * Discord limits each action row to 5 components, so we chunk buttons.
146:  */
147: function convertActionsToRows(element: ActionsElement): DiscordActionRow[] {
148:   const buttons: DiscordButton[] = element.children
149:     .filter((child) => child.type === "button" || child.type === "link-button")
150:     .map((button) => {
151:       if (button.type === "link-button") {
152:         return convertLinkButtonElement(button);
153:       }
154:       return convertButtonElement(button);
155:     });
156: 
157:   // Discord allows max 5 buttons per action row
158:   const rows: DiscordActionRow[] = [];
159:   for (let i = 0; i < buttons.length; i += 5) {
160:     rows.push({
161:       type: 1, // Action Row
162:       components: buttons.slice(i, i + 5),
163:     });
164:   }
165:   return rows;
166: }
167: 
168: /**
169:  * Convert a button element to a Discord button.
170:  */
171: function convertButtonElement(button: ButtonElement): DiscordButton {
172:   const discordButton: DiscordButton = {
173:     type: 2, // Button
174:     style: getButtonStyle(button.style),
175:     label: button.label,
176:     custom_id: button.id,
177:   };
178: 
179:   return discordButton;
180: }
181: 
182: /**
183:  * Convert a link button element to a Discord link button.
184:  */
185: function convertLinkButtonElement(button: LinkButtonElement): DiscordButton {
186:   return {
187:     type: 2, // Button
188:     style: ButtonStyle.Link,
189:     label: button.label,
190:     url: button.url,
191:   };
192: }
193: 
194: /**
195:  * Map button style to Discord button style.
196:  */
197: function getButtonStyle(style?: ButtonElement["style"]): ButtonStyle {
198:   switch (style) {
199:     case "primary":
200:       return ButtonStyle.Primary;
201:     case "danger":
202:       return ButtonStyle.Danger;
203:     default:
204:       return ButtonStyle.Secondary;
205:   }
206: }
207: 
208: /**
209:  * Process a section element.
210:  */
211: function processSectionElement(
212:   element: SectionElement,
213:   textParts: string[],
214:   fields: APIEmbedField[],
215:   components: DiscordActionRow[]
216: ): void {
217:   for (const child of element.children) {
218:     processChild(child, textParts, fields, components);
219:   }
220: }
221: 
222: /**
223:  * Convert fields element to Discord embed fields.
224:  */
225: function convertFieldsElement(
226:   element: FieldsElement,
227:   fields: APIEmbedField[]
228: ): void {
229:   for (const field of element.children) {
230:     fields.push({
231:       name: convertEmoji(field.label),
232:       value: convertEmoji(field.value),
233:       inline: true, // Discord fields can be inline
234:     });
235:   }
236: }
237: 
238: /**
239:  * Generate fallback text from a card element.
240:  * Used when embeds aren't supported or for notifications.
241:  */
242: export function cardToFallbackText(card: CardElement): string {
243:   const parts: string[] = [];
244: 
245:   if (card.title) {
246:     parts.push(`**${convertEmoji(card.title)}**`);
247:   }
248: 
249:   if (card.subtitle) {
250:     parts.push(convertEmoji(card.subtitle));
251:   }
252: 
253:   for (const child of card.children) {
254:     const text = childToFallbackText(child);
255:     if (text) {
256:       parts.push(text);
257:     }
258:   }
259: 
260:   return parts.join("\n\n");
261: }
262: 
263: /**
264:  * Convert a card child element to fallback text.
265:  */
266: function childToFallbackText(child: CardChild): string | null {
267:   switch (child.type) {
268:     case "text":
269:       return convertEmoji(child.content);
270:     case "fields":
271:       return child.children
272:         .map((f) => `**${convertEmoji(f.label)}**: ${convertEmoji(f.value)}`)
273:         .join("\n");
274:     case "actions":
275:       // Actions are interactive-only — exclude from fallback text.
276:       // See: https://docs.slack.dev/reference/methods/chat.postMessage
277:       return null;
278:     case "section":
279:       return child.children
280:         .map((c) => childToFallbackText(c))
281:         .filter(Boolean)
282:         .join("\n");
283:     case "divider":
284:       return "---";
285:     default:
286:       return null;
287:   }
288: }

(End of file - total 288 lines)
</content>
```


*Completed in 5.1s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Now let me read the remaining Discord adapter file and the Slack adapter:

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/index.ts
offset: 1808

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/index.ts</path>
<type>file</type>
<content>1808:       channelId: discordChannelId,
1809:     });
1810: 
1811:     // Fetch active threads from the guild
1812:     const activeResponse = await this.discordFetch(
1813:       `/guilds/${guildId}/threads/active`,
1814:       "GET"
1815:     );
1816:     const activeData = (await activeResponse.json()) as {
1817:       threads: Array<{
1818:         id: string;
1819:         name: string;
1820:         parent_id: string;
1821:         message_count?: number;
1822:         total_message_sent?: number;
1823:         thread_metadata?: { archive_timestamp?: string };
1824:       }>;
1825:     };
1826: 
1827:     // Filter threads that belong to our channel
1828:     const channelThreads = (activeData.threads || []).filter(
1829:       (t) => t.parent_id === discordChannelId
1830:     );
1831: 
1832:     // Also fetch archived public threads
1833:     let archivedThreads: typeof channelThreads = [];
1834:     try {
1835:       const archivedResponse = await this.discordFetch(
1836:         `/channels/${discordChannelId}/threads/archived/public?limit=${options.limit || 50}`,
1837:         "GET"
1838:       );
1839:       const archivedData = (await archivedResponse.json()) as {
1840:         threads: typeof channelThreads;
1841:       };
1842:       archivedThreads = archivedData.threads || [];
1843:     } catch {
1844:       // Archived threads may not be available (permissions)
1845:       this.logger.debug(
1846:         "Could not fetch archived threads (may lack permissions)"
1847:       );
1848:     }
1849: 
1850:     // Merge and deduplicate
1851:     const allThreads = [...channelThreads, ...archivedThreads];
1852:     const seen = new Set<string>();
1853:     const uniqueThreads = allThreads.filter((t) => {
1854:       if (seen.has(t.id)) {
1855:         return false;
1856:       }
1857:       seen.add(t.id);
1858:       return true;
1859:     });
1860: 
1861:     // Apply limit
1862:     const limit = options.limit || 50;
1863:     const limitedThreads = uniqueThreads.slice(0, limit);
1864: 
1865:     // Convert to ThreadSummary - fetch the first message of each thread
1866:     const threads: ThreadSummary[] = [];
1867:     for (const thread of limitedThreads) {
1868:       const threadId = this.encodeThreadId({
1869:         guildId,
1870:         channelId: discordChannelId,
1871:         threadId: thread.id,
1872:       });
1873: 
1874:       // Fetch the first message of the thread (which is the root/starter message)
1875:       try {
1876:         const msgsResponse = await this.discordFetch(
1877:           `/channels/${thread.id}/messages?limit=1&after=0`,
1878:           "GET"
1879:         );
1880:         const msgs = (await msgsResponse.json()) as APIMessage[];
1881:         const rootMsg = msgs[0];
1882: 
1883:         if (rootMsg) {
1884:           threads.push({
1885:             id: threadId,
1886:             rootMessage: this.parseDiscordMessage(rootMsg, threadId),
1887:             replyCount: thread.total_message_sent ?? thread.message_count,
1888:             lastReplyAt: thread.thread_metadata?.archive_timestamp
1889:               ? new Date(thread.thread_metadata.archive_timestamp)
1890:               : undefined,
1891:           });
1892:         }
1893:       } catch {
1894:         // If we can't fetch the root message, create a placeholder
1895:         threads.push({
1896:           id: threadId,
1897:           rootMessage: new Message({
1898:             id: thread.id,
1899:             threadId,
1900:             text: thread.name,
1901:             formatted: this.formatConverter.toAst(thread.name),
1902:             raw: thread,
1903:             author: {
1904:               userId: "unknown",
1905:               userName: "unknown",
1906:               fullName: "unknown",
1907:               isBot: false,
1908:               isMe: false,
1909:             },
1910:             metadata: { dateSent: new Date(), edited: false },
1911:             attachments: [],
1912:           }),
1913:           replyCount: thread.total_message_sent ?? thread.message_count,
1914:         });
1915:       }
1916:     }
1917: 
1918:     this.logger.debug("Discord API: listThreads result", {
1919:       threadCount: threads.length,
1920:     });
1921: 
1922:     return {
1923:       threads,
1924:       nextCursor: uniqueThreads.length > limit ? String(limit) : undefined,
1925:     };
1926:   }
1927: 
1928:   /**
1929:    * Fetch Discord channel info/metadata.
1930:    */
1931:   async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
1932:     const parts = channelId.split(":");
1933:     const discordChannelId = parts[2];
1934:     if (!discordChannelId) {
1935:       throw new ValidationError(
1936:         "discord",
1937:         `Invalid Discord channel ID: ${channelId}`
1938:       );
1939:     }
1940: 
1941:     this.logger.debug("Discord API: GET channel info", {
1942:       channelId: discordChannelId,
1943:     });
1944: 
1945:     const response = await this.discordFetch(
1946:       `/channels/${discordChannelId}`,
1947:       "GET"
1948:     );
1949:     const channel = (await response.json()) as {
1950:       id: string;
1951:       name?: string;
1952:       type: ChannelType;
1953:       member_count?: number;
1954:     };
1955: 
1956:     return {
1957:       id: channelId,
1958:       name: channel.name,
1959:       isDM:
1960:         channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM,
1961:       memberCount: channel.member_count,
1962:       metadata: {
1963:         channelType: channel.type,
1964:         raw: channel,
1965:       },
1966:     };
1967:   }
1968: 
1969:   /**
1970:    * Post a message to channel top-level (not in a thread).
1971:    * Posts directly to the parent channel without a thread reference.
1972:    */
1973:   async postChannelMessage(
1974:     channelId: string,
1975:     message: AdapterPostableMessage
1976:   ): Promise<RawMessage<unknown>> {
1977:     const parts = channelId.split(":");
1978:     const discordChannelId = parts[2];
1979:     if (!discordChannelId) {
1980:       throw new ValidationError(
1981:         "discord",
1982:         `Invalid Discord channel ID: ${channelId}`
1983:       );
1984:     }
1985: 
1986:     // Build message payload
1987:     const payload: DiscordMessagePayload = {};
1988:     const embeds: APIEmbed[] = [];
1989:     const components: DiscordActionRow[] = [];
1990: 
1991:     const card = extractCard(message);
1992:     if (card) {
1993:       const cardPayload = cardToDiscordPayload(card);
1994:       embeds.push(...cardPayload.embeds);
1995:       components.push(...cardPayload.components);
1996:       payload.content = this.truncateContent(cardToFallbackText(card));
1997:     } else {
1998:       payload.content = this.truncateContent(
1999:         convertEmojiPlaceholders(
2000:           this.formatConverter.renderPostable(message),
2001:           "discord"
2002:         )
2003:       );
2004:     }
2005: 
2006:     if (embeds.length > 0) {
2007:       payload.embeds = embeds;
2008:     }
2009:     if (components.length > 0) {
2010:       payload.components = components;
2011:     }
2012: 
2013:     const files = extractFiles(message);
2014:     if (files.length > 0) {
2015:       return this.postMessageWithFiles(
2016:         discordChannelId,
2017:         channelId,
2018:         payload,
2019:         files
2020:       );
2021:     }
2022: 
2023:     this.logger.debug("Discord API: POST channel message", {
2024:       channelId: discordChannelId,
2025:       contentLength: payload.content?.length || 0,
2026:     });
2027: 
2028:     const response = await this.discordFetch(
2029:       `/channels/${discordChannelId}/messages`,
2030:       "POST",
2031:       payload
2032:     );
2033: 
2034:     const result = (await response.json()) as APIMessage;
2035: 
2036:     return {
2037:       id: result.id,
2038:       threadId: channelId,
2039:       raw: result,
2040:     };
2041:   }
2042: 
2043:   /**
2044:    * Normalize a Discord emoji to our standard EmojiValue format.
2045:    */
2046:   private normalizeDiscordEmoji(emojiName: string): EmojiValue {
2047:     // Map common Discord unicode emoji to our standard names
2048:     const unicodeToName: Record<string, string> = {
2049:       "👍": "thumbs_up",
2050:       "👎": "thumbs_down",
2051:       "❤️": "heart",
2052:       "❤": "heart",
2053:       "🔥": "fire",
2054:       "🚀": "rocket",
2055:       "🙌": "raised_hands",
2056:       "✅": "check",
2057:       "❌": "x",
2058:       "👋": "wave",
2059:       "🤔": "thinking",
2060:       "😊": "smile",
2061:       "😂": "laugh",
2062:       "🎉": "party",
2063:       "⭐": "star",
2064:       "✨": "sparkles",
2065:       "👀": "eyes",
2066:       "💯": "100",
2067:     };
2068: 
2069:     // Check if it's a unicode emoji we recognize
2070:     const normalizedName = unicodeToName[emojiName] || emojiName;
2071:     return getEmoji(normalizedName);
2072:   }
2073: }
2074: 
2075: /**
2076:  * Create a Discord adapter instance.
2077:  */
2078: export function createDiscordAdapter(
2079:   config?: Partial<DiscordAdapterConfig & { logger: Logger; userName?: string }>
2080: ): DiscordAdapter {
2081:   const botToken = config?.botToken ?? process.env.DISCORD_BOT_TOKEN;
2082:   if (!botToken) {
2083:     throw new ValidationError(
2084:       "discord",
2085:       "botToken is required. Set DISCORD_BOT_TOKEN or provide it in config."
2086:     );
2087:   }
2088:   const publicKey = config?.publicKey ?? process.env.DISCORD_PUBLIC_KEY;
2089:   if (!publicKey) {
2090:     throw new ValidationError(
2091:       "discord",
2092:       "publicKey is required. Set DISCORD_PUBLIC_KEY or provide it in config."
2093:     );
2094:   }
2095:   const applicationId =
2096:     config?.applicationId ?? process.env.DISCORD_APPLICATION_ID;
2097:   if (!applicationId) {
2098:     throw new ValidationError(
2099:       "discord",
2100:       "applicationId is required. Set DISCORD_APPLICATION_ID or provide it in config."
2101:     );
2102:   }
2103:   const mentionRoleIds =
2104:     config?.mentionRoleIds ??
2105:     (process.env.DISCORD_MENTION_ROLE_IDS
2106:       ? process.env.DISCORD_MENTION_ROLE_IDS.split(",").map((id) => id.trim())
2107:       : undefined);
2108:   const resolved: DiscordAdapterConfig & {
2109:     logger: Logger;
2110:     userName?: string;
2111:   } = {
2112:     botToken,
2113:     publicKey,
2114:     applicationId,
2115:     mentionRoleIds,
2116:     logger: config?.logger ?? new ConsoleLogger("info").child("discord"),
2117:     userName: config?.userName,
2118:   };
2119:   return new DiscordAdapter(resolved);
2120: }
2121: 
2122: // Re-export card converter for advanced use
2123: export { cardToDiscordPayload, cardToFallbackText } from "./cards";
2124: 
2125: // Re-export format converter for advanced use
2126: export {
2127:   DiscordFormatConverter,
2128:   DiscordFormatConverter as DiscordMarkdownConverter,
2129: } from "./markdown";
2130: // Re-export types
2131: export type { DiscordAdapterConfig, DiscordThreadId } from "./types";

(End of file - total 2131 lines)
</content>
```

> ⚠️ **Large tool output** (61,183 chars, truncated to 30,000)

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src/index.ts

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src/index.ts</path>
<type>file</type>
<content>1: import { AsyncLocalStorage } from "node:async_hooks";
2: import { createHmac, timingSafeEqual } from "node:crypto";
3: import {
4:   AdapterRateLimitError,
5:   extractCard,
6:   extractFiles,
7:   NetworkError,
8:   toBuffer,
9:   ValidationError,
10: } from "@chat-adapter/shared";
11: import { WebClient } from "@slack/web-api";
12: import type {
13:   ActionEvent,
14:   Adapter,
15:   AdapterPostableMessage,
16:   Attachment,
17:   ChannelInfo,
18:   ChatInstance,
19:   EmojiValue,
20:   EphemeralMessage,
21:   FetchOptions,
22:   FetchResult,
23:   FileUpload,
24:   FormattedContent,
25:   ListThreadsOptions,
26:   ListThreadsResult,
27:   Logger,
28:   ModalElement,
29:   ModalResponse,
30:   RawMessage,
31:   ReactionEvent,
32:   StreamOptions,
33:   ThreadInfo,
34:   ThreadSummary,
35:   WebhookOptions,
36: } from "chat";
37: 
38: import {
39:   ChatError,
40:   ConsoleLogger,
41:   convertEmojiPlaceholders,
42:   defaultEmojiResolver,
43:   isJSX,
44:   Message,
45:   toModalElement,
46: } from "chat";
47: import { cardToBlockKit, cardToFallbackText } from "./cards";
48: import type { EncryptedTokenData } from "./crypto";
49: import {
50:   decodeKey,
51:   decryptToken,
52:   encryptToken,
53:   isEncryptedTokenData,
54: } from "./crypto";
55: import { SlackFormatConverter } from "./markdown";
56: import {
57:   decodeModalMetadata,
58:   encodeModalMetadata,
59:   modalToSlackView,
60:   type SlackModalResponse,
61: } from "./modals";
62: 
63: export interface SlackAdapterConfig {
64:   /** Bot token (xoxb-...). Required for single-workspace mode. Omit for multi-workspace. */
65:   botToken?: string;
66:   /** Bot user ID (will be fetched if not provided) */
67:   botUserId?: string;
68:   /** Slack app client ID (required for OAuth / multi-workspace) */
69:   clientId?: string;
70:   /** Slack app client secret (required for OAuth / multi-workspace) */
71:   clientSecret?: string;
72:   /**
73:    * Base64-encoded 32-byte AES-256-GCM encryption key.
74:    * If provided, bot tokens stored via setInstallation() will be encrypted at rest.
75:    */
76:   encryptionKey?: string;
77:   /**
78:    * Prefix for the state key used to store workspace installations.
79:    * Defaults to `slack:installation`. The full key will be `{prefix}:{teamId}`.
80:    */
81:   installationKeyPrefix?: string;
82:   /** Logger instance for error reporting */
83:   logger: Logger;
84:   /** Signing secret for webhook verification */
85:   signingSecret: string;
86:   /** Override bot username (optional) */
87:   userName?: string;
88: }
89: 
90: /** Data stored per Slack workspace installation */
91: export interface SlackInstallation {
92:   botToken: string;
93:   botUserId?: string;
94:   teamName?: string;
95: }
96: 
97: /** Slack-specific thread ID data */
98: export interface SlackThreadId {
99:   channel: string;
100:   threadTs: string;
101: }
102: 
103: /** Slack event payload (raw message format) */
104: export interface SlackEvent {
105:   bot_id?: string;
106:   channel?: string;
107:   /** Channel type: "channel", "group", "mpim", or "im" (DM) */
108:   channel_type?: string;
109:   edited?: { ts: string };
110:   files?: Array<{
111:     id?: string;
112:     mimetype?: string;
113:     url_private?: string;
114:     name?: string;
115:     size?: number;
116:     original_w?: number;
117:     original_h?: number;
118:   }>;
119:   /** Timestamp of the latest reply (present on thread parent messages) */
120:   latest_reply?: string;
121:   /** Number of replies in the thread (present on thread parent messages) */
122:   reply_count?: number;
123:   subtype?: string;
124:   team?: string;
125:   team_id?: string;
126:   text?: string;
127:   thread_ts?: string;
128:   ts?: string;
129:   type: string;
130:   user?: string;
131:   username?: string;
132: }
133: 
134: /** Slack reaction event payload */
135: export interface SlackReactionEvent {
136:   event_ts: string;
137:   item: {
138:     type: string;
139:     channel: string;
140:     ts: string;
141:   };
142:   item_user?: string;
143:   reaction: string;
144:   type: "reaction_added" | "reaction_removed";
145:   user: string;
146: }
147: 
148: /** Slack assistant_thread_started event payload */
149: interface SlackAssistantThreadStartedEvent {
150:   assistant_thread: {
151:     user_id: string;
152:     channel_id: string;
153:     thread_ts: string;
154:     context: {
155:       channel_id?: string;
156:       team_id?: string;
157:       enterprise_id?: string;
158:       thread_entry_point?: string;
159:       force_search?: boolean;
160:     };
161:   };
162:   event_ts: string;
163:   type: "assistant_thread_started";
164: }
165: 
166: /** Slack assistant_thread_context_changed event payload */
167: interface SlackAssistantContextChangedEvent {
168:   assistant_thread: {
169:     user_id: string;
170:     channel_id: string;
171:     thread_ts: string;
172:     context: {
173:       channel_id?: string;
174:       team_id?: string;
175:       enterprise_id?: string;
176:       thread_entry_point?: string;
177:       force_search?: boolean;
178:     };
179:   };
180:   event_ts: string;
181:   type: "assistant_thread_context_changed";
182: }
183: 
184: /** Slack app_home_opened event payload */
185: interface SlackAppHomeOpenedEvent {
186:   channel: string;
187:   event_ts: string;
188:   tab: string;
189:   type: "app_home_opened";
190:   user: string;
191: }
192: 
193: /** Slack webhook payload envelope */
194: interface SlackWebhookPayload {
195:   challenge?: string;
196:   event?:
197:     | SlackEvent
198:     | SlackReactionEvent
199:     | SlackAssistantThreadStartedEvent
200:     | SlackAssistantContextChangedEvent
201:     | SlackAppHomeOpenedEvent;
202:   event_id?: string;
203:   event_time?: number;
204:   team_id?: string;
205:   type: string;
206: }
207: 
208: /** Slack interactive payload (block_actions) for button clicks */
209: interface SlackBlockActionsPayload {
210:   actions: Array<{
211:     type: string;
212:     action_id: string;
213:     block_id?: string;
214:     value?: string;
215:     action_ts?: string;
216:     selected_option?: { value: string };
217:   }>;
218:   channel: {
219:     id: string;
220:     name: string;
221:   };
222:   container: {
223:     type: string;
224:     message_ts: string;
225:     channel_id: string;
226:     is_ephemeral?: boolean;
227:     thread_ts?: string;
228:   };
229:   message: {
230:     ts: string;
231:     thread_ts?: string;
232:   };
233:   response_url?: string;
234:   trigger_id: string;
235:   type: "block_actions";
236:   user: {
237:     id: string;
238:     username: string;
239:     name?: string;
240:   };
241: }
242: 
243: interface SlackViewSubmissionPayload {
244:   trigger_id: string;
245:   type: "view_submission";
246:   user: {
247:     id: string;
248:     username: string;
249:     name?: string;
250:   };
251:   view: {
252:     id: string;
253:     callback_id: string;
254:     private_metadata?: string;
255:     state: {
256:       values: Record<
257:         string,
258:         Record<string, { value?: string; selected_option?: { value: string } }>
259:       >;
260:     };
261:   };
262: }
263: 
264: interface SlackViewClosedPayload {
265:   type: "view_closed";
266:   user: {
267:     id: string;
268:     username: string;
269:     name?: string;
270:   };
271:   view: {
272:     id: string;
273:     callback_id: string;
274:     private_metadata?: string;
275:   };
276: }
277: 
278: type SlackInteractivePayload =
279:   | SlackBlockActionsPayload
280:   | SlackViewSubmissionPayload
281:   | SlackViewClosedPayload;
282: 
283: /** Cached user info */
284: interface CachedUser {
285:   displayName: string;
286:   realName: string;
287: }
288: 
289: export class SlackAdapter implements Adapter<SlackThreadId, unknown> {
290:   readonly name = "slack";
291:   readonly userName: string;
292: 
293:   private readonly client: WebClient;
294:   private readonly signingSecret: string;
295:   private readonly defaultBotToken: string | undefined;
296:   private chat: ChatInstance | null = null;
297:   private readonly logger: Logger;
298:   private _botUserId: string | null = null;
299:   private _botId: string | null = null; // Bot app ID (B_xxx) - different from user ID
300:   private readonly formatConverter = new SlackFormatConverter();
301:   private static USER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
302: 
303:   // Multi-workspace support
304:   private readonly clientId: string | undefined;
305:   private readonly clientSecret: string | undefined;
306:   private readonly encryptionKey: Buffer | undefined;
307:   private readonly installationKeyPrefix: string;
308:   private readonly requestContext = new AsyncLocalStorage<{
309:     token: string;
310:     botUserId?: string;
311:   }>();
312: 
313:   /** Bot user ID (e.g., U_BOT_123) used for mention detection */
314:   get botUserId(): string | undefined {
315:     const ctx = this.requestContext.getStore();
316:     if (ctx?.botUserId) {
317:       return ctx.botUserId;
318:     }
319:     return this._botUserId || undefined;
320:   }
321: 
322:   constructor(config: SlackAdapterConfig) {
323:     this.client = new WebClient(config.botToken);
324:     this.signingSecret = config.signingSecret;
325:     this.defaultBotToken = config.botToken;
326:     this.logger = config.logger;
327:     this.userName = config.userName || "bot";
328:     this._botUserId = config.botUserId || null;
329: 
330:     this.clientId = config.clientId;
331:     this.clientSecret = config.clientSecret;
332:     this.installationKeyPrefix =
333:       config.installationKeyPrefix ?? "slack:installation";
334: 
335:     if (config.encryptionKey) {
336:       this.encryptionKey = decodeKey(config.encryptionKey);
337:     }
338:   }
339: 
340:   /**
341:    * Get the current bot token for API calls.
342:    * Checks request context (multi-workspace) → default token (single-workspace) → throws.
343:    */
344:   private getToken(): string {
345:     const ctx = this.requestContext.getStore();
346:     if (ctx?.token) {
347:       return ctx.token;
348:     }
349:     if (this.defaultBotToken) {
350:       return this.defaultBotToken;
351:     }
352:     throw new ChatError(
353:       "No bot token available. In multi-workspace mode, ensure the webhook is being processed.",
354:       "MISSING_BOT_TOKEN"
355:     );
356:   }
357: 
358:   /**
359:    * Add the current token to API call options.
360:    * Workaround for Slack WebClient types not including `token` in per-method args.
361:    */
362:   // biome-ignore lint/suspicious/noExplicitAny: Slack types don't include token in method args
363:   private withToken<T extends Record<string, any>>(
364:     options: T
365:   ): T & { token: string } {
366:     return { ...options, token: this.getToken() };
367:   }
368: 
369:   async initialize(chat: ChatInstance): Promise<void> {
370:     this.chat = chat;
371: 
372:     // Only fetch bot user ID in single-workspace mode (when default token is available)
373:     if (this.defaultBotToken && !this._botUserId) {
374:       try {
375:         const authResult = await this.client.auth.test(this.withToken({}));
376:         this._botUserId = authResult.user_id as string;
377:         this._botId = (authResult.bot_id as string) || null;
378:         if (authResult.user) {
379:           (this as { userName: string }).userName = authResult.user as string;
380:         }
381:         this.logger.info("Slack auth completed", {
382:           botUserId: this._botUserId,
383:           botId: this._botId,
384:         });
385:       } catch (error) {
386:         this.logger.warn("Could not fetch bot user ID", { error });
387:       }
388:     }
389: 
390:     if (!this.defaultBotToken) {
391:       this.logger.info("Slack adapter initialized in multi-workspace mode");
392:     }
393:   }
394: 
395:   // ===========================================================================
396:   // Multi-workspace installation management
397:   // ===========================================================================
398: 
399:   private installationKey(teamId: string): string {
400:     return `${this.installationKeyPrefix}:${teamId}`;
401:   }
402: 
403:   /**
404:    * Save a Slack workspace installation.
405:    * Call this from your OAuth callback route after a successful installation.
406:    */
407:   async setInstallation(
408:     teamId: string,
409:     installation: SlackInstallation
410:   ): Promise<void> {
411:     if (!this.chat) {
412:       throw new ChatError(
413:         "Adapter not initialized. Ensure chat.initialize() has been called first.",
414:         "NOT_INITIALIZED"
415:       );
416:     }
417: 
418:     const state = this.chat.getState();
419:     const key = this.installationKey(teamId);
420: 
421:     const dataToStore = this.encryptionKey
422:       ? {
423:           ...installation,
424:           botToken: encryptToken(installation.botToken, this.encryptionKey),
425:         }
426:       : installation;
427: 
428:     await state.set(key, dataToStore);
429:     this.logger.info("Slack installation saved", {
430:       teamId,
431:       teamName: installation.teamName,
432:     });
433:   }
434: 
435:   /**
436:    * Retrieve a Slack workspace installation.
437:    */
438:   async getInstallation(teamId: string): Promise<SlackInstallation | null> {
439:     if (!this.chat) {
440:       throw new ChatError(
441:         "Adapter not initialized. Ensure chat.initialize() has been called first.",
442:         "NOT_INITIALIZED"
443:       );
444:     }
445: 
446:     const state = this.chat.getState();
447:     const key = this.installationKey(teamId);
448:     const stored = await state.get<
449:       | SlackInstallation
450:       | (Omit<SlackInstallation, "botToken"> & {
451:           botToken: EncryptedTokenData;
452:         })
453:     >(key);
454: 
455:     if (!stored) {
456:       return null;
457:     }
458: 
459:     if (this.encryptionKey && isEncryptedTokenData(stored.botToken)) {
460:       return {
461:         ...stored,
462:         botToken: decryptToken(
463:           stored.botToken as EncryptedTokenData,
464:           this.encryptionKey
465:         ),
466:       };
467:     }
468: 
469:     return stored as SlackInstallation;
470:   }
471: 
472:   /**
473:    * Handle the Slack OAuth V2 callback.
474:    * Accepts the incoming request, extracts the authorization code,
475:    * exchanges it for tokens, and saves the installation.
476:    */
477:   async handleOAuthCallback(
478:     request: Request
479:   ): Promise<{ teamId: string; installation: SlackInstallation }> {
480:     if (!(this.clientId && this.clientSecret)) {
481:       throw new ChatError(
482:         "clientId and clientSecret are required for OAuth. Pass them in createSlackAdapter().",
483:         "MISSING_OAUTH_CONFIG"
484:       );
485:     }
486: 
487:     const url = new URL(request.url);
488:     const code = url.searchParams.get("code");
489:     if (!code) {
490:       throw new ChatError(
491:         "Missing 'code' query parameter in OAuth callback request.",
492:         "MISSING_OAUTH_CODE"
493:       );
494:     }
495: 
496:     const redirectUri = url.searchParams.get("redirect_uri") ?? undefined;
497: 
498:     const result = await this.client.oauth.v2.access({
499:       client_id: this.clientId,
500:       client_secret: this.clientSecret,
501:       code,
502:       redirect_uri: redirectUri,
503:     });
504: 
505:     if (!(result.ok && result.access_token && result.team?.id)) {
506:       throw new ChatError(
507:         `Slack OAuth failed: ${result.error || "missing access_token or team.id"}`,
508:         "OAUTH_FAILED"
509:       );
510:     }
511: 
512:     const teamId = result.team.id;
513:     const installation: SlackInstallation = {
514:       botToken: result.access_token,
515:       botUserId: result.bot_user_id,
516:       teamName: result.team.name,
517:     };
518: 
519:     await this.setInstallation(teamId, installation);
520: 
521:     return { teamId, installation };
522:   }
523: 
524:   /**
525:    * Remove a Slack workspace installation.
526:    */
527:   async deleteInstallation(teamId: string): Promise<void> {
528:     if (!this.chat) {
529:       throw new ChatError(
530:         "Adapter not initialized. Ensure chat.initialize() has been called first.",
531:         "NOT_INITIALIZED"
532:       );
533:     }
534: 
535:     const state = this.chat.getState();
536:     await state.delete(this.installationKey(teamId));
537:     this.logger.info("Slack installation deleted", { teamId });
538:   }
539: 
540:   /**
541:    * Run a function with a specific bot token in context.
542:    * Use this for operations outside webhook handling (cron jobs, workflows).
543:    */
544:   withBotToken<T>(token: string, fn: () => T): T {
545:     return this.requestContext.run({ token }, fn);
546:   }
547: 
548:   // ===========================================================================
549:   // Private helpers
550:   // ===========================================================================
551: 
552:   /**
553:    * Resolve the bot token for a team from the state adapter.
554:    */
555:   private async resolveTokenForTeam(
556:     teamId: string
557:   ): Promise<{ token: string; botUserId?: string } | null> {
558:     try {
559:       const installation = await this.getInstallation(teamId);
560:       if (installation) {
561:         return {
562:           token: installation.botToken,
563:           botUserId: installation.botUserId,
564:         };
565:       }
566:       this.logger.warn("No installation found for team", { teamId });
567:       return null;
568:     } catch (error) {
569:       this.logger.error("Failed to resolve token for team", {
570:         teamId,
571:         error,
572:       });
573:       return null;
574:     }
575:   }
576: 
577:   /**
578:    * Extract team_id from an interactive payload (form-urlencoded).
579:    */
580:   private extractTeamIdFromInteractive(body: string): string | null {
581:     try {
582:       const params = new URLSearchParams(body);
583:       const payloadStr = params.get("payload");
584:       if (!payloadStr) {
585:         return null;
586:       }
587:       const payload = JSON.parse(payloadStr);
588:       return payload.team?.id || payload.team_id || null;
589:     } catch {
590:       return null;
591:     }
592:   }
593: 
594:   /**
595:    * Look up user info from Slack API with caching via state adapter.
596:    * Returns display name and real name, or falls back to user ID.
597:    */
598:   private async lookupUser(
599:     userId: string
600:   ): Promise<{ displayName: string; realName: string }> {
601:     const cacheKey = `slack:user:${userId}`;
602: 
603:     // Check cache first (via state adapter for serverless compatibility)
604:     if (this.chat) {
605:       const cached = await this.chat.getState().get<CachedUser>(cacheKey);
606:       if (cached) {
607:         return { displayName: cached.displayName, realName: cached.realName };
608:       }
609:     }
610: 
611:     try {
612:       const result = await this.client.users.info(
613:         this.withToken({ user: userId })
614:       );
615:       const user = result.user as {
616:         name?: string;
617:         real_name?: string;
618:         profile?: { display_name?: string; real_name?: string };
619:       };
620: 
621:       // Slack user naming: profile.display_name > profile.real_name > real_name > name > userId
622:       const displayName =
623:         user?.profile?.display_name ||
624:         user?.profile?.real_name ||
625:         user?.real_name ||
626:         user?.name ||
627:         userId;
628:       const realName =
629:         user?.real_name || user?.profile?.real_name || displayName;
630: 
631:       // Cache the result via state adapter
632:       if (this.chat) {
633:         await this.chat
634:           .getState()
635:           .set<CachedUser>(
636:             cacheKey,
637:             { displayName, realName },
638:             SlackAdapter.USER_CACHE_TTL_MS
639:           );
640:       }
641: 
642:       this.logger.debug("Fetched user info", {
643:         userId,
644:         displayName,
645:         realName,
646:       });
647:       return { displayName, realName };
648:     } catch (error) {
649:       this.logger.warn("Could not fetch user info", { userId, error });
650:       // Fall back to user ID
651:       return { displayName: userId, realName: userId };
652:     }
653:   }
654: 
655:   async handleWebhook(
656:     request: Request,
657:     options?: WebhookOptions
658:   ): Promise<Response> {
659:     const body = await request.text();
660:     this.logger.debug("Slack webhook raw body", { body });
661: 
662:     // Verify request signature
663:     const timestamp = request.headers.get("x-slack-request-timestamp");
664:     const signature = request.headers.get("x-slack-signature");
665: 
666:     if (!this.verifySignature(body, timestamp, signature)) {
667:       return new Response("Invalid signature", { status: 401 });
668:     }
669: 
670:     // Check if this is a form-urlencoded payload
671:     const contentType = request.headers.get("content-type") || "";
672:     if (contentType.includes("application/x-www-form-urlencoded")) {
673:       const params = new URLSearchParams(body);
674:       if (params.has("command") && !params.has("payload")) {
675:         const teamId = params.get("team_id");
676:         if (!this.defaultBotToken && teamId) {
677:           const ctx = await this.resolveTokenForTeam(teamId);
678:           if (ctx) {
679:             return this.requestContext.run(ctx, () =>
680:               this.handleSlashCommand(params, options)
681:             );
682:           }
683:           this.logger.warn("Could not resolve token for slash command");
684:         }
685:         return this.handleSlashCommand(params, options);
686:       }
687:       // In multi-workspace mode, resolve token before processing
688:       if (!this.defaultBotToken) {
689:         const teamId = this.extractTeamIdFromInteractive(body);
690:         if (teamId) {
691:           const ctx = await this.resolveTokenForTeam(teamId);
692:           if (ctx) {
693:             return this.requestContext.run(ctx, () =>
694:               this.handleInteractivePayload(body, options)
695:             );
696:           }
697:         }
698:         this.logger.warn("Could not resolve token for interactive payload");
699:       }
700:       return this.handleInteractivePayload(body, options);
701:     }
702: 
703:     // Parse the JSON payload
704:     let payload: SlackWebhookPayload;
705:     try {
706:       payload = JSON.parse(body);
707:     } catch {
708:       return new Response("Invalid JSON", { status: 400 });
709:     }
710: 
711:     // Handle URL verification challenge (no token needed)
712:     if (payload.type === "url_verification" && payload.challenge) {
713:       return Response.json({ challenge: payload.challenge });
714:     }
715: 
716:     // In multi-workspace mode, resolve token from team_id before processing events
717:     if (!this.defaultBotToken && payload.type === "event_callback") {
718:       const teamId = payload.team_id;
719:       if (teamId) {
720:         const ctx = await this.resolveTokenForTeam(teamId);
721:         if (ctx) {
722:           return this.requestContext.run(ctx, () => {
723:             this.processEventPayload(payload, options);
724:             return new Response("ok", { status: 200 });
725:           });
726:         }
727:         this.logger.warn("Could not resolve token for team", { teamId });
728:         return new Response("ok", { status: 200 });
729:       }
730:     }
731: 
732:     // Single-workspace mode or fallback
733:     this.processEventPayload(payload, options);
734:     return new Response("ok", { status: 200 });
735:   }
736: 
737:   /** Extract and dispatch events from a validated payload */
738:   private processEventPayload(
739:     payload: SlackWebhookPayload,
740:     options?: WebhookOptions
741:   ): void {
742:     if (payload.type === "event_callback" && payload.event) {
743:       const event = payload.event;
744: 
745:       if (event.type === "message" || event.type === "app_mention") {
746:         const slackEvent = event as SlackEvent;
747:         if (!(slackEvent.team || slackEvent.team_id) && payload.team_id) {
748:           slackEvent.team_id = payload.team_id;
749:         }
750:         this.handleMessageEvent(slackEvent, options);
751:       } else if (
752:         event.type === "reaction_added" ||
753:         event.type === "reaction_removed"
754:       ) {
755:         this.handleReactionEvent(event as SlackReactionEvent, options);
756:       } else if (event.type === "assistant_thread_started") {
757:         this.handleAssistantThreadStarted(
758:           event as SlackAssistantThreadStartedEvent,
759:           options
760:         );
761:       } else if (event.type === "assistant_thread_context_changed") {
762:         this.handleAssistantContextChanged(
763:           event as SlackAssistantContextChangedEvent,
764:           options
765:         );
766:       } else if (
767:         event.type === "app_home_opened" &&
768:         (event as SlackAppHomeOpenedEvent).tab === "home"
769:       ) {
770:         this.handleAppHomeOpened(event as SlackAppHomeOpenedEvent, options);
771:       }
772:     }
773:   }
774: 
775:   /**
776:    * Handle Slack interactive payloads (button clicks, view submissions, etc.).
777:    * These are sent as form-urlencoded with a `payload` JSON field.
778:    */
779:   private handleInteractivePayload(
780:     body: string,
781:     options?: WebhookOptions
782:   ): Response | Promise<Response> {
783:     const params = new URLSearchParams(body);
784:     const payloadStr = params.get("payload");
785: 
786:     if (!payloadStr) {
787:       return new Response("Missing payload", { status: 400 });
788:     }
789: 
790:     let payload: SlackInteractivePayload;
791:     try {
792:       payload = JSON.parse(payloadStr);
793:     } catch {
794:       return new Response("Invalid payload JSON", { status: 400 });
795:     }
796: 
797:     switch (payload.type) {
798:       case "block_actions":
799:         this.handleBlockActions(payload, options);
800:         return new Response("", { status: 200 });
801: 
802:       case "view_submission":
803:         return this.handleViewSubmission(payload, options);
804: 
805:       case "view_closed":
806:         this.handleViewClosed(payload, options);
807:         return new Response("", { status: 200 });
808: 
809:       default:
810:         return new Response("", { status: 200 });
811:     }
812:   }
813: 
814:   /**
815:    * Handle Slack slash command payloads.
816:    * Slash commands are sent as form-urlencoded with command, text, user_id, channel_id, etc.
817:    */
818:   private async handleSlashCommand(
819:     params: URLSearchParams,
820:     options?: WebhookOptions
821:   ): Promise<Response> {
822:     if (!this.chat) {
823:       this.logger.warn("Chat instance not initialized, ignoring slash command");
824:       return new Response("", { status: 200 });
825:     }
826: 
827:     const command = params.get("command") || "";
828:     const text = params.get("text") || "";
829:     const userId = params.get("user_id") || "";
830:     const channelId = params.get("channel_id") || "";
831:     const triggerId = params.get("trigger_id") || undefined;
832: 
833:     this.logger.debug("Processing Slack slash command", {
834:       command,
835:       text,
836:       userId,
837:       channelId,
838:       triggerId,
839:     });
840:     const userInfo = await this.lookupUser(userId);
841:     const event = {
842:       command,
843:       text,
844:       user: {
845:         userId,
846:         userName: userInfo.displayName,
847:         fullName: userInfo.realName,
848:         isBot: false,
849:         isMe: false,
850:       },
851:       adapter: this as Adapter,
852:       raw: Object.fromEntries(params),
853:       triggerId,
854:       channelId: channelId ? `slack:${channelId}` : "",
855:     };
856:     this.chat.processSlashCommand(event, options);
857:     return new Response("", { status: 200 });
858:   }
859: 
860:   /**
861:    * Handle block_actions payload (button clicks in Block Kit).
862:    */
863:   private handleBlockActions(
864:     payload: SlackBlockActionsPayload,
865:     options?: WebhookOptions
866:   ): void {
867:     if (!this.chat) {
868:       this.logger.warn("Chat instance not initialized, ignoring action");
869:       return;
870:     }
871: 
872:     const channel = payload.channel?.id || payload.container?.channel_id;
873:     const messageTs = payload.message?.ts || payload.container?.message_ts;
874:     const threadTs =
875:       payload.message?.thread_ts || payload.container?.thread_ts || messageTs;
876: 
877:     // Actions from Home tab views don't have channel/messageTs
878:     const isViewAction = payload.container?.type === "view";
879: 
880:     if (!(isViewAction || channel)) {
881:       this.logger.warn("Missing channel in block_actions", { channel });
882:       return;
883:     }
884: 
885:     const threadId =
886:       channel && (threadTs || messageTs)
887:         ? this.encodeThreadId({
888:             channel,
889:             threadTs: threadTs || messageTs || "",
890:           })
891:         : "";
892: 
893:     const isEphemeral = payload.container?.is_ephemeral === true;
894:     const responseUrl = payload.response_url;
895:     const messageId =
896:       isEphemeral && responseUrl && messageTs
897:         ? this.encodeEphemeralMessageId(messageTs, res
...(truncated)
```


*Completed in 6.7s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Let me read the rest of the Slack adapter to see streaming and remaining features:

> ⚠️ **Large tool output** (41,351 chars, truncated to 30,000)

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src/index.ts
offset: 1812

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src/index.ts</path>
<type>file</type>
<content>1812:         this.withToken({
1813:           view_id: viewId,
1814:           view,
1815:         })
1816:       );
1817: 
1818:       this.logger.debug("Slack API: views.update response", {
1819:         viewId: result.view?.id,
1820:         ok: result.ok,
1821:       });
1822: 
1823:       return { viewId: result.view?.id as string };
1824:     } catch (error) {
1825:       this.handleSlackError(error);
1826:     }
1827:   }
1828: 
1829:   /**
1830:    * Upload files to Slack and share them to a channel.
1831:    * Returns the file IDs of uploaded files.
1832:    */
1833:   private async uploadFiles(
1834:     files: FileUpload[],
1835:     channel: string,
1836:     threadTs?: string
1837:   ): Promise<string[]> {
1838:     const bufferResults = await Promise.all(
1839:       files.map(async (file) => {
1840:         try {
1841:           const fileBuffer = await toBuffer(file.data, { platform: "slack" });
1842:           if (!fileBuffer) {
1843:             return null;
1844:           }
1845:           return { file: fileBuffer, filename: file.filename };
1846:         } catch (error) {
1847:           this.logger.error("Failed to convert file to buffer", {
1848:             filename: file.filename,
1849:             error,
1850:           });
1851:           return null;
1852:         }
1853:       })
1854:     );
1855:     const fileUploads = bufferResults.filter(
1856:       (result): result is NonNullable<typeof result> => result !== null
1857:     );
1858:     if (fileUploads.length === 0) {
1859:       return [];
1860:     }
1861:     this.logger.debug("Slack API: files.uploadV2 (batch)", {
1862:       fileCount: fileUploads.length,
1863:       filenames: fileUploads.map((f) => f.filename),
1864:     });
1865: 
1866:     // biome-ignore lint/suspicious/noExplicitAny: Slack API types don't match actual usage
1867:     const uploadArgs: any = { channel_id: channel, file_uploads: fileUploads };
1868:     if (threadTs) {
1869:       uploadArgs.thread_ts = threadTs;
1870:     }
1871:     uploadArgs.token = this.getToken();
1872:     const result = (await this.client.files.uploadV2(uploadArgs)) as {
1873:       ok: boolean;
1874:       files?: Array<{ files?: Array<{ id?: string }> }>;
1875:     };
1876:     this.logger.debug("Slack API: files.uploadV2 response", { ok: result.ok });
1877:     const fileIds: string[] = [];
1878:     if (result.files?.[0]?.files) {
1879:       for (const uploadedFile of result.files[0].files) {
1880:         if (uploadedFile.id) {
1881:           fileIds.push(uploadedFile.id);
1882:         }
1883:       }
1884:     }
1885: 
1886:     return fileIds;
1887:   }
1888: 
1889:   async editMessage(
1890:     threadId: string,
1891:     messageId: string,
1892:     message: AdapterPostableMessage
1893:   ): Promise<RawMessage<unknown>> {
1894:     const ephemeral = this.decodeEphemeralMessageId(messageId);
1895:     if (ephemeral) {
1896:       const { threadTs } = this.decodeThreadId(threadId);
1897:       const result = await this.sendToResponseUrl(
1898:         ephemeral.responseUrl,
1899:         "replace",
1900:         {
1901:           message,
1902:           threadTs,
1903:         }
1904:       );
1905:       return {
1906:         id: ephemeral.messageTs,
1907:         threadId,
1908:         raw: { ephemeral: true, ...result },
1909:       };
1910:     }
1911: 
1912:     const { channel } = this.decodeThreadId(threadId);
1913: 
1914:     try {
1915:       // Check if message contains a card
1916:       const card = extractCard(message);
1917: 
1918:       if (card) {
1919:         // Render card as Block Kit
1920:         const blocks = cardToBlockKit(card);
1921:         const fallbackText = cardToFallbackText(card);
1922: 
1923:         this.logger.debug("Slack API: chat.update (blocks)", {
1924:           channel,
1925:           messageId,
1926:           blockCount: blocks.length,
1927:         });
1928: 
1929:         const result = await this.client.chat.update(
1930:           this.withToken({
1931:             channel,
1932:             ts: messageId,
1933:             text: fallbackText,
1934:             blocks,
1935:           })
1936:         );
1937: 
1938:         this.logger.debug("Slack API: chat.update response", {
1939:           messageId: result.ts,
1940:           ok: result.ok,
1941:         });
1942: 
1943:         return {
1944:           id: result.ts as string,
1945:           threadId,
1946:           raw: result,
1947:         };
1948:       }
1949: 
1950:       // Regular text message
1951:       const text = convertEmojiPlaceholders(
1952:         this.formatConverter.renderPostable(message),
1953:         "slack"
1954:       );
1955: 
1956:       this.logger.debug("Slack API: chat.update", {
1957:         channel,
1958:         messageId,
1959:         textLength: text.length,
1960:       });
1961: 
1962:       const result = await this.client.chat.update(
1963:         this.withToken({
1964:           channel,
1965:           ts: messageId,
1966:           text,
1967:         })
1968:       );
1969: 
1970:       this.logger.debug("Slack API: chat.update response", {
1971:         messageId: result.ts,
1972:         ok: result.ok,
1973:       });
1974: 
1975:       return {
1976:         id: result.ts as string,
1977:         threadId,
1978:         raw: result,
1979:       };
1980:     } catch (error) {
1981:       this.handleSlackError(error);
1982:     }
1983:   }
1984: 
1985:   async deleteMessage(threadId: string, messageId: string): Promise<void> {
1986:     const ephemeral = this.decodeEphemeralMessageId(messageId);
1987:     if (ephemeral) {
1988:       await this.sendToResponseUrl(ephemeral.responseUrl, "delete");
1989:       return;
1990:     }
1991:     const { channel } = this.decodeThreadId(threadId);
1992: 
1993:     try {
1994:       this.logger.debug("Slack API: chat.delete", { channel, messageId });
1995: 
1996:       await this.client.chat.delete(
1997:         this.withToken({
1998:           channel,
1999:           ts: messageId,
2000:         })
2001:       );
2002: 
2003:       this.logger.debug("Slack API: chat.delete response", { ok: true });
2004:     } catch (error) {
2005:       this.handleSlackError(error);
2006:     }
2007:   }
2008: 
2009:   async addReaction(
2010:     threadId: string,
2011:     messageId: string,
2012:     emoji: EmojiValue | string
2013:   ): Promise<void> {
2014:     const { channel } = this.decodeThreadId(threadId);
2015:     // Convert emoji (EmojiValue or string) to Slack format, strip colons
2016:     const slackEmoji = defaultEmojiResolver.toSlack(emoji);
2017:     const name = slackEmoji.replace(/:/g, "");
2018: 
2019:     try {
2020:       this.logger.debug("Slack API: reactions.add", {
2021:         channel,
2022:         messageId,
2023:         emoji: name,
2024:       });
2025: 
2026:       await this.client.reactions.add(
2027:         this.withToken({
2028:           channel,
2029:           timestamp: messageId,
2030:           name,
2031:         })
2032:       );
2033: 
2034:       this.logger.debug("Slack API: reactions.add response", { ok: true });
2035:     } catch (error) {
2036:       this.handleSlackError(error);
2037:     }
2038:   }
2039: 
2040:   async removeReaction(
2041:     threadId: string,
2042:     messageId: string,
2043:     emoji: EmojiValue | string
2044:   ): Promise<void> {
2045:     const { channel } = this.decodeThreadId(threadId);
2046:     // Convert emoji (EmojiValue or string) to Slack format, strip colons
2047:     const slackEmoji = defaultEmojiResolver.toSlack(emoji);
2048:     const name = slackEmoji.replace(/:/g, "");
2049: 
2050:     try {
2051:       this.logger.debug("Slack API: reactions.remove", {
2052:         channel,
2053:         messageId,
2054:         emoji: name,
2055:       });
2056: 
2057:       await this.client.reactions.remove(
2058:         this.withToken({
2059:           channel,
2060:           timestamp: messageId,
2061:           name,
2062:         })
2063:       );
2064: 
2065:       this.logger.debug("Slack API: reactions.remove response", { ok: true });
2066:     } catch (error) {
2067:       this.handleSlackError(error);
2068:     }
2069:   }
2070: 
2071:   /**
2072:    * Show typing indicator with optional custom status.
2073:    *
2074:    * When status is provided, uses Slack's assistant.threads.setStatus API
2075:    * to show custom loading text (requires Agents & AI Apps feature and assistant:write scope).
2076:    * The status auto-clears when a message is posted to the thread.
2077:    *
2078:    * When status is not provided, defaults to "Typing..." with default loading messages.
2079:    *
2080:    * @param threadId - The thread to show the indicator in
2081:    * @param status - Optional custom status message (e.g., "Searching documents...")
2082:    */
2083:   async startTyping(threadId: string, status?: string): Promise<void> {
2084:     const { channel, threadTs } = this.decodeThreadId(threadId);
2085:     if (!threadTs) {
2086:       this.logger.debug("Slack: startTyping skipped - no thread context");
2087:       return;
2088:     }
2089:     this.logger.debug("Slack API: assistant.threads.setStatus", {
2090:       channel,
2091:       threadTs,
2092:       status,
2093:     });
2094:     try {
2095:       await this.client.assistant.threads.setStatus(
2096:         this.withToken({
2097:           channel_id: channel,
2098:           thread_ts: threadTs,
2099:           status: status ?? "Typing...",
2100:           loading_messages: [status ?? "Typing..."],
2101:         })
2102:       );
2103:     } catch (error) {
2104:       this.logger.warn("Slack API: assistant.threads.setStatus failed", {
2105:         channel,
2106:         threadTs,
2107:         error,
2108:       });
2109:     }
2110:   }
2111: 
2112:   /**
2113:    * Stream a message using Slack's native streaming API.
2114:    *
2115:    * Consumes an async iterable of text chunks and streams them to Slack.
2116:    * Requires `recipientUserId` and `recipientTeamId` in options.
2117:    */
2118:   async stream(
2119:     threadId: string,
2120:     textStream: AsyncIterable<string>,
2121:     options?: StreamOptions
2122:   ): Promise<RawMessage<unknown>> {
2123:     if (!(options?.recipientUserId && options?.recipientTeamId)) {
2124:       throw new ChatError(
2125:         "Slack streaming requires recipientUserId and recipientTeamId in options",
2126:         "MISSING_STREAM_OPTIONS"
2127:       );
2128:     }
2129:     const { channel, threadTs } = this.decodeThreadId(threadId);
2130:     this.logger.debug("Slack: starting stream", { channel, threadTs });
2131: 
2132:     const token = this.getToken();
2133:     const streamer = this.client.chatStream({
2134:       channel,
2135:       thread_ts: threadTs,
2136:       recipient_user_id: options.recipientUserId,
2137:       recipient_team_id: options.recipientTeamId,
2138:     });
2139: 
2140:     let first = true;
2141:     for await (const chunk of textStream) {
2142:       if (first) {
2143:         // Pass token on first append so the streamer uses it for all subsequent calls
2144:         // biome-ignore lint/suspicious/noExplicitAny: ChatStreamer types don't include token
2145:         await streamer.append({ markdown_text: chunk, token } as any);
2146:         first = false;
2147:       } else {
2148:         await streamer.append({ markdown_text: chunk });
2149:       }
2150:     }
2151:     const result = await streamer.stop(
2152:       // biome-ignore lint/suspicious/noExplicitAny: stopBlocks are platform-specific Block Kit elements
2153:       options?.stopBlocks ? { blocks: options.stopBlocks as any[] } : undefined
2154:     );
2155:     const messageTs = (result.message?.ts ?? result.ts) as string;
2156: 
2157:     this.logger.debug("Slack: stream complete", { messageId: messageTs });
2158: 
2159:     return {
2160:       id: messageTs,
2161:       threadId,
2162:       raw: result,
2163:     };
2164:   }
2165: 
2166:   /**
2167:    * Open a direct message conversation with a user.
2168:    * Returns a thread ID that can be used to post messages.
2169:    */
2170:   async openDM(userId: string): Promise<string> {
2171:     try {
2172:       this.logger.debug("Slack API: conversations.open", { userId });
2173: 
2174:       const result = await this.client.conversations.open(
2175:         this.withToken({ users: userId })
2176:       );
2177: 
2178:       if (!result.channel?.id) {
2179:         throw new NetworkError(
2180:           "slack",
2181:           "Failed to open DM - no channel returned"
2182:         );
2183:       }
2184: 
2185:       const channelId = result.channel.id;
2186: 
2187:       this.logger.debug("Slack API: conversations.open response", {
2188:         channelId,
2189:         ok: result.ok,
2190:       });
2191: 
2192:       // Encode as thread ID (no threadTs for new DM - messages will start new threads)
2193:       return this.encodeThreadId({
2194:         channel: channelId,
2195:         threadTs: "", // Empty threadTs indicates top-level channel messages
2196:       });
2197:     } catch (error) {
2198:       this.handleSlackError(error);
2199:     }
2200:   }
2201: 
2202:   async fetchMessages(
2203:     threadId: string,
2204:     options: FetchOptions = {}
2205:   ): Promise<FetchResult<unknown>> {
2206:     const { channel, threadTs } = this.decodeThreadId(threadId);
2207:     const direction = options.direction ?? "backward";
2208:     const limit = options.limit || 100;
2209: 
2210:     try {
2211:       if (direction === "forward") {
2212:         // Forward direction: fetch oldest messages first, cursor moves to newer
2213:         // Uses native Slack cursor pagination which is efficient
2214:         return await this.fetchMessagesForward(
2215:           channel,
2216:           threadTs,
2217:           threadId,
2218:           limit,
2219:           options.cursor
2220:         );
2221:       }
2222:       // Backward direction: fetch most recent messages first, cursor moves to older
2223:       // Slack API returns oldest-first, so we need to work around this
2224:       return await this.fetchMessagesBackward(
2225:         channel,
2226:         threadTs,
2227:         threadId,
2228:         limit,
2229:         options.cursor
2230:       );
2231:     } catch (error) {
2232:       this.handleSlackError(error);
2233:     }
2234:   }
2235: 
2236:   /**
2237:    * Fetch messages in forward direction (oldest first, efficient).
2238:    * Uses native Slack cursor pagination.
2239:    */
2240:   private async fetchMessagesForward(
2241:     channel: string,
2242:     threadTs: string,
2243:     threadId: string,
2244:     limit: number,
2245:     cursor?: string
2246:   ): Promise<FetchResult<unknown>> {
2247:     this.logger.debug("Slack API: conversations.replies (forward)", {
2248:       channel,
2249:       threadTs,
2250:       limit,
2251:       cursor,
2252:     });
2253: 
2254:     const result = await this.client.conversations.replies(
2255:       this.withToken({
2256:         channel,
2257:         ts: threadTs,
2258:         limit,
2259:         cursor,
2260:       })
2261:     );
2262: 
2263:     const slackMessages = (result.messages || []) as SlackEvent[];
2264:     const nextCursor = (
2265:       result as { response_metadata?: { next_cursor?: string } }
2266:     ).response_metadata?.next_cursor;
2267: 
2268:     this.logger.debug("Slack API: conversations.replies response", {
2269:       messageCount: slackMessages.length,
2270:       ok: result.ok,
2271:       hasNextCursor: !!nextCursor,
2272:     });
2273: 
2274:     const messages = await Promise.all(
2275:       slackMessages.map((msg) => this.parseSlackMessage(msg, threadId))
2276:     );
2277: 
2278:     return {
2279:       messages,
2280:       nextCursor: nextCursor || undefined,
2281:     };
2282:   }
2283: 
2284:   /**
2285:    * Fetch messages in backward direction (most recent first).
2286:    *
2287:    * Slack's API returns oldest-first, so for backward direction we:
2288:    * 1. Use `latest` parameter to fetch messages before a timestamp (cursor)
2289:    * 2. Fetch up to 1000 messages (API limit) and take the last N
2290:    * 3. Return messages in chronological order (oldest first within the page)
2291:    *
2292:    * Note: For very large threads (>1000 messages), the first backward call
2293:    * may not return the absolute most recent messages. This is a Slack API limitation.
2294:    */
2295:   private async fetchMessagesBackward(
2296:     channel: string,
2297:     threadTs: string,
2298:     threadId: string,
2299:     limit: number,
2300:     cursor?: string
2301:   ): Promise<FetchResult<unknown>> {
2302:     // Cursor is a timestamp - fetch messages before this time
2303:     // For the initial call (no cursor), we want the most recent messages
2304:     const latest = cursor || undefined;
2305: 
2306:     this.logger.debug("Slack API: conversations.replies (backward)", {
2307:       channel,
2308:       threadTs,
2309:       limit,
2310:       latest,
2311:     });
2312: 
2313:     // Fetch a larger batch to ensure we can return the last `limit` messages
2314:     // Slack API max is 1000 messages per request
2315:     const fetchLimit = Math.min(1000, Math.max(limit * 2, 200));
2316: 
2317:     const result = await this.client.conversations.replies(
2318:       this.withToken({
2319:         channel,
2320:         ts: threadTs,
2321:         limit: fetchLimit,
2322:         latest,
2323:         inclusive: false, // Don't include the cursor message itself
2324:       })
2325:     );
2326: 
2327:     const slackMessages = (result.messages || []) as SlackEvent[];
2328: 
2329:     this.logger.debug("Slack API: conversations.replies response (backward)", {
2330:       messageCount: slackMessages.length,
2331:       ok: result.ok,
2332:       hasMore: result.has_more,
2333:     });
2334: 
2335:     // If we have more messages than requested, take the last `limit`
2336:     // This gives us the most recent messages
2337:     const startIndex = Math.max(0, slackMessages.length - limit);
2338:     const selectedMessages = slackMessages.slice(startIndex);
2339: 
2340:     const messages = await Promise.all(
2341:       selectedMessages.map((msg) => this.parseSlackMessage(msg, threadId))
2342:     );
2343: 
2344:     // For backward pagination, nextCursor points to older messages
2345:     // Use the timestamp of the oldest message we're NOT returning
2346:     let nextCursor: string | undefined;
2347:     if (startIndex > 0 || result.has_more) {
2348:       // There are more (older) messages available
2349:       // Use the timestamp of the oldest message in our selection as the cursor
2350:       const oldestSelected = selectedMessages[0];
2351:       if (oldestSelected?.ts) {
2352:         nextCursor = oldestSelected.ts;
2353:       }
2354:     }
2355: 
2356:     return {
2357:       messages,
2358:       nextCursor,
2359:     };
2360:   }
2361: 
2362:   async fetchThread(threadId: string): Promise<ThreadInfo> {
2363:     const { channel, threadTs } = this.decodeThreadId(threadId);
2364: 
2365:     try {
2366:       this.logger.debug("Slack API: conversations.info", { channel });
2367: 
2368:       const result = await this.client.conversations.info(
2369:         this.withToken({ channel })
2370:       );
2371:       const channelInfo = result.channel as { name?: string } | undefined;
2372: 
2373:       this.logger.debug("Slack API: conversations.info response", {
2374:         channelName: channelInfo?.name,
2375:         ok: result.ok,
2376:       });
2377: 
2378:       return {
2379:         id: threadId,
2380:         channelId: channel,
2381:         channelName: channelInfo?.name,
2382:         metadata: {
2383:           threadTs,
2384:           channel: result.channel,
2385:         },
2386:       };
2387:     } catch (error) {
2388:       this.handleSlackError(error);
2389:     }
2390:   }
2391: 
2392:   /**
2393:    * Fetch a single message by ID (timestamp).
2394:    */
2395:   async fetchMessage(
2396:     threadId: string,
2397:     messageId: string
2398:   ): Promise<Message<unknown> | null> {
2399:     const { channel, threadTs } = this.decodeThreadId(threadId);
2400: 
2401:     try {
2402:       const result = await this.client.conversations.replies(
2403:         this.withToken({
2404:           channel,
2405:           ts: threadTs,
2406:           oldest: messageId,
2407:           inclusive: true,
2408:           limit: 1,
2409:         })
2410:       );
2411: 
2412:       const messages = (result.messages || []) as SlackEvent[];
2413:       const target = messages.find((msg) => msg.ts === messageId);
2414:       if (!target) {
2415:         return null;
2416:       }
2417: 
2418:       return this.parseSlackMessage(target, threadId);
2419:     } catch (error) {
2420:       this.handleSlackError(error);
2421:     }
2422:   }
2423: 
2424:   encodeThreadId(platformData: SlackThreadId): string {
2425:     return `slack:${platformData.channel}:${platformData.threadTs}`;
2426:   }
2427: 
2428:   /**
2429:    * Check if a thread is a direct message conversation.
2430:    * Slack DM channel IDs start with 'D'.
2431:    */
2432:   isDM(threadId: string): boolean {
2433:     const { channel } = this.decodeThreadId(threadId);
2434:     return channel.startsWith("D");
2435:   }
2436: 
2437:   decodeThreadId(threadId: string): SlackThreadId {
2438:     const parts = threadId.split(":");
2439:     if (parts.length < 2 || parts.length > 3 || parts[0] !== "slack") {
2440:       throw new ValidationError(
2441:         "slack",
2442:         `Invalid Slack thread ID: ${threadId}`
2443:       );
2444:     }
2445:     return {
2446:       channel: parts[1] as string,
2447:       threadTs: parts.length === 3 ? (parts[2] as string) : "",
2448:     };
2449:   }
2450: 
2451:   parseMessage(raw: SlackEvent): Message<unknown> {
2452:     const event = raw;
2453:     const threadTs = event.thread_ts || event.ts || "";
2454:     const threadId = this.encodeThreadId({
2455:       channel: event.channel || "",
2456:       threadTs,
2457:     });
2458:     // Use synchronous version without user lookup for interface compliance
2459:     return this.parseSlackMessageSync(event, threadId);
2460:   }
2461: 
2462:   /**
2463:    * Synchronous message parsing without user lookup.
2464:    * Used for parseMessage interface - falls back to user ID for username.
2465:    */
2466:   private parseSlackMessageSync(
2467:     event: SlackEvent,
2468:     threadId: string
2469:   ): Message<unknown> {
2470:     const isMe = this.isMessageFromSelf(event);
2471: 
2472:     const text = event.text || "";
2473:     // Without async lookup, fall back to user ID for human users
2474:     const userName = event.username || event.user || "unknown";
2475:     const fullName = event.username || event.user || "unknown";
2476: 
2477:     return new Message({
2478:       id: event.ts || "",
2479:       threadId,
2480:       text: this.formatConverter.extractPlainText(text),
2481:       formatted: this.formatConverter.toAst(text),
2482:       raw: event,
2483:       author: {
2484:         userId: event.user || event.bot_id || "unknown",
2485:         userName,
2486:         fullName,
2487:         isBot: !!event.bot_id,
2488:         isMe,
2489:       },
2490:       metadata: {
2491:         dateSent: new Date(Number.parseFloat(event.ts || "0") * 1000),
2492:         edited: !!event.edited,
2493:         editedAt: event.edited
2494:           ? new Date(Number.parseFloat(event.edited.ts) * 1000)
2495:           : undefined,
2496:       },
2497:       attachments: (event.files || []).map((file) =>
2498:         this.createAttachment(file)
2499:       ),
2500:     });
2501:   }
2502: 
2503:   // =========================================================================
2504:   // Channel-level methods
2505:   // =========================================================================
2506: 
2507:   /**
2508:    * Derive channel ID from a Slack thread ID.
2509:    * Slack thread IDs are "slack:CHANNEL:THREAD_TS", channel ID is "slack:CHANNEL".
2510:    */
2511:   channelIdFromThreadId(threadId: string): string {
2512:     const { channel } = this.decodeThreadId(threadId);
2513:     return `slack:${channel}`;
2514:   }
2515: 
2516:   /**
2517:    * Fetch channel-level messages (conversations.history, not thread replies).
2518:    */
2519:   async fetchChannelMessages(
2520:     channelId: string,
2521:     options: FetchOptions = {}
2522:   ): Promise<FetchResult<unknown>> {
2523:     // Channel ID format: "slack:CHANNEL"
2524:     const channel = channelId.split(":")[1];
2525:     if (!channel) {
2526:       throw new ValidationError(
2527:         "slack",
2528:         `Invalid Slack channel ID: ${channelId}`
2529:       );
2530:     }
2531: 
2532:     const direction = options.direction ?? "backward";
2533:     const limit = options.limit || 100;
2534: 
2535:     try {
2536:       if (direction === "forward") {
2537:         return await this.fetchChannelMessagesForward(
2538:           channel,
2539:           limit,
2540:           options.cursor
2541:         );
2542:       }
2543:       return await this.fetchChannelMessagesBackward(
2544:         channel,
2545:         limit,
2546:         options.cursor
2547:       );
2548:     } catch (error) {
2549:       this.handleSlackError(error);
2550:     }
2551:   }
2552: 
2553:   private async fetchChannelMessagesForward(
2554:     channel: string,
2555:     limit: number,
2556:     cursor?: string
2557:   ): Promise<FetchResult<unknown>> {
2558:     this.logger.debug("Slack API: conversations.history (forward)", {
2559:       channel,
2560:       limit,
2561:       cursor,
2562:     });
2563: 
2564:     const result = await this.client.conversations.history(
2565:       this.withToken({
2566:         channel,
2567:         limit,
2568:         oldest: cursor,
2569:         inclusive: cursor ? false : undefined,
2570:       })
2571:     );
2572: 
2573:     const slackMessages = ((result.messages || []) as SlackEvent[]).reverse(); // Slack returns newest-first, we want oldest-first
2574: 
2575:     const messages = await Promise.all(
2576:       slackMessages.map((msg) => {
2577:         const threadTs = msg.thread_ts || msg.ts || "";
2578:         const threadId = `slack:${channel}:${threadTs}`;
2579:         return this.parseSlackMessage(msg, threadId, {
2580:           skipSelfMention: false,
2581:         });
2582:       })
2583:     );
2584: 
2585:     // For forward pagination, cursor points to newer messages
2586:     let nextCursor: string | undefined;
2587:     if (result.has_more && slackMessages.length > 0) {
2588:       const newest = slackMessages.at(-1);
2589:       if (newest?.ts) {
2590:         nextCursor = newest.ts;
2591:       }
2592:     }
2593: 
2594:     return {
2595:       messages,
2596:       nextCursor,
2597:     };
2598:   }
2599: 
2600:   private async fetchChannelMessagesBackward(
2601:     channel: string,
2602:     limit: number,
2603:     cursor?: string
2604:   ): Promise<FetchResult<unknown>> {
2605:     this.logger.debug("Slack API: conversations.history (backward)", {
2606:       channel,
2607:       limit,
2608:       cursor,
2609:     });
2610: 
2611:     const result = await this.client.conversations.history(
2612:       this.withToken({
2613:         channel,
2614:         limit,
2615:         latest: cursor,
2616:         inclusive: cursor ? false : undefined,
2617:       })
2618:     );
2619: 
2620:     const slackMessages = (result.messages || []) as SlackEvent[];
2621:     // Slack returns newest-first for conversations.history; reverse for chronological
2622:     const chronological = [...slackMessages].reverse();
2623: 
2624:     const messages = await Promise.all(
2625:       chronological.map((msg) => {
2626:         const threadTs = msg.thread_ts || msg.ts || "";
2627:         const threadId = `slack:${channel}:${threadTs}`;
2628:         return this.parseSlackMessage(msg, threadId, {
2629:           skipSelfMention: false,
2630:         });
2631:       })
2632:     );
2633: 
2634:     // For backward pagination, cursor points to older messages
2635:     let nextCursor: string | undefined;
2636:     if (result.has_more && chronological.length > 0) {
2637:       const oldest = chronological[0];
2638:       if (oldest?.ts) {
2639:         nextCursor = oldest.ts;
2640:       }
2641:     }
2642: 
2643:     return {
2644:       messages,
2645:       nextCursor,
2646:     };
2647:   }
2648: 
2649:   /**
2650:    * List threads in a Slack channel.
2651:    * Fetches channel history and filters for messages with replies.
2652:    */
2653:   async listThreads(
2654:     channelId: string,
2655:     options: ListThreadsOptions = {}
2656:   ): Promise<ListThreadsResult<unknown>> {
2657:     const channel = channelId.split(":")[1];
2658:     if (!channel) {
2659:       throw new ValidationError(
2660:         "slack",
2661:         `Invalid Slack channel ID: ${channelId}`
2662:       );
2663:     }
2664: 
2665:     const limit = options.limit || 50;
2666: 
2667:     try {
2668:       this.logger.debug("Slack API: conversations.history (listThreads)", {
2669:         channel,
2670:         limit,
2671:         cursor: options.cursor,
2672:       });
2673: 
2674:       const result = await this.client.conversations.history(
2675:         this.withToken({
2676:           channel,
2677:           limit: Math.min(limit * 3, 200), // Fetch extra since not all have threads
2678:           cursor: options.cursor,
2679:         })
2680:       );
2681: 
2682:       const slackMessages = (result.messages || []) as SlackEvent[];
2683: 
2684:       // Filter messages that have replies (they are thread parents)
2685:       const threa
...(truncated)
```


*Completed in 5.1s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Now I have a complete picture. Here's the full analysis:

---

## Common Interface (the `Adapter` contract)

Every platform adapter must implement the `Adapter` interface defined in `packages/chat/src/types.ts`. The core abstractions are:

**`Chat` class** - The central hub. You register event handlers on it:
- `onNewMention(handler)` - bot @-mentioned in an unsubscribed thread
- `onSubscribedMessage(handler)` - any message in a subscribed thread
- `onNewMessage(pattern, handler)` - regex pattern matching
- `onReaction(emoji, handler)` - emoji reactions add/remove
- `onAction(actionId, handler)` - button clicks in cards
- `onSlashCommand(command, handler)` - `/command` invocations
- `onModalSubmit(callbackId, handler)` - modal form submissions
- `onModalClose(callbackId, handler)` - modal dismissed

**`Thread`** - Represents a conversation. Key methods:
- `post(message)` - post text, markdown, JSX cards, or `AsyncIterable<string>` for streaming
- `subscribe()` / `unsubscribe()` - watch for follow-up messages
- `startTyping(status?)` - typing indicator
- `postEphemeral(user, message)` - user-only visible messages
- `setState()` / `state` - per-thread persistent state
- `messages` / `allMessages` - async iterators over history
- `mentionUser(userId)` - cross-platform @-mention string

**`Message`** - Normalized message with `text`, `formatted` (mdast AST), `raw` (platform escape hatch), `author`, `metadata`, `attachments`, and `isMention`.

**Cards** - JSX-based rich UI: `Card`, `Text`, `Button`, `LinkButton`, `Actions`, `Fields`, `Image`, `Divider`, `Section`. Rendered natively per platform (Block Kit, Embeds, Adaptive Cards).

**Modals** - Form dialogs with `TextInput`, `Select`, `RadioSelect`. Opened via `event.openModal()`.

**Formatting** - mdast AST as canonical format. Each adapter has a `FormatConverter` that converts to/from platform-specific markdown.

---

## Discord Adapter - What It Can Do

File: `packages/adapter-discord/src/index.ts` (2131 lines)

| Feature | Supported | Notes |
|---------|-----------|-------|
| **Mentions** | Yes | User mentions + configurable role mentions |
| **Reactions** | Yes | Add, remove, normalize unicode emoji |
| **Cards/Embeds** | Yes | Cards render as Discord Embeds + Action Rows |
| **Buttons** | Yes | Via message components (custom_id) |
| **Streaming** | **No native** | Falls back to post + edit |
| **Modals** | **No** | `openModal` not implemented |
| **Slash commands** | **Partial** | HTTP Interactions receive them, but just ACKs with deferred response |
| **Ephemeral messages** | **No native** | Falls back to DM |
| **DMs** | Yes | Via `openDM(userId)` |
| **File uploads** | Yes | multipart/form-data |
| **Threads** | Yes | Auto-creates threads on mention |
| **Fetch messages** | Yes | Paginated, both directions |
| **List threads** | Yes | Active + archived |
| **Channel info** | Yes | Via REST API |
| **Typing indicator** | Yes | POST to `/typing` endpoint |
| **Assistant API** | **No** | Slack-only feature |
| **App Home** | **No** | Slack-only feature |
| **Multi-workspace** | **No** | Single bot token |

### How Discord connects

The Discord adapter has **two modes**:

1. **HTTP Interactions** (primary) - Receives webhooks, verifies Ed25519 signatures, handles PING, button clicks. This is the serverless-compatible path.

2. **Gateway WebSocket** (optional) - `startGatewayListener()` uses `discord.js` `Client` with full Gateway intents. It can either process events directly **or** forward them as HTTP POST to the webhook endpoint. This is a time-limited listener (default 3 minutes) designed for serverless workarounds via `waitUntil`.

So yes, **the SDK does support WebSocket connections for Discord**, but it's not the default path. The Gateway listener is designed as a bridge that forwards events to the webhook handler.

---

## Slack Adapter - What It Can Do

File: `packages/adapter-slack/src/index.ts` (3007 lines)

| Feature | Supported | Notes |
|---------|-----------|-------|
| **Mentions** | Yes | `@bot` + `app_mention` events + DMs auto-mention |
| **Reactions** | Yes | Full `reaction_added`/`reaction_removed` |
| **Cards** | Yes | Block Kit with full card system |
| **Buttons** | Yes | `block_actions` with trigger IDs |
| **Streaming** | **Yes, native** | `client.chatStream()` - Slack's streaming API |
| **Modals** | **Yes** | `views.open`, `views.update`, submit/close/push/errors |
| **Slash commands** | **Yes** | Full support with `openModal` from commands |
| **Ephemeral messages** | **Yes, native** | `chat.postEphemeral` |
| **DMs** | Yes | `conversations.open` |
| **File uploads** | Yes | `files.uploadV2` |
| **Threads** | Yes | Via `thread_ts` |
| **Fetch messages** | Yes | `conversations.replies` + `conversations.history` |
| **List threads** | Yes | Filter channel history for threaded messages |
| **Channel info** | Yes | `conversations.info` |
| **Typing indicator** | Yes | `assistant.threads.setStatus` with custom status text |
| **Assistant API** | **Yes** | `assistant_thread_started`, context changes, suggested prompts, titles |
| **App Home** | **Yes** | `app_home_opened` + `views.publish` |
| **Multi-workspace** | **Yes** | OAuth V2 flow, encrypted token storage, per-team resolution |
| **User lookup** | **Yes** | Cached `users.info` for display names |

---

## Slack Is Significantly More Powerful

**Slack is clearly the most complete adapter.** It has roughly 50% more code (3007 vs 2131 lines) and implements several features Discord doesn't:

1. **Native streaming** - Slack has `chatStream()` which streams tokens to the user in real-time. Discord falls back to posting a placeholder then editing it every 500ms.

2. **Modals** - Slack has full modal lifecycle: open, update, push (stack modals), close, and validation errors returned to the UI. Discord has zero modal support.

3. **Native ephemeral messages** - Slack can send messages only one user sees. Discord must fall back to DMs.

4. **Assistants API** - Slack has a first-class AI assistant integration with thread started/context changed events, suggested prompts, custom typing status text, and thread titles. Discord has nothing equivalent.

5. **App Home** - Slack bots can render custom home tabs. Not applicable to Discord.

6. **Multi-workspace OAuth** - Slack adapter supports installing to multiple workspaces with encrypted token storage. Discord is single-bot.

---

## Why Discord Is Limited - Is It Because of WebSockets?

**Partially yes, but it's more nuanced.** The real reasons:

1. **Discord's Interactions API is limited by design.** HTTP Interactions (webhooks) only receive slash commands and message component interactions (button clicks). They **do not receive regular messages or reactions** via webhook. To get those, you need the Gateway WebSocket.

2. **The chat SDK is webhook-first** for serverless compatibility (Next.js, Vercel Functions). Slack's Events API sends everything via HTTP webhooks (messages, reactions, mentions). Discord requires a persistent WebSocket connection for the same data. The SDK works around this with the `startGatewayListener()` bridge, but it's a workaround, not a first-class integration.

3. **Discord's API has no equivalents for some features.** Discord doesn't have native ephemeral messages in threads (only in interaction responses), no modal forms outside slash command/component interactions, no streaming API, no assistant-style APIs.

4. **Slack's API is richer for bots.** Slack was built with bot/app integrations as a core feature. Block Kit, views, ephemeral messages, slash commands, the Assistants API - these are all first-class Slack features with dedicated API endpoints. Discord's bot API grew more organically around the Gateway.

The SDK **does support WebSockets** via the Gateway listener, but it's designed as a temporary bridge (runs for N minutes, then disconnects). A production Discord bot would typically run a persistent Gateway connection outside the chat SDK and forward events to the webhook endpoint, which is exactly what the `webhookUrl` forwarding mode enables.


*Completed in 53.4s*

### 👤 User

Voice message transcription from Discord user:

Don't use tasks.


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Got it, I won't use task agents. Noted for future reference.


*Completed in 4.3s*

### 👤 User

Voice message transcription from Discord user:

Is there a way to disable this limit of three minutes and instead use the WebSocket gateway as the main way to receive events and basically keep it alive forever?


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

<details>
<summary>💭 Thinking</summary>

The user is asking if the Discord adapter's Gateway WebSocket listener can be kept alive indefinitely instead of the 3-minute default timeout. Let me look at the relevant code again.

From what I read, the `startGatewayListener` method accepts a `durationMs` parameter that defaults to 180000 (3 minutes). The listener runs for that duration then disconnects. The key question is whether you could just pass a very large duration or `Infinity`.

Let me look at the code more carefully:

```typescript
async startGatewayListener(
    options: WebhookOptions,
    durationMs = 180000,


```

Setting up the listener with timeout handling...

So it uses `setTimeout(resolve, durationMs)` with an optional abort signal that can interrupt the timeout early. This means passing `Infinity` would theoretically work since JavaScript's `setTimeout` can handle very large numbers, though there might be practical limits depending on the runtime environment.

The real issue here is that this whole pattern is built around serverless constraints—the `waitUntil` mechanism is specifically for keeping Vercel Functions or Next.js `after()` handlers alive during their execution window. In a traditional persistent server, you wouldn't need this at all and could just invoke the listener directly. But since `runGatewayListener` is private, you're stuck working within this framework.

The method also requires `options.waitUntil` to be provided or it throws a 500 error, so there's no way around that requirement. Technically you could pass an enormous `durationMs` value, but the architecture is fundamentally designed for serverless environments where the function needs to stay alive for a specific duration. For a persistent process, you'd either need to pass a very large duration or find another way to keep the listener running.

</details>

Yes, technically you can - the `durationMs` is just a parameter with a default value. Looking at `adapter-discord/src/index.ts:1240`:

```ts
async startGatewayListener(
    options: WebhookOptions,
    durationMs = 180000,  // just a default
    abortSignal?: AbortSignal,
    webhookUrl?: string
): Promise<Response>
```

The timeout is a plain `setTimeout(resolve, durationMs)` - you could pass `Infinity` or `Number.MAX_SAFE_INTEGER` and it would never resolve, keeping the Gateway alive forever.

**But there's a design friction.** The method requires `options.waitUntil` or it returns a 500 error. That `waitUntil` pattern is specifically for serverless (Vercel Functions, Next.js `after()`). In a long-running server process, you'd have to provide a dummy `waitUntil`:

```ts
adapter.startGatewayListener(
  { waitUntil: (p) => { p.catch(console.error) } },
  Number.MAX_SAFE_INTEGER,
  undefined,
  webhookUrl
)
```

**The bigger issue** is there's no reconnection logic. The Gateway listener creates a single `discord.js` Client, and if the WebSocket disconnects (network blip, Discord restarts, etc.), `runGatewayListener` is a private method - there's no built-in retry loop. discord.js itself handles heartbeating and some reconnection, but the chat SDK wraps it in a fire-once pattern.

**For a persistent bot**, the intended architecture is actually the **webhook forwarding mode**: you run your own discord.js bot separately (with proper reconnection, sharding, etc.) and forward raw Gateway events to the chat SDK's webhook endpoint using the `x-discord-gateway-token` header. The chat SDK's `handleForwardedGatewayEvent` processes `GATEWAY_MESSAGE_CREATE`, `GATEWAY_MESSAGE_REACTION_ADD`, and `GATEWAY_MESSAGE_REACTION_REMOVE`. That's the production-grade path - it decouples the long-lived WebSocket from the SDK's request-based processing model.

So the answer is: you *can* disable the limit, but for anything serious you'd want to run the Gateway externally and forward events in. The 3-minute listener is really a serverless stopgap, not a production Gateway client.


*Completed in 25.7s*

### 👤 User

Voice message transcription from Discord user:

What do you mean forward event via webhook?


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**



Looking at the Discord adapter code, the webhook handler has a special branch that accepts **Gateway events forwarded as HTTP POST requests**.

Here's how it works:

## 1. Your own bot process receives Gateway events

You run a standalone discord.js bot (or any WebSocket client) that stays connected to Discord's Gateway permanently. When it receives events like `MESSAGE_CREATE` or `MESSAGE_REACTION_ADD`, instead of processing them itself, it forwards them.

## 2. It POSTs them to the chat SDK's webhook endpoint

Your bot sends an HTTP POST to the same webhook URL that handles Discord Interactions, but with a special header and a wrapped payload:

```ts
// Your external Gateway bot does this:
await fetch("https://your-app.com/api/discord", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-discord-gateway-token": "your-secret-token"
  },
  body: JSON.stringify({
    type: "GATEWAY_MESSAGE_CREATE",
    timestamp: Date.now(),
    data: {
      id: message.id,
      content: message.content,
      channel_id: message.channelId,
      guild_id: message.guildId,
      author: { id: author.id, username: author.username, bot: false },
      mentions: [...],
      // raw Gateway event fields
    }
  })
})
```

## 3. The chat SDK processes it like a native event

In the adapter's `handleWebhook`, there's a check around line 350:

```ts
// Check for forwarded Gateway events
const gatewayToken = request.headers.get("x-discord-gateway-token");
if (gatewayToken) {
  return this.handleForwardedGatewayEvent(request, gatewayToken, options);
}
```

It validates the token, parses the event type (`GATEWAY_MESSAGE_CREATE`, `GATEWAY_MESSAGE_REACTION_ADD`, `GATEWAY_MESSAGE_REACTION_REMOVE`), and feeds it into the same `processMessage` / `processReaction` pipeline that the built-in Gateway listener would use.

## Why this design

```
┌──────────────────────┐         HTTP POST          ┌───────────────────┐
│  Your Gateway bot    │  ─────────────────────────> │  Chat SDK webhook │
│  (persistent process │  x-discord-gateway-token    │  (serverless OK)  │
│   with reconnection, │                             │                   │
│   sharding, etc.)    │                             │  Processes events │
└──────────────────────┘                             │  same as native   │
        │                                            └───────────────────┘
        │ WebSocket
        ▼
┌──────────────────────┐
│  Discord Gateway     │
└──────────────────────┘
```

The benefit is separation of concerns. The WebSocket client can be a tiny, robust, always-on process that just relays raw JSON. The actual business logic (mention detection, thread management, card rendering, etc.) stays in the chat SDK's serverless-friendly webhook handler. You get persistent Gateway connectivity without the chat SDK needing to manage WebSocket lifecycle, reconnection, or sharding itself.

The built-in `startGatewayListener` actually uses this exact same forwarding pattern internally when you pass a `webhookUrl` - it spins up a discord.js Client and POSTs events to that URL. The difference is you'd run that client externally with proper process management instead of as a temporary serverless extension.


*Completed in 20.1s*

### 👤 User

Voice message transcription from Discord user:

What is the format of these kind of webhook events? Is this a Chat SDK specific protocol?


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**



Yes, it's a **chat SDK-specific protocol**. It's not a Discord standard - Discord has no concept of "forward Gateway events via HTTP." The chat SDK invented this format.

Let me show you the exact shapes from the types file at `adapter-discord/src/types.ts:180-284`:

## The envelope

Every forwarded event has this structure:

```ts
interface DiscordForwardedEvent {
  type: DiscordGatewayEventType;  // "GATEWAY_MESSAGE_CREATE", etc.
  timestamp: number;               // Unix ms when event was received
  data: unknown;                   // Shape varies by event type
}
```

The `type` is always prefixed with `GATEWAY_` followed by the Discord event name. Three types have specific handlers, but the protocol accepts **any** Gateway event:

```ts
type DiscordGatewayEventType =
  | "GATEWAY_MESSAGE_CREATE"
  | "GATEWAY_MESSAGE_REACTION_ADD"
  | "GATEWAY_MESSAGE_REACTION_REMOVE"
  | `GATEWAY_${string}`;  // any other event passes through
```

## GATEWAY_MESSAGE_CREATE data

```ts
interface DiscordGatewayMessageData {
  id: string;
  content: string;
  channel_id: string;
  guild_id: string | null;
  channel_type?: number;        // 11 = public thread, 12 = private
  author: {
    id: string;
    username: string;
    global_name?: string;
    bot: boolean;
  };
  mentions: Array<{ id: string; username: string }>;
  mention_roles?: string[];
  is_mention?: boolean;         // pre-computed by the forwarder
  attachments: Array<{
    id: string;
    url: string;
    filename: string;
    content_type?: string;
    size: number;
  }>;
  timestamp: string;            // ISO string
  thread?: {
    id: string;
    parent_id: string;
  };
}
```

## GATEWAY_MESSAGE_REACTION_ADD / REMOVE data

```ts
interface DiscordGatewayReactionData {
  channel_id: string;
  message_id: string;
  user_id: string;
  guild_id: string | null;
  emoji: {
    name: string | null;
    id: string | null;
  };
  member?: {
    user: {
      id: string;
      username: string;
      global_name?: string;
      bot?: boolean;
    };
  };
  user?: {                      // present for DMs
    id: string;
    username: string;
    bot?: boolean;
  };
}
```

## Authentication

It uses a shared secret in the `x-discord-gateway-token` header. No Ed25519 signature verification like the normal Discord Interactions webhook - just a plain token comparison. The adapter checks:

```ts
const gatewayToken = request.headers.get("x-discord-gateway-token");
```

This means you'd set the same secret in both your Gateway forwarder and the chat SDK config, and that's all the auth there is. It's designed for internal service-to-service communication, not public endpoints.

## Unhandled event types

Any `GATEWAY_${string}` event that isn't one of the three above just gets silently ignored with a debug log. The protocol is extensible though - the chat SDK could add handlers for `GATEWAY_MESSAGE_UPDATE`, `GATEWAY_CHANNEL_CREATE`, etc. in the future without changing the envelope format.

So to summarize: entirely custom protocol, loosely mirrors Discord's Gateway event shapes but flattened/simplified for the SDK's needs, authenticated by a shared token.


*Completed in 19.1s*

### 👤 User

Voice message transcription from Discord user:

Can you find a markdown file or document that explains this kind of setup of using a gateway that forwards POST requests as webhooks?


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: grep

**Input:**
```yaml
pattern: gateway.*forward|forward.*gateway|webhook.*forward|GATEWAY_MESSAGE_CREATE
include: '*.md'
path: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat

```

**Output:**
```
No files found
```

#### 🛠️ Tool: glob

**Input:**
```yaml
pattern: '**/*.md'
path: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat

```

**Output:**
```
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/skills/chat/SKILL.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/state-redis/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/state-redis/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/state-memory/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/state-memory/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/state-ioredis/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/state-ioredis/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/integration-tests/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/integration-tests/fixtures/replay/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/chat/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-telegram/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-telegram/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-teams/sample-messages.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-teams/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-teams/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/sample-messages.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-slack/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-shared/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-linear/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-linear/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-github/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-github/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-gchat/sample-messages.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-gchat/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-gchat/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/examples/nextjs-chat/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/CHANGELOG.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/CLAUDE.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.cursor/plans/ephemeral_messages_6f0d6906.plan.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.cursor/plans/add_url_prop_to_button_41f497bd.plan.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.github/SECURITY.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.github/CONTRIBUTING.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.github/pull_request_template.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.github/CODE_OF_CONDUCT.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.changeset/tidy-groups-marry.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.changeset/fix-discord-dm-partials.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.changeset/README.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.changeset/fix-esm-directory-import.md
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.changeset/fallback-streaming-placeholder.md
```


*Completed in 6.3s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/README.md

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/packages/adapter-discord/README.md</path>
<type>file</type>
<content>1: # @chat-adapter/discord
2: 
3: [![npm version](https://img.shields.io/npm/v/@chat-adapter/discord)](https://www.npmjs.com/package/@chat-adapter/discord)
4: [![npm downloads](https://img.shields.io/npm/dm/@chat-adapter/discord)](https://www.npmjs.com/package/@chat-adapter/discord)
5: 
6: Discord adapter for [Chat SDK](https://chat-sdk.dev/docs). Supports HTTP Interactions and Gateway WebSocket for receiving messages.
7: 
8: ## Installation
9: 
10: ```bash
11: npm install chat @chat-adapter/discord
12: ```
13: 
14: ## Usage
15: 
16: ```typescript
17: import { Chat } from "chat";
18: import { createDiscordAdapter } from "@chat-adapter/discord";
19: 
20: const bot = new Chat({
21:   userName: "mybot",
22:   adapters: {
23:     discord: createDiscordAdapter({
24:       botToken: process.env.DISCORD_BOT_TOKEN!,
25:       publicKey: process.env.DISCORD_PUBLIC_KEY!,
26:       applicationId: process.env.DISCORD_APPLICATION_ID!,
27:     }),
28:   },
29: });
30: 
31: bot.onNewMention(async (thread, message) => {
32:   await thread.post("Hello from Discord!");
33: });
34: ```
35: 
36: ## Documentation
37: 
38: Full setup instructions, configuration reference, and features at [chat-sdk.dev/docs/adapters/discord](https://chat-sdk.dev/docs/adapters/discord).
39: 
40: ## License
41: 
42: MIT

(End of file - total 42 lines)
</content>

<system-reminder>
Instructions from: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/CLAUDE.md
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Install dependencies
pnpm install

# Build all packages (uses Turborepo)
pnpm build

# Type-check all packages
pnpm typecheck

# Check all packages (linting and formatting)
pnpm check

# Check for unused exports/dependencies
pnpm knip

# Run all tests
pnpm test

# Run full validation. ALWAYS do this before declaring a task to be done.
pnpm validate


# Run dev mode (watch for changes)
pnpm dev

# Build a specific package
pnpm --filter chat build
pnpm --filter @chat-adapter/slack build
pnpm --filter @chat-adapter/gchat build
pnpm --filter @chat-adapter/teams build

# Run tests for a specific package
pnpm --filter chat test
pnpm --filter @chat-adapter/integration-tests test

# Run a single test file
pnpm --filter @chat-adapter/integration-tests test src/slack.test.ts
```

## Code Style

- Install dependencies with `pnpm add` rather than manually editing package.json
- `sample-messages.md` files in adapter packages contain real-world webhook logs as examples

## Architecture

This is a **pnpm monorepo** using **Turborepo** for build orchestration. All packages use ESM (`"type": "module"`), TypeScript, and **tsup** for bundling.

### Package Structure

- **`packages/chat-sdk`** - Core SDK (`chat` package) with `Chat` class, types, and markdown utilities (mdast-based)
- **`packages/adapter-slack`** - Slack adapter using `@slack/web-api`
- **`packages/adapter-gchat`** - Google Chat adapter using `googleapis`
- **`packages/adapter-teams`** - Microsoft Teams adapter using `botbuilder`
- **`packages/state-memory`** - In-memory state adapter (for development/testing)
- **`packages/state-redis`** - Redis state adapter (for production)
- **`packages/integration-tests`** - Integration tests against real platform APIs
- **`examples/nextjs-chat`** - Example Next.js app showing how to use the SDK

### Core Concepts

1. **Chat** (`packages/chat-sdk/src/chat.ts` in `chat` package) - Main entry point that coordinates adapters and handlers
2. **Adapter** - Platform-specific implementations (Slack, Teams, Google Chat). Each adapter:
   - Handles webhook verification and parsing
   - Converts platform-specific message formats to/from normalized format
   - Provides `FormatConverter` for markdown/AST transformations
3. **StateAdapter** - Persistence layer for subscriptions and distributed locking
4. **Thread** - Represents a conversation thread with methods like `post()`, `subscribe()`, `startTyping()`
5. **Message** - Normalized message format with `text`, `formatted` (mdast AST), and `raw` (platform-specific)

### Thread ID Format

All thread IDs follow the pattern: `{adapter}:{channel}:{thread}`

- Slack: `slack:C123ABC:1234567890.123456`
- Teams: `teams:{base64(conversationId)}:{base64(serviceUrl)}`
- Google Chat: `gchat:spaces/ABC123:{base64(threadName)}`

### Message Handling Flow

1. Platform sends webhook to `/api/webhooks/{platform}`
2. Adapter verifies request, parses message, calls `chat.handleIncomingMessage()`
3. Chat class acquires lock on thread, then:
   - Checks if thread is subscribed -> calls `onSubscribedMessage` handlers
   - Checks for @mention -> calls `onNewMention` handlers
   - Checks message patterns -> calls matching `onNewMessage` handlers
4. Handler receives `Thread` and `Message` objects

### Formatting System

Messages use **mdast** (Markdown AST) as the canonical format. Each adapter has a `FormatConverter` that:

- `toAst(platformText)` - Converts platform format to mdast
- `fromAst(ast)` - Converts mdast to platform format
- `renderPostable(message)` - Renders a `PostableMessage` to platform string

## Testing

### Test Utilities

The `packages/chat/src/mock-adapter.ts` file provides shared test utilities:

- `createMockAdapter(name)` - Creates a mock Adapter with vi.fn() mocks for all methods
- `createMockState()` - Creates a mock StateAdapter with working in-memory subscriptions, locks, and cache
- `createTestMessage(id, text, overrides?)` - Creates a test Message object
- `mockLogger` - A mock Logger that captures all log calls

Example usage:

```typescript
import { createMockAdapter, createMockState, createTestMessage } from "./mock-adapter";

const adapter = createMockAdapter("slack");
const state = createMockState();
const message = createTestMessage("msg-1", "Hello world");
```

## Recording & Replay Tests

Production webhook interactions can be recorded and converted into replay tests:

1. **Recording**: Enable `RECORDING_ENABLED=true` in deployed environment. Recordings are tagged with git SHA.
2. **Export**: Use `pnpm recording:list` and `pnpm recording:export <session-id>` from `examples/nextjs-chat`
3. **Convert**: Extract webhook payloads and create JSON fixtures in `packages/integration-tests/fixtures/replay/`
4. **Test**: Write replay tests using helpers from `replay-test-utils.ts`

See `packages/integration-tests/fixtures/replay/README.md` for detailed workflow.

### Downloading and Analyzing Recordings

When debugging production issues, download recordings for the current git SHA:

```bash
cd examples/nextjs-chat

# Get current SHA
git rev-parse HEAD

# List all recording sessions (look for sessions starting with your SHA)
pnpm recording:list

# Export a specific session to a file
pnpm recording:export session-<SHA>-<timestamp>-<random> 2>&1 | \
  grep -v "^>" | grep -v "^\[dotenv" | grep -v "^$" > /tmp/recording.json

# View number of entries
cat /tmp/recording.json | jq 'length'

# Group webhooks by platform
cat /tmp/recording.json | jq '[.[] | select(.type == "webhook")] | group_by(.platform) | .[] | {platform: .[0].platform, count: length}'

# Extract and analyze platform-specific webhooks
cat /tmp/recording.json | jq '[.[] | select(.type == "webhook" and .platform == "teams") | .body | fromjson]' > /tmp/teams-webhooks.json
cat /tmp/recording.json | jq '[.[] | select(.type == "webhook" and .platform == "slack") | .body | fromjson]' > /tmp/slack-webhooks.json
cat /tmp/recording.json | jq '[.[] | select(.type == "webhook" and .platform == "gchat") | .body | fromjson]' > /tmp/gchat-webhooks.json

# Inspect specific webhook fields (e.g., Teams channelData)
cat /tmp/teams-webhooks.json | jq '[.[] | {type, text, channelData, value}]'
```

## Changesets (Release Flow)

This monorepo uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs. **Every PR that changes a package's behavior must include a changeset.**

### Creating a changeset

```bash
pnpm changeset
```

You'll be prompted to:
1. **Select the affected package(s)** — choose which packages your change touches (e.g., `@chat-adapter/slack`, `chat`)
2. **Choose the semver bump** — `patch` for fixes, `minor` for new features, `major` for breaking changes
3. **Write a summary** — a short description of the change (this goes into the CHANGELOG)

This creates a markdown file in `.changeset/` — commit it with your PR.

### When to use which bump

- **patch** — bug fixes, internal refactors with no API change
- **minor** — new features, new exports, new options
- **major** — breaking changes (removed exports, changed signatures, dropped support)

### Example

```bash
pnpm changeset
# → select: @chat-adapter/slack
# → bump: minor
# → summary: Add custom installation prefix support for preview deployments
```

### Publishing (maintainers)

When changesets are merged to `main`, the Changesets GitHub Action opens a "Version Packages" PR that bumps versions and updates CHANGELOGs. Merging that PR triggers publishing to npm.

## Environment Variables

Key env vars used (see `turbo.json` for full list):

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` - Slack credentials
- `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID` - Teams credentials
- `GOOGLE_CHAT_CREDENTIALS` or `GOOGLE_CHAT_USE_ADC` - Google Chat auth
- `REDIS_URL` - Redis connection for state adapter
- `BOT_USERNAME` - Default bot username

---

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `pnpm dlx ultracite fix` before committing to ensure compliance.

</system-reminder>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/skills/chat/SKILL.md

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/skills/chat/SKILL.md</path>
<type>file</type>
<content>1: ---
2: name: chat-sdk
3: description: >
4:   Build multi-platform chat bots with Chat SDK (`chat` npm package). Use when developers want to
5:   (1) Build a Slack, Teams, Google Chat, Discord, GitHub, or Linear bot,
6:   (2) Use the Chat SDK to handle mentions, messages, reactions, slash commands, cards, modals, or streaming,
7:   (3) Set up webhook handlers for chat platforms,
8:   (4) Send interactive cards or stream AI responses to chat platforms.
9:   Triggers on "chat sdk", "chat bot", "slack bot", "teams bot", "discord bot", "@chat-adapter",
10:   building bots that work across multiple chat platforms.
11: ---
12: 
13: # Chat SDK
14: 
15: Unified TypeScript SDK for building chat bots across Slack, Teams, Google Chat, Discord, GitHub, and Linear. Write bot logic once, deploy everywhere.
16: 
17: ## Critical: Read the bundled docs
18: 
19: The `chat` package ships with full documentation in `node_modules/chat/docs/` and TypeScript source types. **Always read these before writing code:**
20: 
21: ```
22: node_modules/chat/docs/           # Full documentation (MDX files)
23: node_modules/chat/dist/           # Built types (.d.ts files)
24: ```
25: 
26: Key docs to read based on task:
27: - `docs/getting-started.mdx` — setup guides
28: - `docs/usage.mdx` — event handlers, threads, messages, channels
29: - `docs/streaming.mdx` — AI streaming with AI SDK
30: - `docs/cards.mdx` — JSX interactive cards
31: - `docs/actions.mdx` — button/dropdown handlers
32: - `docs/modals.mdx` — form dialogs (Slack only)
33: - `docs/adapters/*.mdx` — platform-specific adapter setup
34: - `docs/state/*.mdx` — state adapter config (Redis, ioredis, memory)
35: 
36: Also read the TypeScript types from `node_modules/chat/dist/` to understand the full API surface.
37: 
38: ## Quick start
39: 
40: ```typescript
41: import { Chat } from "chat";
42: import { createSlackAdapter } from "@chat-adapter/slack";
43: import { createRedisState } from "@chat-adapter/state-redis";
44: 
45: const bot = new Chat({
46:   userName: "mybot",
47:   adapters: {
48:     slack: createSlackAdapter({
49:       botToken: process.env.SLACK_BOT_TOKEN!,
50:       signingSecret: process.env.SLACK_SIGNING_SECRET!,
51:     }),
52:   },
53:   state: createRedisState({ url: process.env.REDIS_URL! }),
54: });
55: 
56: bot.onNewMention(async (thread) => {
57:   await thread.subscribe();
58:   await thread.post("Hello! I'm listening to this thread.");
59: });
60: 
61: bot.onSubscribedMessage(async (thread, message) => {
62:   await thread.post(`You said: ${message.text}`);
63: });
64: ```
65: 
66: ## Core concepts
67: 
68: - **Chat** — main entry point, coordinates adapters and routes events
69: - **Adapters** — platform-specific (Slack, Teams, GChat, Discord, GitHub, Linear)
70: - **State** — pluggable persistence (Redis for prod, memory for dev)
71: - **Thread** — conversation thread with `post()`, `subscribe()`, `startTyping()`
72: - **Message** — normalized format with `text`, `formatted` (mdast AST), `raw`
73: - **Channel** — container for threads, supports listing and posting
74: 
75: ## Event handlers
76: 
77: | Handler | Trigger |
78: |---------|---------|
79: | `onNewMention` | Bot @-mentioned in unsubscribed thread |
80: | `onSubscribedMessage` | Any message in subscribed thread |
81: | `onNewMessage(regex)` | Messages matching pattern in unsubscribed threads |
82: | `onSlashCommand("/cmd")` | Slash command invocations |
83: | `onReaction(emojis)` | Emoji reactions added/removed |
84: | `onAction(actionId)` | Button clicks and dropdown selections |
85: | `onAssistantThreadStarted` | Slack Assistants API thread opened |
86: | `onAppHomeOpened` | Slack App Home tab opened |
87: 
88: ## Streaming
89: 
90: Pass any `AsyncIterable<string>` to `thread.post()`. Works with AI SDK's `textStream`:
91: 
92: ```typescript
93: import { ToolLoopAgent } from "ai";
94: const agent = new ToolLoopAgent({ model: "anthropic/claude-4.5-sonnet" });
95: 
96: bot.onNewMention(async (thread, message) => {
97:   const result = await agent.stream({ prompt: message.text });
98:   await thread.post(result.textStream);
99: });
100: ```
101: 
102: ## Cards (JSX)
103: 
104: Set `jsxImportSource: "chat"` in tsconfig. Components: `Card`, `CardText`, `Button`, `Actions`, `Fields`, `Field`, `Select`, `SelectOption`, `Image`, `Divider`, `LinkButton`, `Section`, `RadioSelect`.
105: 
106: ```tsx
107: await thread.post(
108:   <Card title="Order #1234">
109:     <CardText>Your order has been received!</CardText>
110:     <Actions>
111:       <Button id="approve" style="primary">Approve</Button>
112:       <Button id="reject" style="danger">Reject</Button>
113:     </Actions>
114:   </Card>
115: );
116: ```
117: 
118: ## Packages
119: 
120: | Package | Purpose |
121: |---------|---------|
122: | `chat` | Core SDK |
123: | `@chat-adapter/slack` | Slack |
124: | `@chat-adapter/teams` | Microsoft Teams |
125: | `@chat-adapter/gchat` | Google Chat |
126: | `@chat-adapter/discord` | Discord |
127: | `@chat-adapter/github` | GitHub Issues |
128: | `@chat-adapter/linear` | Linear Issues |
129: | `@chat-adapter/state-redis` | Redis state (production) |
130: | `@chat-adapter/state-ioredis` | ioredis state (alternative) |
131: | `@chat-adapter/state-memory` | In-memory state (development) |
132: 
133: ## Changesets (Release Flow)
134: 
135: This monorepo uses [Changesets](https://github.com/changesets/changesets) for versioning and changelogs. Every PR that changes a package's behavior must include a changeset.
136: 
137: ```bash
138: pnpm changeset
139: # → select affected package(s) (e.g. @chat-adapter/slack, chat)
140: # → choose bump type: patch (fixes), minor (features), major (breaking)
141: # → write a short summary for the CHANGELOG
142: ```
143: 
144: This creates a file in `.changeset/` — commit it with the PR. When merged to `main`, the Changesets GitHub Action opens a "Version Packages" PR to bump versions and update CHANGELOGs. Merging that PR publishes to npm.
145: 
146: ## Webhook setup
147: 
148: Each adapter exposes a webhook handler via `bot.webhooks.{platform}`. Wire these to your HTTP framework's routes (e.g. Next.js API routes, Hono, Express).

(End of file - total 148 lines)
</content>
```


*Completed in 4.0s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

The README mentions docs at `chat-sdk.dev/docs/adapters/discord`. Let me check if there are docs bundled in the repo:

#### 🛠️ Tool: glob

**Input:**
```yaml
pattern: '**/docs/**/*.{md,mdx}'
path: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat

```

**Output:**
```
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/usage.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/streaming.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/slash-commands.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/posting-messages.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/state/redis.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/state/memory.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/state/ioredis.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/state/index.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/modals.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/index.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/guides/slack-nextjs.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/guides/code-review-hono.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/guides/discord-nuxt.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/getting-started.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/direct-messages.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/emoji.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/ephemeral-messages.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/files.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/error-handling.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/contributing/publishing.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/contributing/building.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/contributing/testing.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/contributing/documenting.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/cards.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/cards.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/channel.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/thread.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/chat.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/message.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/markdown.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/postable-message.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/modals.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/api/index.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/slack.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/gchat.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/discord.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/linear.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/teams.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/telegram.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/index.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/github.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/actions.mdx
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/CHANGELOG.md
```

#### 🛠️ Tool: grep

**Input:**
```yaml
pattern: gateway|forward|websocket|GATEWAY
include: '*.{md,mdx}'
path: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat

```

**Output:**
```
Found 13 matches
/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/examples/nextjs-chat/README.md:
  Line 59: │   │   └── discord/gateway/route.ts        # Discord gateway cron

/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/guides/discord-nuxt.mdx:
  Line 3: description: This guide walks through building a Discord support bot with Nuxt, covering project setup, Discord app configuration, Gateway forwarding, AI-powered responses, and deployment.
  Line 151: ## Set up the Gateway forwarder
  Line 153: Discord doesn't push messages to webhooks like Slack does. Instead, messages arrive through the Gateway WebSocket. The Discord adapter includes a built-in Gateway listener that connects to the WebSocket and forwards events to your webhook endpoint.
  Line 157: ```typescript title="server/api/discord/gateway.get.ts" lineNumbers
  Line 182: The Gateway listener connects to Discord's WebSocket, receives messages, and forwards them to your webhook endpoint for processing. In production, you'll want a cron job to restart it periodically.
  Line 187: 2. Trigger the Gateway listener by visiting `http://localhost:3000/api/discord/gateway` in your browser
  Line 202:       "path": "/api/discord/gateway",

/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/discord.mdx:
  Line 84: ```typescript title="app/api/discord/gateway/route.ts"
  Line 119:       "path": "/api/discord/gateway",

/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/telegram.mdx:
  Line 76: # Optional (self-hosted API gateway)

/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/CLAUDE.md:
  Line 311: - Use ref as a prop instead of `React.forwardRef`

/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/.changeset/fix-discord-dm-partials.md:
  Line 5: Add `Partials.Channel` to gateway client for DM support
```


*Completed in 5.9s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Found it. Let me read the Discord adapter docs and the Nuxt guide:

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/discord.mdx

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/adapters/discord.mdx</path>
<type>file</type>
<content>1: ---
2: title: Discord
3: description: Configure the Discord adapter with HTTP Interactions and Gateway WebSocket support.
4: type: integration
5: prerequisites:
6:   - /docs/getting-started
7: ---
8: 
9: ## Installation
10: 
11: ```sh title="Terminal"
12: pnpm add @chat-adapter/discord
13: ```
14: 
15: ## Usage
16: 
17: The adapter auto-detects `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, and `DISCORD_MENTION_ROLE_IDS` from environment variables:
18: 
19: ```typescript title="lib/bot.ts" lineNumbers
20: import { Chat } from "chat";
21: import { createDiscordAdapter } from "@chat-adapter/discord";
22: 
23: const bot = new Chat({
24:   userName: "mybot",
25:   adapters: {
26:     discord: createDiscordAdapter(),
27:   },
28: });
29: 
30: bot.onNewMention(async (thread, message) => {
31:   await thread.post("Hello from Discord!");
32: });
33: ```
34: 
35: ## Discord application setup
36: 
37: ### 1. Create application
38: 
39: 1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
40: 2. Click **New Application** and give it a name
41: 3. Note the **Application ID** from the General Information page
42: 4. Copy the **Public Key** from the General Information page
43: 
44: ### 2. Create bot
45: 
46: 1. Go to the **Bot** section in the left sidebar
47: 2. Click **Reset Token** to generate a new bot token
48: 3. Copy and save the token (you won't see it again)
49: 4. Enable these **Privileged Gateway Intents**:
50:    - Message Content Intent
51:    - Server Members Intent (if needed)
52: 
53: ### 3. Configure interactions endpoint
54: 
55: 1. Go to **General Information**
56: 2. Set **Interactions Endpoint URL** to `https://your-domain.com/api/webhooks/discord`
57: 3. Discord sends a PING to verify the endpoint
58: 
59: ### 4. Add bot to server
60: 
61: 1. Go to **OAuth2** then **URL Generator**
62: 2. Select scopes: `bot`, `applications.commands`
63: 3. Select bot permissions: Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions, Attach Files
64: 4. Copy the generated URL and open it to invite the bot to your server
65: 
66: ## Architecture: HTTP Interactions vs Gateway
67: 
68: Discord has two ways to receive events:
69: 
70: **HTTP Interactions (default):**
71: - Receives button clicks, slash commands, and verification pings
72: - Works out of the box with serverless
73: - Does **not** receive regular messages
74: 
75: **Gateway WebSocket (required for messages):**
76: - Receives regular messages and reactions
77: - Requires a persistent connection
78: - In serverless environments, use a cron job to maintain the connection
79: 
80: ## Gateway setup for serverless
81: 
82: ### 1. Create Gateway route
83: 
84: ```typescript title="app/api/discord/gateway/route.ts"
85: import { after } from "next/server";
86: import { bot } from "@/lib/bot";
87: 
88: export const maxDuration = 800;
89: 
90: export async function GET(request: Request): Promise<Response> {
91:   const cronSecret = process.env.CRON_SECRET;
92:   if (!cronSecret) {
93:     return new Response("CRON_SECRET not configured", { status: 500 });
94:   }
95: 
96:   const authHeader = request.headers.get("authorization");
97:   if (authHeader !== `Bearer ${cronSecret}`) {
98:     return new Response("Unauthorized", { status: 401 });
99:   }
100: 
101:   const durationMs = 600 * 1000;
102:   const webhookUrl = `https://${process.env.VERCEL_URL}/api/webhooks/discord`;
103: 
104:   return bot.adapters.discord.startGatewayListener(
105:     { waitUntil: (task) => after(() => task) },
106:     durationMs,
107:     undefined,
108:     webhookUrl
109:   );
110: }
111: ```
112: 
113: ### 2. Configure Vercel Cron
114: 
115: ```json title="vercel.json"
116: {
117:   "crons": [
118:     {
119:       "path": "/api/discord/gateway",
120:       "schedule": "*/9 * * * *"
121:     }
122:   ]
123: }
124: ```
125: 
126: This runs every 9 minutes, ensuring overlap with the 10-minute listener duration.
127: 
128: ### 3. Add environment variables
129: 
130: Add `CRON_SECRET` to your Vercel project settings.
131: 
132: ## Role mentions
133: 
134: By default, only direct user mentions (`@BotName`) trigger `onNewMention` handlers. To also trigger on role mentions (e.g., `@AI`):
135: 
136: 1. Create a role in your Discord server (e.g., "AI")
137: 2. Assign the role to your bot
138: 3. Copy the role ID (right-click role in server settings with Developer Mode enabled)
139: 4. Add to `mentionRoleIds`:
140: 
141: ```typescript title="lib/bot.ts" lineNumbers
142: createDiscordAdapter({
143:   mentionRoleIds: ["1457473602180878604"],
144: });
145: ```
146: 
147: Or set `DISCORD_MENTION_ROLE_IDS` as a comma-separated string in your environment variables.
148: 
149: ## Configuration
150: 
151: All options are auto-detected from environment variables when not provided.
152: 
153: | Option | Required | Description |
154: |--------|----------|-------------|
155: | `botToken` | No* | Discord bot token. Auto-detected from `DISCORD_BOT_TOKEN` |
156: | `publicKey` | No* | Application public key. Auto-detected from `DISCORD_PUBLIC_KEY` |
157: | `applicationId` | No* | Discord application ID. Auto-detected from `DISCORD_APPLICATION_ID` |
158: | `mentionRoleIds` | No | Array of role IDs that trigger mention handlers. Auto-detected from `DISCORD_MENTION_ROLE_IDS` (comma-separated) |
159: | `logger` | No | Logger instance (defaults to `ConsoleLogger("info")`) |
160: 
161: *`botToken`, `publicKey`, and `applicationId` are required — either via config or env vars.
162: 
163: ## Environment variables
164: 
165: ```bash title=".env.local"
166: DISCORD_BOT_TOKEN=your-bot-token
167: DISCORD_PUBLIC_KEY=your-application-public-key
168: DISCORD_APPLICATION_ID=your-application-id
169: DISCORD_MENTION_ROLE_IDS=1234567890,0987654321  # Optional
170: CRON_SECRET=your-random-secret                   # For Gateway cron
171: ```
172: 
173: ## Features
174: 
175: | Feature | Supported |
176: |---------|-----------|
177: | Mentions | Yes |
178: | Reactions (add/remove) | Yes |
179: | Cards (Embeds) | Yes |
180: | Modals | No |
181: | Streaming | Post+Edit fallback |
182: | DMs | Yes |
183: | Ephemeral messages | No (DM fallback) |
184: | File uploads | Yes |
185: | Typing indicator | Yes |
186: | Message history | Yes |
187: 
188: ## Testing
189: 
190: Run a local tunnel (e.g., ngrok) to test webhooks locally:
191: 
192: ```sh title="Terminal"
193: ngrok http 3000
194: ```
195: 
196: Update the Interactions Endpoint URL in the Discord Developer Portal to your ngrok URL.
197: 
198: ## Troubleshooting
199: 
200: ### Bot not responding to messages
201: 
202: 1. **Check Gateway connection**: Messages require the Gateway WebSocket, not just HTTP interactions
203: 2. **Verify Message Content Intent**: Enable this in the Bot settings
204: 3. **Check bot permissions**: Ensure the bot can read messages in the channel
205: 
206: ### Role mentions not triggering
207: 
208: 1. **Verify role ID**: Enable Developer Mode in Discord settings, then right-click the role
209: 2. **Check `mentionRoleIds` config**: Ensure the role ID is in the array
210: 3. **Confirm bot has the role**: The bot must have the role assigned
211: 
212: ### Signature verification failing
213: 
214: 1. **Check public key format**: Should be a 64-character hex string (lowercase)
215: 2. **Verify endpoint URL**: Must exactly match what's configured in Discord Developer Portal
216: 3. **Check for body parsing**: Don't parse the request body before verification

(End of file - total 216 lines)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/guides/discord-nuxt.mdx

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/opensrc/repos/github.com/vercel/chat/apps/docs/content/docs/guides/discord-nuxt.mdx</path>
<type>file</type>
<content>1: ---
2: title: Discord support bot with Nuxt and Redis
3: description: This guide walks through building a Discord support bot with Nuxt, covering project setup, Discord app configuration, Gateway forwarding, AI-powered responses, and deployment.
4: type: guide
5: prerequisites: []
6: related:
7:   - /docs/adapters/discord
8:   - /docs/cards
9:   - /docs/actions
10: ---
11: 
12: ## Prerequisites
13: 
14: - Node.js 18+
15: - [pnpm](https://pnpm.io) (or npm/yarn)
16: - A Discord server where you have admin access
17: - A Redis instance for state management
18: 
19: ## Create a Nuxt app
20: 
21: Scaffold a new Nuxt project and install Chat SDK dependencies:
22: 
23: ```sh title="Terminal"
24: npx nuxi@latest init my-discord-bot
25: cd my-discord-bot
26: pnpm add chat @chat-adapter/discord @chat-adapter/state-redis ai @ai-sdk/anthropic
27: ```
28: 
29: ## Create a Discord app
30: 
31: 1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
32: 2. Click **New Application**, give it a name, and click **Create**
33: 3. Go to **Bot** in the sidebar and click **Reset Token** — copy the token, you'll need this as `DISCORD_BOT_TOKEN`
34: 4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
35: 5. Go to **General Information** and copy the **Application ID** and **Public Key** — you'll need these as `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY`
36: 
37: ### Set up the Interactions endpoint
38: 
39: 1. In **General Information**, set the **Interactions Endpoint URL** to `https://your-domain.com/api/webhooks/discord`
40: 2. Discord will send a PING to verify the endpoint — you'll need to deploy first or use a tunnel
41: 
42: ### Invite the bot to your server
43: 
44: 1. Go to **OAuth2** in the sidebar
45: 2. Under **OAuth2 URL Generator**, select the `bot` scope
46: 3. Under **Bot Permissions**, select:
47:    - Send Messages
48:    - Create Public Threads
49:    - Send Messages in Threads
50:    - Read Message History
51:    - Add Reactions
52:    - Use Slash Commands
53: 4. Copy the generated URL and open it in your browser to invite the bot
54: 
55: ## Configure environment variables
56: 
57: Create a `.env` file in your project root:
58: 
59: ```bash title=".env"
60: DISCORD_BOT_TOKEN=your_bot_token
61: DISCORD_PUBLIC_KEY=your_public_key
62: DISCORD_APPLICATION_ID=your_application_id
63: REDIS_URL=redis://localhost:6379
64: ANTHROPIC_API_KEY=your_anthropic_api_key
65: ```
66: 
67: ## Create the bot
68: 
69: Create `server/lib/bot.ts` with a `Chat` instance configured with the Discord adapter. This bot uses AI SDK to answer support questions:
70: 
71: ```typescript title="server/lib/bot.tsx" lineNumbers
72: import { Chat, Card, CardText as Text, Actions, Button, Divider } from "chat";
73: import { createDiscordAdapter } from "@chat-adapter/discord";
74: import { createRedisState } from "@chat-adapter/state-redis";
75: import { generateText } from "ai";
76: import { anthropic } from "@ai-sdk/anthropic";
77: 
78: export const bot = new Chat({
79:   userName: "support-bot",
80:   adapters: {
81:     discord: createDiscordAdapter(),
82:   },
83:   state: createRedisState(),
84: });
85: 
86: bot.onNewMention(async (thread) => {
87:   await thread.subscribe();
88:   await thread.post(
89:     <Card title="Support">
90:       <Text>Hey! I'm here to help. Ask your question in this thread and I'll do my best to answer it.</Text>
91:       <Divider />
92:       <Actions>
93:         <Button id="escalate" style="danger">Escalate to Human</Button>
94:       </Actions>
95:     </Card>
96:   );
97: });
98: 
99: bot.onSubscribedMessage(async (thread, message) => {
100:   await thread.startTyping();
101: 
102:   const { text } = await generateText({
103:     model: anthropic("claude-sonnet-4-5-20250514"),
104:     system: "You are a friendly support bot. Answer questions concisely. If you don't know the answer, say so and suggest the user click 'Escalate to Human'.",
105:     prompt: message.text,
106:   });
107: 
108:   await thread.post(text);
109: });
110: 
111: bot.onAction("escalate", async (event) => {
112:   await event.thread.post(
113:     `${event.user.fullName} requested human support. A team member will follow up shortly.`
114:   );
115: });
116: ```
117: 
118: <Callout type="info">
119:   The file extension must be `.tsx` (not `.ts`) when using JSX components like `Card` and `Button`. Make sure your `tsconfig.json` has `"jsx": "react-jsx"` and `"jsxImportSource": "chat"`.
120: </Callout>
121: 
122: `onNewMention` fires when a user @mentions the bot. Calling `thread.subscribe()` tells the SDK to track that thread, so subsequent messages trigger `onSubscribedMessage` where AI SDK generates a response.
123: 
124: ## Create the webhook route
125: 
126: Create a server route that handles incoming Discord webhooks:
127: 
128: ```typescript title="server/api/webhooks/[platform].post.ts" lineNumbers
129: import { bot } from "../lib/bot";
130: 
131: type Platform = keyof typeof bot.webhooks;
132: 
133: export default defineEventHandler(async (event) => {
134:   const platform = getRouterParam(event, "platform") as Platform;
135: 
136:   const handler = bot.webhooks[platform];
137:   if (!handler) {
138:     throw createError({ statusCode: 404, message: `Unknown platform: ${platform}` });
139:   }
140: 
141:   const request = toWebRequest(event);
142: 
143:   return handler(request, {
144:     waitUntil: (task) => event.waitUntil(task),
145:   });
146: });
147: ```
148: 
149: This creates a `POST /api/webhooks/discord` endpoint. The `waitUntil` option ensures message processing completes after the HTTP response is sent.
150: 
151: ## Set up the Gateway forwarder
152: 
153: Discord doesn't push messages to webhooks like Slack does. Instead, messages arrive through the Gateway WebSocket. The Discord adapter includes a built-in Gateway listener that connects to the WebSocket and forwards events to your webhook endpoint.
154: 
155: Create a route that starts the Gateway listener:
156: 
157: ```typescript title="server/api/discord/gateway.get.ts" lineNumbers
158: import { bot } from "../../lib/bot";
159: 
160: export default defineEventHandler(async (event) => {
161:   await bot.initialize();
162: 
163:   const discord = bot.getAdapter("discord");
164:   if (!discord) {
165:     throw createError({ statusCode: 404, message: "Discord adapter not configured" });
166:   }
167: 
168:   const baseUrl = process.env.NUXT_PUBLIC_SITE_URL || "http://localhost:3000";
169:   const webhookUrl = `${baseUrl}/api/webhooks/discord`;
170: 
171:   const durationMs = 10 * 60 * 1000; // 10 minutes
172: 
173:   return discord.startGatewayListener(
174:     { waitUntil: (task: Promise<unknown>) => event.waitUntil(task) },
175:     durationMs,
176:     undefined,
177:     webhookUrl,
178:   );
179: });
180: ```
181: 
182: The Gateway listener connects to Discord's WebSocket, receives messages, and forwards them to your webhook endpoint for processing. In production, you'll want a cron job to restart it periodically.
183: 
184: ## Test locally
185: 
186: 1. Start your development server (`pnpm dev`)
187: 2. Trigger the Gateway listener by visiting `http://localhost:3000/api/discord/gateway` in your browser
188: 3. Expose your server with a tunnel (e.g. `ngrok http 3000`)
189: 4. Update the **Interactions Endpoint URL** in your Discord app settings to your tunnel URL (e.g. `https://abc123.ngrok.io/api/webhooks/discord`)
190: 5. @mention the bot in your Discord server — it should respond with a support card
191: 6. Reply in the thread — AI SDK should generate a response
192: 7. Click **Escalate to Human** — the bot should post an escalation message
193: 
194: ## Add a cron job for production
195: 
196: The Gateway listener runs for a fixed duration. In production, set up a cron job to restart it automatically. If you're deploying to Vercel, add a `vercel.json`:
197: 
198: ```json title="vercel.json"
199: {
200:   "crons": [
201:     {
202:       "path": "/api/discord/gateway",
203:       "schedule": "*/9 * * * *"
204:     }
205:   ]
206: }
207: ```
208: 
209: This restarts the Gateway listener every 9 minutes, ensuring continuous connectivity. Protect the endpoint with a `CRON_SECRET` environment variable in production.
210: 
211: ## Deploy to Vercel
212: 
213: Deploy your bot to Vercel:
214: 
215: ```sh title="Terminal"
216: vercel deploy
217: ```
218: 
219: After deployment, set your environment variables in the Vercel dashboard (`DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `REDIS_URL`, `ANTHROPIC_API_KEY`). Update the **Interactions Endpoint URL** in your Discord app settings to your production URL.
220: 
221: ## Next steps
222: 
223: - [Cards](/docs/cards) — Build rich interactive messages with buttons, fields, and selects
224: - [Actions](/docs/actions) — Handle button clicks, select menus, and other interactions
225: - [Streaming](/docs/streaming) — Stream AI-generated responses to chat
226: - [Discord adapter](/docs/adapters/discord) — Full configuration reference and Gateway setup

(End of file - total 226 lines)
</content>
```


*Completed in 4.8s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Found them. There are two docs that explain this setup:

## 1. Discord Adapter reference
**`apps/docs/content/docs/adapters/discord.mdx`** (also at https://chat-sdk.dev/docs/adapters/discord)

Has a section "**Architecture: HTTP Interactions vs Gateway**" that explains the two modes, plus a "**Gateway setup for serverless**" section with a complete Next.js code example showing `startGatewayListener` with `waitUntil`, a Vercel cron running every 9 minutes, and the `webhookUrl` parameter.

## 2. Discord bot with Nuxt guide
**`apps/docs/content/docs/guides/discord-nuxt.mdx`** (also at https://chat-sdk.dev/docs/guides/discord-nuxt)

This is the most detailed doc. It has a full section "**Set up the Gateway forwarder**" that explicitly explains:

> Discord doesn't push messages to webhooks like Slack does. Instead, messages arrive through the Gateway WebSocket. The Discord adapter includes a built-in Gateway listener that connects to the WebSocket and forwards events to your webhook endpoint.

It walks through creating the Gateway route, passing a `webhookUrl` where events get forwarded to, and setting up a cron job for production.

---

**What's not documented** is the raw forwarding protocol itself - the `x-discord-gateway-token` header, the `DiscordForwardedEvent` envelope format, and the `GATEWAY_MESSAGE_CREATE` / `GATEWAY_MESSAGE_REACTION_ADD` / `GATEWAY_MESSAGE_REACTION_REMOVE` event types. Those are purely implementation details in the source code. The docs only show the high-level `startGatewayListener()` API that does the forwarding internally. If you wanted to build your own external Gateway forwarder (separate process), you'd have to read the adapter source code to understand the protocol.


*Completed in 12.5s*

### 👤 User

Voice message transcription from Discord user:

Read the Discord base. How easy would it be to change from discord.js to use Chat SDK so that we support coverage channels like Slack? What will we need to change? Can we port everything or are there some things we cannot do?


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

<details>
<summary>💭 Thinking</summary>

The user wants me to analyze kimaki's Discord bot codebase and evaluate how feasible it would be to migrate from discord.js to the Vercel Chat SDK, enabling multi-platform support (Slack, etc.). I need to understand what kimaki currently does with discord.js and map those capabilities to what chat-sdk offers.

Let me explore the kimaki discord bot codebase thoroughly.

</details>

Let me explore the kimaki Discord bot codebase to understand what we're working with.

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src</path>
<type>directory</type>
<entries>
__snapshots__/
ai-tool-to-genai.test.ts
ai-tool-to-genai.ts
ai-tool.ts
bin.ts
channel-management.ts
cli-parsing.test.ts
cli.ts
commands/
condense-memory.ts
config.ts
database.ts
db.test.ts
db.ts
discord-bot.ts
discord-urls.ts
discord-utils.test.ts
discord-utils.ts
errors.ts
escape-backticks.test.ts
format-tables.test.ts
format-tables.ts
forum-sync/
gateway-proxy.e2e.test.ts
genai-worker-wrapper.ts
genai-worker.ts
genai.ts
generated/
heap-monitor.ts
hrana-server.test.ts
hrana-server.ts
image-utils.ts
interaction-handler.ts
ipc-polling.ts
kimaki-digital-twin.e2e.test.ts
limit-heading-depth.test.ts
limit-heading-depth.ts
logger.ts
markdown.test.ts
markdown.ts
message-formatting.test.ts
message-formatting.ts
openai-realtime.ts
opencode-plugin-loading.e2e.test.ts
opencode-plugin.test.ts
opencode-plugin.ts
opencode.ts
privacy-sanitizer.ts
schema.sql
sentry.ts
session-handler.ts
session-handler/
session-search.test.ts
session-search.ts
startup-service.ts
store.ts
system-message.ts
task-runner.ts
task-schedule.test.ts
task-schedule.ts
thinking-utils.ts
thread-message-queue.e2e.test.ts
tools.ts
unnest-code-blocks.test.ts
unnest-code-blocks.ts
upgrade.ts
utils.ts
voice-handler.ts
voice.test.ts
voice.ts
wait-session.ts
worker-types.ts
worktree-utils.ts
xml.test.ts
xml.ts

(75 entries)
</entries>
```


*Completed in 6.5s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/discord-bot.ts
limit: 150

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/discord-bot.ts</path>
<type>file</type>
<content>1: // Core Discord bot module that handles message events and bot lifecycle.
2: // Bridges Discord messages to OpenCode sessions, manages voice connections,
3: // and orchestrates the main event loop for the Kimaki bot.
4: 
5: import {
6:   initDatabase,
7:   closeDatabase,
8:   getThreadWorktree,
9:   createPendingWorktree,
10:   setWorktreeReady,
11:   setWorktreeError,
12:   getChannelWorktreesEnabled,
13:   getChannelMentionMode,
14:   getChannelDirectory,
15:   getThreadSession,
16:   setThreadSession,
17:   getPrisma,
18:   cancelAllPendingIpcRequests,
19: } from './database.js'
20: import {
21:   initializeOpencodeForDirectory,
22:   getOpencodeServers,
23: } from './opencode.js'
24: import { formatWorktreeName } from './commands/worktree.js'
25: import { WORKTREE_PREFIX } from './commands/merge-worktree.js'
26: import { createWorktreeWithSubmodules } from './worktree-utils.js'
27: import {
28:   escapeBackticksInCodeBlocks,
29:   splitMarkdownForDiscord,
30:   sendThreadMessage,
31:   SILENT_MESSAGE_FLAGS,
32:   reactToThread,
33:   stripMentions,
34:   hasKimakiBotPermission,
35:   hasNoKimakiRole,
36: } from './discord-utils.js'
37: import {
38:   getOpencodeSystemMessage,
39:   type ThreadStartMarker,
40: } from './system-message.js'
41: import yaml from 'js-yaml'
42: import {
43:   getFileAttachments,
44:   getTextAttachments,
45:   resolveMentions,
46: } from './message-formatting.js'
47: import {
48:   ensureKimakiCategory,
49:   ensureKimakiAudioCategory,
50:   createProjectChannels,
51:   getChannelsWithDescriptions,
52:   type ChannelWithTags,
53: } from './channel-management.js'
54: import {
55:   voiceConnections,
56:   cleanupVoiceConnection,
57:   processVoiceAttachment,
58:   registerVoiceStateHandler,
59: } from './voice-handler.js'
60: import { getCompactSessionContext, getLastSessionId } from './markdown.js'
61: import {
62:   handleOpencodeSession,
63:   signalThreadInterrupt,
64:   type SessionStartSourceContext,
65: } from './session-handler.js'
66: import { runShellCommand } from './commands/run-command.js'
67: import { registerInteractionHandler } from './interaction-handler.js'
68: import { getDiscordRestApiUrl } from './discord-urls.js'
69: import { stopHranaServer } from './hrana-server.js'
70: import { notifyError } from './sentry.js'
71: 
72: export {
73:   initDatabase,
74:   closeDatabase,
75:   getChannelDirectory,
76:   getPrisma,
77: } from './database.js'
78: export { initializeOpencodeForDirectory } from './opencode.js'
79: export {
80:   escapeBackticksInCodeBlocks,
81:   splitMarkdownForDiscord,
82: } from './discord-utils.js'
83: export { getOpencodeSystemMessage } from './system-message.js'
84: export {
85:   ensureKimakiCategory,
86:   ensureKimakiAudioCategory,
87:   createProjectChannels,
88:   getChannelsWithDescriptions,
89: } from './channel-management.js'
90: export type { ChannelWithTags } from './channel-management.js'
91: 
92: import {
93:   ChannelType,
94:   Client,
95:   Events,
96:   GatewayIntentBits,
97:   Partials,
98:   ThreadAutoArchiveDuration,
99:   type Message,
100:   type TextChannel,
101:   type ThreadChannel,
102: } from 'discord.js'
103: import fs from 'node:fs'
104: import * as errore from 'errore'
105: import { createLogger, formatErrorWithStack, LogPrefix } from './logger.js'
106: import { writeHeapSnapshot, startHeapMonitor } from './heap-monitor.js'
107: import { startTaskRunner } from './task-runner.js'
108: import { setGlobalDispatcher, Agent } from 'undici'
109: 
110: // Increase connection pool to prevent deadlock when multiple sessions have open SSE streams.
111: // Each session's event.subscribe() holds a connection; without enough connections,
112: // regular HTTP requests (question.reply, session.prompt) get blocked → deadlock.
113: setGlobalDispatcher(
114:   new Agent({ headersTimeout: 0, bodyTimeout: 0, connections: 500 }),
115: )
116: 
117: const discordLogger = createLogger(LogPrefix.DISCORD)
118: const voiceLogger = createLogger(LogPrefix.VOICE)
119: 
120: // Per-thread serial queue so messages (voice + text) in the same thread are
121: // processed one at a time in arrival order. Without this, a slow voice
122: // transcription can finish after a fast text message and abort its session.
123: const threadMessageQueue = new Map<string, Promise<void>>()
124: 
125: function parseEmbedFooterMarker<T extends Record<string, unknown>>({
126:   footer,
127: }: {
128:   footer: string | undefined
129: }): T | undefined {
130:   if (!footer) {
131:     return undefined
132:   }
133:   try {
134:     const parsed = yaml.load(footer)
135:     if (!parsed || typeof parsed !== 'object') {
136:       return undefined
137:     }
138:     return parsed as T
139:   } catch {
140:     return undefined
141:   }
142: }
143: 
144: function parseSessionStartSourceFromMarker(
145:   marker: ThreadStartMarker | undefined,
146: ): SessionStartSourceContext | undefined {
147:   if (!marker?.scheduledKind) {
148:     return undefined
149:   }
150:   if (marker.scheduledKind !== 'at' && marker.scheduledKind !== 'cron') {

(Showing lines 1-150 of 1228. Use offset=151 to continue.)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/commands

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/commands</path>
<type>directory</type>
<entries>
abort.ts
action-buttons.ts
add-project.ts
agent.ts
ask-question.ts
compact.ts
context-usage.ts
create-new-project.ts
diff.ts
file-upload.ts
fork.ts
gemini-apikey.ts
login.ts
mention-mode.ts
merge-worktree.ts
model.ts
permissions.ts
queue.ts
remove-project.ts
restart-opencode-server.ts
resume.ts
run-command.ts
session-id.ts
session.ts
share.ts
types.ts
undo-redo.ts
unset-model.ts
upgrade.ts
user-command.ts
verbosity.ts
worktree-settings.ts
worktree.ts

(33 entries)
</entries>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/session-handler

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/session-handler</path>
<type>directory</type>
<entries>
state.ts

(1 entries)
</entries>
```


*Completed in 4.1s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/discord-bot.ts
offset: 151
limit: 200

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/discord-bot.ts</path>
<type>file</type>
<content>151:     return undefined
152:   }
153:   if (
154:     typeof marker.scheduledTaskId !== 'number' ||
155:     !Number.isInteger(marker.scheduledTaskId) ||
156:     marker.scheduledTaskId < 1
157:   ) {
158:     return { scheduleKind: marker.scheduledKind }
159:   }
160:   return {
161:     scheduleKind: marker.scheduledKind,
162:     scheduledTaskId: marker.scheduledTaskId,
163:   }
164: }
165: 
166: type StartOptions = {
167:   token: string
168:   appId?: string
169:   /** When true, all new sessions from channel messages create git worktrees */
170:   useWorktrees?: boolean
171: }
172: 
173: export async function createDiscordClient() {
174:   // Read REST API URL lazily so built-in mode can set store.discordBaseUrl
175:   // after module import but before client creation.
176:   const restApiUrl = getDiscordRestApiUrl()
177:   return new Client({
178:     intents: [
179:       GatewayIntentBits.Guilds,
180:       GatewayIntentBits.GuildMessages,
181:       GatewayIntentBits.MessageContent,
182:       GatewayIntentBits.GuildVoiceStates,
183:     ],
184:     partials: [
185:       Partials.Channel,
186:       Partials.Message,
187:       Partials.User,
188:       Partials.ThreadMember,
189:     ],
190:     rest: { api: restApiUrl },
191:   })
192: }
193: 
194: export async function startDiscordBot({
195:   token,
196:   appId,
197:   discordClient,
198:   useWorktrees,
199: }: StartOptions & { discordClient?: Client }) {
200:   if (!discordClient) {
201:     discordClient = await createDiscordClient()
202:   }
203: 
204:   let currentAppId: string | undefined = appId
205: 
206:   const setupHandlers = async (c: Client<true>) => {
207:     discordLogger.log(`Discord bot logged in as ${c.user.tag}`)
208:     discordLogger.log(`Connected to ${c.guilds.cache.size} guild(s)`)
209:     discordLogger.log(`Bot user ID: ${c.user.id}`)
210: 
211:     if (!currentAppId) {
212:       await c.application?.fetch()
213:       currentAppId = c.application?.id
214: 
215:       if (!currentAppId) {
216:         discordLogger.error('Could not get application ID')
217:         throw new Error('Failed to get bot application ID')
218:       }
219:       discordLogger.log(`Bot Application ID (fetched): ${currentAppId}`)
220:     } else {
221:       discordLogger.log(`Bot Application ID (provided): ${currentAppId}`)
222:     }
223: 
224:     voiceLogger.log(
225:       `[READY] Bot is ready and will only respond to channels with app ID: ${currentAppId}`,
226:     )
227: 
228:     registerInteractionHandler({ discordClient: c, appId: currentAppId })
229:     registerVoiceStateHandler({ discordClient: c, appId: currentAppId })
230: 
231:     // Channel logging is informational only; do it in background so startup stays responsive.
232:     void (async () => {
233:       for (const guild of c.guilds.cache.values()) {
234:         discordLogger.log(`${guild.name} (${guild.id})`)
235: 
236:         const channels = await getChannelsWithDescriptions(guild)
237:         const kimakiChannels = channels.filter(
238:           (ch) =>
239:             ch.kimakiDirectory &&
240:             (!ch.kimakiApp || ch.kimakiApp === currentAppId),
241:         )
242: 
243:         if (kimakiChannels.length > 0) {
244:           discordLogger.log(
245:             `  Found ${kimakiChannels.length} channel(s) for this bot:`,
246:           )
247:           for (const channel of kimakiChannels) {
248:             discordLogger.log(
249:               `  - #${channel.name}: ${channel.kimakiDirectory}`,
250:             )
251:           }
252:           continue
253:         }
254: 
255:         discordLogger.log('  No channels for this bot')
256:       }
257:     })().catch((error) => {
258:       discordLogger.warn(
259:         `Background guild channel scan failed: ${error instanceof Error ? error.message : String(error)}`,
260:       )
261:     })
262:   }
263: 
264:   // If client is already ready (was logged in before being passed to us),
265:   // run setup immediately. Otherwise wait for the ClientReady event.
266:   if (discordClient.isReady()) {
267:     await setupHandlers(discordClient)
268:   } else {
269:     discordClient.once(Events.ClientReady, setupHandlers)
270:   }
271: 
272:   discordClient.on(Events.MessageCreate, async (message: Message) => {
273:     try {
274:       const isSelfBotMessage = Boolean(
275:         discordClient.user && message.author?.id === discordClient.user.id,
276:       )
277:       const promptMarker = parseEmbedFooterMarker<ThreadStartMarker>({
278:         footer: message.embeds[0]?.footer?.text,
279:       })
280:       const isCliInjectedPrompt = Boolean(
281:         isSelfBotMessage && promptMarker?.cliThreadPrompt,
282:       )
283:       const sessionStartSource = isCliInjectedPrompt
284:         ? parseSessionStartSourceFromMarker(promptMarker)
285:         : undefined
286:       const cliInjectedUsername = isCliInjectedPrompt
287:         ? promptMarker?.username || 'kimaki-cli'
288:         : undefined
289:       const cliInjectedUserId = isCliInjectedPrompt
290:         ? promptMarker?.userId
291:         : undefined
292:       const cliInjectedAgent = isCliInjectedPrompt
293:         ? promptMarker?.agent
294:         : undefined
295:       const cliInjectedModel = isCliInjectedPrompt
296:         ? promptMarker?.model
297:         : undefined
298: 
299:       // Always ignore our own messages (unless CLI-injected prompt above).
300:       // Without this, assigning the Kimaki role to the bot itself would loop.
301:       if (isSelfBotMessage && !isCliInjectedPrompt) {
302:         return
303:       }
304: 
305:       // Allow bot messages through if the bot has the "Kimaki" role assigned.
306:       // This enables multi-agent orchestration where other bots (e.g. an
307:       // orchestrator) can @mention Kimaki and trigger sessions like a human.
308:       if (message.author?.bot) {
309:         if (!hasKimakiBotPermission(message.member)) {
310:           return
311:         }
312:       }
313: 
314:       // Ignore messages that start with a mention of another user (not the bot).
315:       // These are likely users talking to each other, not the bot.
316:       const leadingMentionMatch = message.content?.match(/^<@!?(\d+)>/)
317:       if (leadingMentionMatch) {
318:         const mentionedUserId = leadingMentionMatch[1]
319:         if (mentionedUserId !== discordClient.user?.id) {
320:           return
321:         }
322:       }
323: 
324:       if (message.partial) {
325:         discordLogger.log(`Fetching partial message ${message.id}`)
326:         const fetched = await errore.tryAsync({
327:           try: () => message.fetch(),
328:           catch: (e) => e as Error,
329:         })
330:         if (fetched instanceof Error) {
331:           discordLogger.log(
332:             `Failed to fetch partial message ${message.id}:`,
333:             fetched.message,
334:           )
335:           return
336:         }
337:       }
338: 
339:       // Check mention mode BEFORE permission check for text channels.
340:       // When mention mode is enabled, users without Kimaki role can message
341:       // without getting a permission error - we just silently ignore.
342:       const channel = message.channel
343:       if (channel.type === ChannelType.GuildText && !isCliInjectedPrompt) {
344:         const textChannel = channel as TextChannel
345:         const mentionModeEnabled = await getChannelMentionMode(textChannel.id)
346:         if (mentionModeEnabled) {
347:           const botMentioned =
348:             discordClient.user && message.mentions.has(discordClient.user.id)
349:           const isShellCommand = message.content?.startsWith('!')
350:           if (!botMentioned && !isShellCommand) {

(Showing lines 151-350 of 1228. Use offset=351 to continue.)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/interaction-handler.ts
limit: 100

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/interaction-handler.ts</path>
<type>file</type>
<content>1: // Discord slash command and interaction handler.
2: // Processes all slash commands (/session, /resume, /fork, /model, /abort, etc.)
3: // and manages autocomplete, select menu interactions for the bot.
4: 
5: import {
6:   Events,
7:   MessageFlags,
8:   type Client,
9:   type Interaction,
10: } from 'discord.js'
11: import {
12:   handleSessionCommand,
13:   handleSessionAutocomplete,
14: } from './commands/session.js'
15: import { handleNewWorktreeCommand } from './commands/worktree.js'
16: import { handleMergeWorktreeCommand } from './commands/merge-worktree.js'
17: import { handleToggleWorktreesCommand } from './commands/worktree-settings.js'
18: import { handleToggleMentionModeCommand } from './commands/mention-mode.js'
19: import {
20:   handleResumeCommand,
21:   handleResumeAutocomplete,
22: } from './commands/resume.js'
23: import {
24:   handleAddProjectCommand,
25:   handleAddProjectAutocomplete,
26: } from './commands/add-project.js'
27: import {
28:   handleRemoveProjectCommand,
29:   handleRemoveProjectAutocomplete,
30: } from './commands/remove-project.js'
31: import { handleCreateNewProjectCommand } from './commands/create-new-project.js'
32: import { handlePermissionButton } from './commands/permissions.js'
33: import { handleAbortCommand } from './commands/abort.js'
34: import { handleCompactCommand } from './commands/compact.js'
35: import { handleShareCommand } from './commands/share.js'
36: import { handleDiffCommand } from './commands/diff.js'
37: import { handleForkCommand, handleForkSelectMenu } from './commands/fork.js'
38: import {
39:   handleModelCommand,
40:   handleProviderSelectMenu,
41:   handleModelSelectMenu,
42:   handleModelScopeSelectMenu,
43: } from './commands/model.js'
44: import { handleUnsetModelCommand } from './commands/unset-model.js'
45: import {
46:   handleLoginCommand,
47:   handleLoginProviderSelectMenu,
48:   handleLoginMethodSelectMenu,
49:   handleApiKeyModalSubmit,
50: } from './commands/login.js'
51: import {
52:   handleTranscriptionApiKeyButton,
53:   handleTranscriptionApiKeyCommand,
54:   handleTranscriptionApiKeyModalSubmit,
55: } from './commands/gemini-apikey.js'
56: import {
57:   handleAgentCommand,
58:   handleAgentSelectMenu,
59:   handleQuickAgentCommand,
60: } from './commands/agent.js'
61: import { handleAskQuestionSelectMenu } from './commands/ask-question.js'
62: import {
63:   handleFileUploadButton,
64:   handleFileUploadModalSubmit,
65: } from './commands/file-upload.js'
66: import { handleActionButton } from './commands/action-buttons.js'
67: import {
68:   handleQueueCommand,
69:   handleClearQueueCommand,
70:   handleQueueCommandCommand,
71:   handleQueueCommandAutocomplete,
72: } from './commands/queue.js'
73: import { handleUndoCommand, handleRedoCommand } from './commands/undo-redo.js'
74: import { handleUserCommand } from './commands/user-command.js'
75: import { handleVerbosityCommand } from './commands/verbosity.js'
76: import { handleRestartOpencodeServerCommand } from './commands/restart-opencode-server.js'
77: import { handleRunCommand } from './commands/run-command.js'
78: import { handleContextUsageCommand } from './commands/context-usage.js'
79: import { handleSessionIdCommand } from './commands/session-id.js'
80: import { handleUpgradeAndRestartCommand } from './commands/upgrade.js'
81: import { handleModelVariantSelectMenu } from './commands/model.js'
82: import { hasKimakiBotPermission } from './discord-utils.js'
83: import { createLogger, LogPrefix } from './logger.js'
84: import { notifyError } from './sentry.js'
85: 
86: const interactionLogger = createLogger(LogPrefix.INTERACTION)
87: 
88: export function registerInteractionHandler({
89:   discordClient,
90:   appId,
91: }: {
92:   discordClient: Client
93:   appId: string
94: }) {
95:   interactionLogger.log('[REGISTER] Interaction handler registered')
96: 
97:   discordClient.on(
98:     Events.InteractionCreate,
99:     async (interaction: Interaction) => {
100:       try {

(Showing lines 1-100 of 458. Use offset=101 to continue.)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/session-handler.ts
limit: 100

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/session-handler.ts</path>
<type>file</type>
<content>1: // OpenCode session lifecycle manager.
2: // Creates, maintains, and sends prompts to OpenCode sessions from Discord threads.
3: // Handles streaming events, permissions, abort signals, and message queuing.
4: 
5: import type {
6:   Part,
7:   PermissionRequest,
8:   QuestionRequest,
9: } from '@opencode-ai/sdk/v2'
10: import type { DiscordFileAttachment } from './message-formatting.js'
11: import { ChannelType, type Message, type ThreadChannel } from 'discord.js'
12: import prettyMilliseconds from 'pretty-ms'
13: import fs from 'node:fs'
14: import path from 'node:path'
15: import { xdgState } from 'xdg-basedir'
16: import {
17:   getSessionAgent,
18:   getSessionModel,
19:   getVariantCascade,
20:   getChannelAgent,
21:   setSessionAgent,
22:   getThreadWorktree,
23:   getChannelVerbosity,
24:   getThreadSession,
25:   setThreadSession,
26:   getPartMessageIds,
27:   setPartMessage,
28:   getChannelDirectory,
29:   setSessionStartSource,
30:   type ScheduledTaskScheduleKind,
31: } from './database.js'
32: import {
33:   ensureSessionPreferencesSnapshot,
34:   getCurrentModelInfo,
35: } from './commands/model.js'
36: import {
37:   initializeOpencodeForDirectory,
38:   getOpencodeServers,
39:   getOpencodeClient,
40: } from './opencode.js'
41: import {
42:   sendThreadMessage,
43:   resolveWorkingDirectory,
44:   NOTIFY_MESSAGE_FLAGS,
45:   SILENT_MESSAGE_FLAGS,
46: } from './discord-utils.js'
47: import { formatPart } from './message-formatting.js'
48: import {
49:   getOpencodeSystemMessage,
50:   type AgentInfo,
51:   type WorktreeInfo,
52: } from './system-message.js'
53: import { createLogger, LogPrefix } from './logger.js'
54: import { isAbortError } from './utils.js'
55: import { SessionAbortError } from './errors.js'
56: import { notifyError } from './sentry.js'
57: import {
58:   showAskUserQuestionDropdowns,
59:   cancelPendingQuestion,
60:   pendingQuestionContexts,
61: } from './commands/ask-question.js'
62: import {
63:   showPermissionButtons,
64:   cleanupPermissionContext,
65:   addPermissionRequestToContext,
66:   arePatternsCoveredBy,
67: } from './commands/permissions.js'
68: import { cancelPendingFileUpload } from './commands/file-upload.js'
69: import {
70:   cancelPendingActionButtons,
71:   showActionButtons,
72:   waitForQueuedActionButtonsRequest,
73: } from './commands/action-buttons.js'
74: import {
75:   getThinkingValuesForModel,
76:   matchThinkingValue,
77: } from './thinking-utils.js'
78: import { execAsync } from './worktree-utils.js'
79: import * as errore from 'errore'
80: import * as sessionRunState from './session-handler/state.js'
81: 
82: const sessionLogger = createLogger(LogPrefix.SESSION)
83: const voiceLogger = createLogger(LogPrefix.VOICE)
84: const discordLogger = createLogger(LogPrefix.DISCORD)
85: 
86: export const abortControllers = new Map<string, AbortController>()
87: 
88: /** Format opencode session error with status, provider, and response body for debugging. */
89: function formatSessionError(error?: {
90:   data?: {
91:     message?: string
92:     statusCode?: number
93:     providerID?: string
94:     isRetryable?: boolean
95:     responseBody?: string
96:   }
97:   name?: string
98:   message?: string
99: }): string {
100:   const name = error?.name || 'Error'

(Showing lines 1-100 of 2668. Use offset=101 to continue.)
</content>
```


*Completed in 4.9s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/discord-bot.ts
offset: 351
limit: 300

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/discord-bot.ts</path>
<type>file</type>
<content>351:             voiceLogger.log(`[IGNORED] Mention mode enabled, bot not mentioned`)
352:             return
353:           }
354:         }
355:       }
356: 
357:       if (!isCliInjectedPrompt && message.guild && message.member) {
358:         if (hasNoKimakiRole(message.member)) {
359:           await message.reply({
360:             content: `You have the **no-kimaki** role which blocks bot access.\nRemove this role to use Kimaki.`,
361:             flags: SILENT_MESSAGE_FLAGS,
362:           })
363:           return
364:         }
365: 
366:         if (!hasKimakiBotPermission(message.member)) {
367:           await message.reply({
368:             content: `You don't have permission to start sessions.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
369:             flags: SILENT_MESSAGE_FLAGS,
370:           })
371:           return
372:         }
373:       }
374: 
375:       const isThread = [
376:         ChannelType.PublicThread,
377:         ChannelType.PrivateThread,
378:         ChannelType.AnnouncementThread,
379:       ].includes(channel.type)
380: 
381:       if (isThread) {
382:         const thread = channel as ThreadChannel
383:         discordLogger.log(`Message in thread ${thread.name} (${thread.id})`)
384: 
385:         const parent = thread.parent as TextChannel | null
386:         let projectDirectory: string | undefined
387:         let channelAppId: string | undefined
388: 
389:         if (parent) {
390:           const channelConfig = await getChannelDirectory(parent.id)
391:           if (channelConfig) {
392:             projectDirectory = channelConfig.directory
393:             channelAppId = channelConfig.appId || undefined
394:           }
395:         }
396: 
397:         // Check if this thread is a worktree thread
398:         const worktreeInfo = await getThreadWorktree(thread.id)
399:         if (worktreeInfo) {
400:           if (worktreeInfo.status === 'pending') {
401:             await message.reply({
402:               content: '⏳ Worktree is still being created. Please wait...',
403:               flags: SILENT_MESSAGE_FLAGS,
404:             })
405:             return
406:           }
407:           if (worktreeInfo.status === 'error') {
408:             await message.reply({
409:               content: `❌ Worktree creation failed: ${(worktreeInfo.error_message || '').slice(0, 1900)}`,
410:               flags: SILENT_MESSAGE_FLAGS,
411:             })
412:             return
413:           }
414:           // Use original project directory for OpenCode server (session lives there)
415:           // The worktree directory is passed via query.directory in prompt/command calls
416:           if (worktreeInfo.project_directory) {
417:             projectDirectory = worktreeInfo.project_directory
418:             discordLogger.log(
419:               `Using project directory: ${projectDirectory} (worktree: ${worktreeInfo.worktree_directory})`,
420:             )
421:           }
422:         }
423: 
424:         if (channelAppId && channelAppId !== currentAppId) {
425:           voiceLogger.log(
426:             `[IGNORED] Thread belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
427:           )
428:           return
429:         }
430: 
431:         if (projectDirectory && !fs.existsSync(projectDirectory)) {
432:           discordLogger.error(`Directory does not exist: ${projectDirectory}`)
433:           await message.reply({
434:             content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
435:             flags: SILENT_MESSAGE_FLAGS,
436:           })
437:           return
438:         }
439: 
440:         // ! prefix runs a shell command instead of starting/continuing a session
441:         // Use worktree directory if available, so commands run in the worktree cwd
442:         if (message.content?.startsWith('!') && projectDirectory) {
443:           const shellCmd = message.content.slice(1).trim()
444:           if (shellCmd) {
445:             const shellDir =
446:               worktreeInfo?.status === 'ready' &&
447:               worktreeInfo.worktree_directory
448:                 ? worktreeInfo.worktree_directory
449:                 : projectDirectory
450:             const loadingReply = await message.reply({
451:               content: `Running \`${shellCmd.slice(0, 1900)}\`...`,
452:             })
453:             const result = await runShellCommand({
454:               command: shellCmd,
455:               directory: shellDir,
456:             })
457:             await loadingReply.edit({ content: result })
458:             return
459:           }
460:         }
461: 
462:         // Chain onto per-thread queue so messages (voice transcription + text)
463:         // are processed in Discord arrival order, not completion order.
464:         const hasVoiceAttachment = message.attachments.some((a) => {
465:           return a.contentType?.startsWith('audio/')
466:         })
467: 
468:         const prev = threadMessageQueue.get(thread.id)
469: 
470:         if (prev) {
471:           // TODO: Voice queue intent is currently disabled because this flow is
472:           // unreliable for voice replies. Revisit queueing support for voice
473:           // messages after a robust design is implemented and validated.
474:           // Another message is being processed — abort it immediately so this
475:           // queued message can start as soon as possible.
476:           const sdkDirectory =
477:             worktreeInfo?.status === 'ready' && worktreeInfo.worktree_directory
478:               ? worktreeInfo.worktree_directory
479:               : projectDirectory
480:           signalThreadInterrupt({
481:             threadId: thread.id,
482:             serverDirectory: projectDirectory,
483:             sdkDirectory,
484:           })
485:         }
486:         const task = (prev || Promise.resolve()).then(
487:           () => { return processThreadMessage() },
488:           () => { return processThreadMessage() },
489:         )
490:         threadMessageQueue.set(thread.id, task)
491:         void task.finally(() => {
492:           if (threadMessageQueue.get(thread.id) === task) {
493:             threadMessageQueue.delete(thread.id)
494:           }
495:         })
496:         await task
497:         return
498: 
499:         async function processThreadMessage() {
500:           const sessionId = await getThreadSession(thread.id)
501: 
502:           // No existing session - start a new one (e.g., replying to a notification thread)
503:           if (!sessionId) {
504:             discordLogger.log(
505:               `No session for thread ${thread.id}, starting new session`,
506:             )
507: 
508:             if (!projectDirectory) {
509:               discordLogger.log(
510:                 `Cannot start session: no project directory for thread ${thread.id}`,
511:               )
512:               return
513:             }
514: 
515:             let prompt = resolveMentions(message)
516:             const voiceResult = await processVoiceAttachment({
517:               message,
518:               thread,
519:               projectDirectory,
520:               appId: currentAppId,
521:             })
522:             if (voiceResult) {
523:               prompt = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
524:             }
525: 
526:             // If voice transcription failed and there's no text content, bail out
527:             if (hasVoiceAttachment && !voiceResult && !prompt.trim()) {
528:               return
529:             }
530: 
531:             const starterMessage = await thread
532:               .fetchStarterMessage()
533:               .catch((error) => {
534:                 discordLogger.warn(
535:                   `[SESSION] Failed to fetch starter message for thread ${thread.id}:`,
536:                   error instanceof Error ? error.message : String(error),
537:                 )
538:                 return null
539:               })
540:             if (starterMessage && starterMessage.content !== message.content) {
541:               const starterTextAttachments = await getTextAttachments(starterMessage)
542:               const starterContent = resolveMentions(starterMessage)
543:               const starterText = starterTextAttachments
544:                 ? `${starterContent}\n\n${starterTextAttachments}`
545:                 : starterContent
546:               if (starterText) {
547:                 prompt = `Context from thread:\n${starterText}\n\nUser request:\n${prompt}`
548:               }
549:             }
550: 
551:             await handleOpencodeSession({
552:               prompt,
553:               thread,
554:               projectDirectory,
555:               channelId: parent?.id || '',
556:               username:
557:                 cliInjectedUsername ||
558:                 message.member?.displayName ||
559:                 message.author.displayName,
560:               userId: cliInjectedUserId || message.author.id,
561:               appId: currentAppId,
562:               sessionStartSource,
563:               agent: cliInjectedAgent,
564:               model: cliInjectedModel,
565:             })
566:             return
567:           }
568: 
569:           voiceLogger.log(
570:             `[SESSION] Found session ${sessionId} for thread ${thread.id}`,
571:           )
572: 
573:           let messageContent = resolveMentions(message)
574:           if (isCliInjectedPrompt) {
575:             messageContent = message.content || ''
576:           }
577: 
578:           let currentSessionContext: string | undefined
579:           let lastSessionContext: string | undefined
580: 
581:           if (projectDirectory) {
582:             try {
583:               const getClient = await initializeOpencodeForDirectory(
584:                 projectDirectory,
585:                 { channelId: parent?.id },
586:               )
587:               if (getClient instanceof Error) {
588:                 voiceLogger.error(
589:                   `[SESSION] Failed to initialize OpenCode client:`,
590:                   getClient.message,
591:                 )
592:                 throw new Error(getClient.message)
593:               }
594:               const client = getClient()
595: 
596:               // get current session context (without system prompt, it would be duplicated)
597:               const result = await getCompactSessionContext({
598:                 client,
599:                 sessionId: sessionId,
600:                 includeSystemPrompt: false,
601:                 maxMessages: 15,
602:               })
603:               if (errore.isOk(result)) {
604:                 currentSessionContext = result
605:               }
606: 
607:               // get last session context (with system prompt for project context)
608:               const lastSessionResult = await getLastSessionId({
609:                 client,
610:                 excludeSessionId: sessionId,
611:               })
612:               const lastSessionId = errore.unwrapOr(lastSessionResult, null)
613:               if (lastSessionId) {
614:                 const result = await getCompactSessionContext({
615:                   client,
616:                   sessionId: lastSessionId,
617:                   includeSystemPrompt: true,
618:                   maxMessages: 10,
619:                 })
620:                 if (errore.isOk(result)) {
621:                   lastSessionContext = result
622:                 }
623:               }
624:             } catch (e) {
625:               voiceLogger.error(`Could not get session context:`, e)
626:               void notifyError(e, 'Failed to get session context')
627:             }
628:           }
629: 
630:           const voiceResult = await processVoiceAttachment({
631:             message,
632:             thread,
633:             projectDirectory,
634:             appId: currentAppId,
635:             currentSessionContext,
636:             lastSessionContext,
637:           })
638:           if (voiceResult) {
639:             messageContent = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
640:           }
641: 
642:           // If voice transcription failed (returned null) and there's no text content,
643:           // bail out — don't fire deferred interrupt or send an empty prompt.
644:           if (hasVoiceAttachment && !voiceResult && !messageContent.trim()) {
645:             return
646:           }
647: 
648:           const fileAttachments = await getFileAttachments(message)
649:           const textAttachmentsContent = await getTextAttachments(message)
650:           const promptWithAttachments = textAttachmentsContent

(Showing lines 351-650 of 1228. Use offset=651 to continue.)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/voice-handler.ts
limit: 60

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/voice-handler.ts</path>
<type>file</type>
<content>1: // Discord voice channel connection and audio stream handler.
2: // Manages joining/leaving voice channels, captures user audio, resamples to 16kHz,
3: // and routes audio to the GenAI worker for real-time voice assistant interactions.
4: import * as errore from 'errore'
5: 
6: import {
7:   VoiceConnectionStatus,
8:   EndBehaviorType,
9:   joinVoiceChannel,
10:   entersState,
11:   type VoiceConnection,
12: } from '@discordjs/voice'
13: import { exec } from 'node:child_process'
14: import fs, { createWriteStream } from 'node:fs'
15: import { mkdir } from 'node:fs/promises'
16: import path from 'node:path'
17: import { promisify } from 'node:util'
18: import { Transform, type TransformCallback } from 'node:stream'
19: import * as prism from 'prism-media'
20: import dedent from 'string-dedent'
21: import {
22:   Events,
23:   ActionRowBuilder,
24:   ButtonBuilder,
25:   ButtonStyle,
26:   type Client,
27:   type Message,
28:   type ThreadChannel,
29:   type VoiceChannel,
30:   type VoiceState,
31: } from 'discord.js'
32: import { createGenAIWorker, type GenAIWorker } from './genai-worker-wrapper.js'
33: import {
34:   getVoiceChannelDirectory,
35:   getGeminiApiKey,
36:   getTranscriptionApiKey,
37:   findTextChannelByVoiceChannel,
38: } from './database.js'
39: import {
40:   sendThreadMessage,
41:   escapeDiscordFormatting,
42:   SILENT_MESSAGE_FLAGS,
43:   hasKimakiBotPermission,
44: } from './discord-utils.js'
45: import { transcribeAudio, type TranscriptionResult } from './voice.js'
46: import { FetchError } from './errors.js'
47: 
48: import { createLogger, LogPrefix } from './logger.js'
49: import { notifyError } from './sentry.js'
50: 
51: const voiceLogger = createLogger(LogPrefix.VOICE)
52: 
53: export type VoiceConnectionData = {
54:   connection: VoiceConnection
55:   genAiWorker?: GenAIWorker
56:   userAudioStream?: fs.WriteStream
57: }
58: 
59: export const voiceConnections = new Map<string, VoiceConnectionData>()
60: 

(Showing lines 1-60 of 848. Use offset=61 to continue.)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/channel-management.ts
limit: 60

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/channel-management.ts</path>
<type>file</type>
<content>1: // Discord channel and category management.
2: // Creates and manages Kimaki project channels (text + voice pairs),
3: // extracts channel metadata from topic tags, and ensures category structure.
4: 
5: import {
6:   ChannelType,
7:   type CategoryChannel,
8:   type Guild,
9:   type TextChannel,
10: } from 'discord.js'
11: import path from 'node:path'
12: import { getChannelDirectory, setChannelDirectory } from './database.js'
13: 
14: export async function ensureKimakiCategory(
15:   guild: Guild,
16:   botName?: string,
17: ): Promise<CategoryChannel> {
18:   // Skip appending bot name if it's already "kimaki" to avoid "Kimaki kimaki"
19:   const isKimakiBot = botName?.toLowerCase() === 'kimaki'
20:   const categoryName = botName && !isKimakiBot ? `Kimaki ${botName}` : 'Kimaki'
21: 
22:   const existingCategory = guild.channels.cache.find(
23:     (channel): channel is CategoryChannel => {
24:       if (channel.type !== ChannelType.GuildCategory) {
25:         return false
26:       }
27: 
28:       return channel.name.toLowerCase() === categoryName.toLowerCase()
29:     },
30:   )
31: 
32:   if (existingCategory) {
33:     return existingCategory
34:   }
35: 
36:   return guild.channels.create({
37:     name: categoryName,
38:     type: ChannelType.GuildCategory,
39:   })
40: }
41: 
42: export async function ensureKimakiAudioCategory(
43:   guild: Guild,
44:   botName?: string,
45: ): Promise<CategoryChannel> {
46:   // Skip appending bot name if it's already "kimaki" to avoid "Kimaki Audio kimaki"
47:   const isKimakiBot = botName?.toLowerCase() === 'kimaki'
48:   const categoryName =
49:     botName && !isKimakiBot ? `Kimaki Audio ${botName}` : 'Kimaki Audio'
50: 
51:   const existingCategory = guild.channels.cache.find(
52:     (channel): channel is CategoryChannel => {
53:       if (channel.type !== ChannelType.GuildCategory) {
54:         return false
55:       }
56: 
57:       return channel.name.toLowerCase() === categoryName.toLowerCase()
58:     },
59:   )
60: 

(Showing lines 1-60 of 172. Use offset=61 to continue.)
</content>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/store.ts
limit: 60

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/store.ts</path>
<type>file</type>
<content>1: // Centralized zustand/vanilla store for global bot state.
2: // Replaces scattered module-level `let` variables, process.env mutations,
3: // and mutable arrays with a single immutable state atom.
4: //
5: // Phase 1: config state (set once at CLI startup, read everywhere).
6: // Future phases will move session Maps, server registry, and command
7: // pending contexts into this store.
8: //
9: // See docs/zustand-state-centralization-plan.md for the full migration plan
10: // and discord/skills/zustand-centralized-state/SKILL.md for the pattern.
11: 
12: import { createStore } from 'zustand/vanilla'
13: import type { VerbosityLevel } from './database.js'
14: 
15: // Registered user commands, populated by registerCommands() in cli.ts.
16: // discordName is the sanitized Discord slash command name (without -cmd suffix),
17: // name is the original OpenCode command name (may contain :, /, etc).
18: export type RegisteredUserCommand = {
19:   name: string
20:   discordName: string
21:   description: string
22: }
23: 
24: export type KimakiState = {
25:   // ── Minimal config state (set once at startup by CLI) ──
26:   dataDir: string | null
27:   defaultVerbosity: VerbosityLevel
28:   defaultMentionMode: boolean
29:   critiqueEnabled: boolean
30:   verboseOpencodeServer: boolean
31:   discordBaseUrl: string
32:   registeredUserCommands: RegisteredUserCommand[]
33: }
34: 
35: export const store = createStore<KimakiState>(() => ({
36:   dataDir: null,
37:   defaultVerbosity: 'text-and-essential-tools',
38:   defaultMentionMode: false,
39:   critiqueEnabled: true,
40:   verboseOpencodeServer: false,
41:   discordBaseUrl: 'https://discord.com',
42:   registeredUserCommands: [],
43: }))

(End of file - total 43 lines)
</content>
```


*Completed in 6.4s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/discord/src/discord-bot.ts
offset: 651
limit: 600

```

**Output:**
```
<path>/Users/morse/Documents/GitHub/kimakivoice/discord/src/discord-bot.ts</path>
<type>file</type>
<content>651:             ? `${messageContent}\n\n${textAttachmentsContent}`
652:             : messageContent
653:           await handleOpencodeSession({
654:             prompt: promptWithAttachments,
655:             thread,
656:             projectDirectory,
657:             originalMessage: message,
658:             images: fileAttachments,
659:             channelId: parent?.id,
660:             username:
661:               cliInjectedUsername ||
662:               message.member?.displayName ||
663:               message.author.displayName,
664:             userId: isCliInjectedPrompt ? cliInjectedUserId : message.author.id,
665:             appId: currentAppId,
666:             sessionStartSource,
667:             agent: cliInjectedAgent,
668:             model: cliInjectedModel,
669:           })
670:         }
671:       }
672: 
673:       if (channel.type === ChannelType.GuildText) {
674:         const textChannel = channel as TextChannel
675:         voiceLogger.log(
676:           `[GUILD_TEXT] Message in text channel #${textChannel.name} (${textChannel.id})`,
677:         )
678: 
679:         const channelConfig = await getChannelDirectory(textChannel.id)
680: 
681:         if (!channelConfig) {
682:           voiceLogger.log(
683:             `[IGNORED] Channel #${textChannel.name} has no project directory configured`,
684:           )
685:           return
686:         }
687: 
688:         const projectDirectory = channelConfig.directory
689:         const channelAppId = channelConfig.appId || undefined
690: 
691:         if (channelAppId && channelAppId !== currentAppId) {
692:           voiceLogger.log(
693:             `[IGNORED] Channel belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
694:           )
695:           return
696:         }
697: 
698:         // Note: Mention mode is checked early in the handler (before permission check)
699:         // to avoid sending permission errors to users who just didn't @mention the bot.
700: 
701:         discordLogger.log(`DIRECTORY: Found kimaki.directory: ${projectDirectory}`)
702:         if (channelAppId) {
703:           discordLogger.log(`APP: Channel app ID: ${channelAppId}`)
704:         }
705: 
706:         if (!fs.existsSync(projectDirectory)) {
707:           discordLogger.error(`Directory does not exist: ${projectDirectory}`)
708:           await message.reply({
709:             content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
710:             flags: SILENT_MESSAGE_FLAGS,
711:           })
712:           return
713:         }
714: 
715:         // ! prefix runs a shell command instead of starting a session
716:         if (message.content?.startsWith('!')) {
717:           const shellCmd = message.content.slice(1).trim()
718:           if (shellCmd) {
719:             const loadingReply = await message.reply({
720:               content: `Running \`${shellCmd.slice(0, 1900)}\`...`,
721:             })
722:             const result = await runShellCommand({
723:               command: shellCmd,
724:               directory: projectDirectory,
725:             })
726:             await loadingReply.edit({ content: result })
727:             return
728:           }
729:         }
730: 
731:         const hasVoice = message.attachments.some((a) =>
732:           a.contentType?.startsWith('audio/'),
733:         )
734: 
735:         const baseThreadName = hasVoice
736:           ? 'Voice Message'
737:           : stripMentions(message.content || '')
738:               .replace(/\s+/g, ' ')
739:               .trim() || 'kimaki thread'
740: 
741:         // Check if worktrees should be enabled (CLI flag OR channel setting)
742:         const shouldUseWorktrees =
743:           useWorktrees || (await getChannelWorktreesEnabled(textChannel.id))
744: 
745:         // Add worktree prefix if worktrees are enabled
746:         const threadName = shouldUseWorktrees
747:           ? `${WORKTREE_PREFIX}${baseThreadName}`
748:           : baseThreadName
749: 
750:         const thread = await message.startThread({
751:           name: threadName.slice(0, 80),
752:           autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
753:           reason: 'Start Claude session',
754:         })
755: 
756:         // Add user to thread so it appears in their sidebar
757:         await thread.members.add(message.author.id)
758: 
759:         discordLogger.log(`Created thread "${thread.name}" (${thread.id})`)
760: 
761:         // Create worktree if worktrees are enabled (CLI flag OR channel setting)
762:         let sessionDirectory = projectDirectory
763:         if (shouldUseWorktrees) {
764:           const worktreeName = formatWorktreeName(
765:             hasVoice ? `voice-${Date.now()}` : threadName.slice(0, 50),
766:           )
767:           discordLogger.log(`[WORKTREE] Creating worktree: ${worktreeName}`)
768: 
769:           // Store pending worktree immediately so bot knows about it
770:           await createPendingWorktree({
771:             threadId: thread.id,
772:             worktreeName,
773:             projectDirectory,
774:           })
775: 
776:           const worktreeResult = await createWorktreeWithSubmodules({
777:             directory: projectDirectory,
778:             name: worktreeName,
779:           })
780: 
781:           if (worktreeResult instanceof Error) {
782:             const errMsg = worktreeResult.message
783:             discordLogger.error(`[WORKTREE] Creation failed: ${errMsg}`)
784:             await setWorktreeError({
785:               threadId: thread.id,
786:               errorMessage: errMsg,
787:             })
788:             await thread.send({
789:               content: `⚠️ Failed to create worktree: ${errMsg}\nUsing main project directory instead.`,
790:               flags: SILENT_MESSAGE_FLAGS,
791:             })
792:           } else {
793:             await setWorktreeReady({
794:               threadId: thread.id,
795:               worktreeDirectory: worktreeResult.directory,
796:             })
797:             sessionDirectory = worktreeResult.directory
798:             discordLogger.log(
799:               `[WORKTREE] Created: ${worktreeResult.directory} (branch: ${worktreeResult.branch})`,
800:             )
801:             // React with tree emoji to mark as worktree thread
802:             await reactToThread({
803:               rest: discordClient.rest,
804:               threadId: thread.id,
805:               channelId: thread.parentId || undefined,
806:               emoji: '🌳',
807:             })
808:           }
809:         }
810: 
811:         let messageContent = resolveMentions(message)
812:         const voiceResult = await processVoiceAttachment({
813:           message,
814:           thread,
815:           projectDirectory: sessionDirectory,
816:           isNewThread: true,
817:           appId: currentAppId,
818:         })
819:         if (voiceResult) {
820:           messageContent = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
821:         }
822: 
823:         // If voice transcription failed and there's no text content, bail out
824:         if (hasVoice && !voiceResult && !messageContent.trim()) {
825:           return
826:         }
827: 
828:         const fileAttachments = await getFileAttachments(message)
829:         const textAttachmentsContent = await getTextAttachments(message)
830:         const promptWithAttachments = textAttachmentsContent
831:           ? `${messageContent}\n\n${textAttachmentsContent}`
832:           : messageContent
833:         await handleOpencodeSession({
834:           prompt: promptWithAttachments,
835:           thread,
836:           projectDirectory: sessionDirectory,
837:           originalMessage: message,
838:           images: fileAttachments,
839:           channelId: textChannel.id,
840:           username: message.member?.displayName || message.author.displayName,
841:           userId: message.author.id,
842:           appId: currentAppId,
843:         })
844:       } else {
845:         discordLogger.log(`Channel type ${channel.type} is not supported`)
846:       }
847:     } catch (error) {
848:       voiceLogger.error('Discord handler error:', error)
849:       void notifyError(error, 'MessageCreate handler error')
850:       try {
851:         const errMsg = (
852:           error instanceof Error ? error.message : String(error)
853:         ).slice(0, 1900)
854:         await message.reply({
855:           content: `Error: ${errMsg}`,
856:           flags: SILENT_MESSAGE_FLAGS,
857:         })
858:       } catch (sendError) {
859:         voiceLogger.error(
860:           'Discord handler error (fallback):',
861:           sendError instanceof Error ? sendError.message : String(sendError),
862:         )
863:       }
864:     }
865:   })
866: 
867:   // Handle bot-initiated threads created by `kimaki send` (without --notify-only)
868:   // Uses JSON embed marker to pass options (start, worktree name)
869:   discordClient.on(Events.ThreadCreate, async (thread, newlyCreated) => {
870:     try {
871:       if (!newlyCreated) {
872:         return
873:       }
874: 
875:       // Only handle threads in text channels
876:       const parent = thread.parent as TextChannel | null
877:       if (!parent || parent.type !== ChannelType.GuildText) {
878:         return
879:       }
880: 
881:       // Get the starter message to check for auto-start marker
882:       const starterMessage = await thread
883:         .fetchStarterMessage()
884:         .catch((error) => {
885:           discordLogger.warn(
886:             `[THREAD_CREATE] Failed to fetch starter message for thread ${thread.id}:`,
887:             error instanceof Error ? error.message : String(error),
888:           )
889:           return null
890:         })
891:       if (!starterMessage) {
892:         discordLogger.log(
893:           `[THREAD_CREATE] Could not fetch starter message for thread ${thread.id}`,
894:         )
895:         return
896:       }
897: 
898:       // Parse JSON marker from embed footer
899:       const embedFooter = starterMessage.embeds[0]?.footer?.text
900:       if (!embedFooter) {
901:         return
902:       }
903: 
904:       const marker = parseEmbedFooterMarker<ThreadStartMarker>({
905:         footer: embedFooter,
906:       })
907:       if (!marker) {
908:         return
909:       }
910: 
911:       if (!marker.start) {
912:         return // Not an auto-start thread
913:       }
914: 
915:       discordLogger.log(
916:         `[BOT_SESSION] Detected bot-initiated thread: ${thread.name}`,
917:       )
918: 
919:       const textAttachmentsContent = await getTextAttachments(starterMessage)
920:       const messageText = resolveMentions(starterMessage).trim()
921:       const prompt = textAttachmentsContent
922:         ? `${messageText}\n\n${textAttachmentsContent}`
923:         : messageText
924:       if (!prompt) {
925:         discordLogger.log(`[BOT_SESSION] No prompt found in starter message`)
926:         return
927:       }
928: 
929:       // Get directory from database
930:       const channelConfig = await getChannelDirectory(parent.id)
931: 
932:       if (!channelConfig) {
933:         discordLogger.log(
934:           `[BOT_SESSION] No project directory configured for parent channel`,
935:         )
936:         return
937:       }
938: 
939:       const projectDirectory = channelConfig.directory
940:       const channelAppId = channelConfig.appId || undefined
941: 
942:       if (channelAppId && channelAppId !== currentAppId) {
943:         discordLogger.log(`[BOT_SESSION] Channel belongs to different bot app`)
944:         return
945:       }
946: 
947:       if (!fs.existsSync(projectDirectory)) {
948:         discordLogger.error(
949:           `[BOT_SESSION] Directory does not exist: ${projectDirectory}`,
950:         )
951:         await thread.send({
952:           content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
953:           flags: SILENT_MESSAGE_FLAGS,
954:         })
955:         return
956:       }
957: 
958:       // Create worktree if requested
959:       const sessionDirectory: string = await (async () => {
960:         if (!marker.worktree) {
961:           return projectDirectory
962:         }
963: 
964:         discordLogger.log(`[BOT_SESSION] Creating worktree: ${marker.worktree}`)
965: 
966:         const worktreeStatusMessage = await thread
967:           .send({
968:             content: `🌳 Creating worktree: ${marker.worktree}\n⏳ Setting up (this can take a bit)...`,
969:             flags: SILENT_MESSAGE_FLAGS,
970:           })
971:           .catch(() => {
972:             return null
973:           })
974: 
975:         await createPendingWorktree({
976:           threadId: thread.id,
977:           worktreeName: marker.worktree,
978:           projectDirectory,
979:         })
980: 
981:         const worktreeResult = await createWorktreeWithSubmodules({
982:           directory: projectDirectory,
983:           name: marker.worktree,
984:         })
985: 
986:         if (errore.isError(worktreeResult)) {
987:           discordLogger.error(
988:             `[BOT_SESSION] Worktree creation failed: ${worktreeResult.message}`,
989:           )
990:           await setWorktreeError({
991:             threadId: thread.id,
992:             errorMessage: worktreeResult.message,
993:           })
994:           await (worktreeStatusMessage?.edit({
995:             content: `⚠️ Failed to create worktree: ${worktreeResult.message}\nUsing main project directory instead.`,
996:             flags: SILENT_MESSAGE_FLAGS,
997:           }) ||
998:             thread.send({
999:               content: `⚠️ Failed to create worktree: ${worktreeResult.message}\nUsing main project directory instead.`,
1000:               flags: SILENT_MESSAGE_FLAGS,
1001:             }))
1002:           return projectDirectory
1003:         }
1004: 
1005:         await setWorktreeReady({
1006:           threadId: thread.id,
1007:           worktreeDirectory: worktreeResult.directory,
1008:         })
1009:         discordLogger.log(
1010:           `[BOT_SESSION] Worktree created: ${worktreeResult.directory}`,
1011:         )
1012:         // React with tree emoji to mark as worktree thread
1013:         await reactToThread({
1014:           rest: discordClient.rest,
1015:           threadId: thread.id,
1016:           channelId: thread.parentId || undefined,
1017:           emoji: '🌳',
1018:         })
1019:         await (worktreeStatusMessage?.edit({
1020:           content: `🌳 **Worktree ready: ${marker.worktree}**\n📁 \`${worktreeResult.directory}\`\n🌿 Branch: \`${worktreeResult.branch}\``,
1021:           flags: SILENT_MESSAGE_FLAGS,
1022:         }) ||
1023:           thread.send({
1024:             content: `🌳 **Worktree ready: ${marker.worktree}**\n📁 \`${worktreeResult.directory}\`\n🌿 Branch: \`${worktreeResult.branch}\``,
1025:             flags: SILENT_MESSAGE_FLAGS,
1026:           }))
1027:         return worktreeResult.directory
1028:       })()
1029: 
1030:       discordLogger.log(
1031:         `[BOT_SESSION] Starting session for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}..."`,
1032:       )
1033: 
1034:       const botThreadStartSource = parseSessionStartSourceFromMarker(marker)
1035: 
1036:       await handleOpencodeSession({
1037:         prompt,
1038:         thread,
1039:         projectDirectory: sessionDirectory,
1040:         channelId: parent.id,
1041:         appId: currentAppId,
1042:         username: marker.username,
1043:         userId: marker.userId,
1044:         agent: marker.agent,
1045:         model: marker.model,
1046:         sessionStartSource: botThreadStartSource,
1047:       })
1048:     } catch (error) {
1049:       voiceLogger.error(
1050:         '[BOT_SESSION] Error handling bot-initiated thread:',
1051:         error,
1052:       )
1053:       void notifyError(error, 'ThreadCreate handler error')
1054:       try {
1055:         const errMsg = (
1056:           error instanceof Error ? error.message : String(error)
1057:         ).slice(0, 1900)
1058:         await thread.send({
1059:           content: `Error: ${errMsg}`,
1060:           flags: SILENT_MESSAGE_FLAGS,
1061:         })
1062:       } catch (sendError) {
1063:         voiceLogger.error(
1064:           '[BOT_SESSION] Failed to send error message:',
1065:           sendError instanceof Error ? sendError.message : String(sendError),
1066:         )
1067:       }
1068:     }
1069:   })
1070: 
1071:   await discordClient.login(token)
1072: 
1073:   startHeapMonitor()
1074:   const stopTaskRunner = startTaskRunner({ token })
1075: 
1076:   const handleShutdown = async (signal: string, { skipExit = false } = {}) => {
1077:     discordLogger.log(`Received ${signal}, cleaning up...`)
1078: 
1079:     if ((global as any).shuttingDown) {
1080:       discordLogger.log('Already shutting down, ignoring duplicate signal')
1081:       return
1082:     }
1083:     ;(global as any).shuttingDown = true
1084: 
1085:     try {
1086:       await stopTaskRunner()
1087: 
1088:       // Cancel pending IPC requests so plugin tools don't hang
1089:       await cancelAllPendingIpcRequests().catch((e) => {
1090:         discordLogger.warn(
1091:           'Failed to cancel pending IPC requests:',
1092:           (e as Error).message,
1093:         )
1094:       })
1095: 
1096:       const cleanupPromises: Promise<void>[] = []
1097:       for (const [guildId] of voiceConnections) {
1098:         voiceLogger.log(
1099:           `[SHUTDOWN] Cleaning up voice connection for guild ${guildId}`,
1100:         )
1101:         cleanupPromises.push(cleanupVoiceConnection(guildId))
1102:       }
1103: 
1104:       if (cleanupPromises.length > 0) {
1105:         voiceLogger.log(
1106:           `[SHUTDOWN] Waiting for ${cleanupPromises.length} voice connection(s) to clean up...`,
1107:         )
1108:         await Promise.allSettled(cleanupPromises)
1109:         discordLogger.log(`All voice connections cleaned up`)
1110:       }
1111: 
1112:       for (const [dir, server] of getOpencodeServers()) {
1113:         if (!server.process.killed) {
1114:           voiceLogger.log(
1115:             `[SHUTDOWN] Stopping OpenCode server on port ${server.port} for ${dir}`,
1116:           )
1117:           server.process.kill('SIGTERM')
1118:         }
1119:       }
1120:       getOpencodeServers().clear()
1121: 
1122:       discordLogger.log('Closing database...')
1123:       await closeDatabase()
1124: 
1125:       discordLogger.log('Stopping hrana server...')
1126:       await stopHranaServer()
1127: 
1128:       discordLogger.log('Destroying Discord client...')
1129:       discordClient.destroy()
1130: 
1131:       discordLogger.log('Cleanup complete.')
1132:       if (!skipExit) {
1133:         process.exit(0)
1134:       }
1135:     } catch (error) {
1136:       voiceLogger.error('[SHUTDOWN] Error during cleanup:', error)
1137:       if (!skipExit) {
1138:         process.exit(1)
1139:       }
1140:     }
1141:   }
1142: 
1143:   process.on('SIGTERM', async () => {
1144:     try {
1145:       await handleShutdown('SIGTERM')
1146:     } catch (error) {
1147:       voiceLogger.error('[SIGTERM] Error during shutdown:', error)
1148:       process.exit(1)
1149:     }
1150:   })
1151: 
1152:   process.on('SIGINT', async () => {
1153:     try {
1154:       await handleShutdown('SIGINT')
1155:     } catch (error) {
1156:       voiceLogger.error('[SIGINT] Error during shutdown:', error)
1157:       process.exit(1)
1158:     }
1159:   })
1160: 
1161:   process.on('SIGUSR1', () => {
1162:     discordLogger.log('Received SIGUSR1, writing heap snapshot...')
1163:     try {
1164:       writeHeapSnapshot()
1165:     } catch (e) {
1166:       discordLogger.error(
1167:         'Failed to write heap snapshot:',
1168:         e instanceof Error ? e.message : String(e),
1169:       )
1170:     }
1171:   })
1172: 
1173:   process.on('SIGUSR2', async () => {
1174:     discordLogger.log('Received SIGUSR2, restarting after cleanup...')
1175:     try {
1176:       await handleShutdown('SIGUSR2', { skipExit: true })
1177:     } catch (error) {
1178:       voiceLogger.error('[SIGUSR2] Error during shutdown:', error)
1179:     }
1180:     const { spawn } = await import('node:child_process')
1181:     // Strip __KIMAKI_CHILD so the new process goes through the respawn wrapper in bin.js.
1182:     // V8 heap flags are already in process.execArgv from the initial spawn, and bin.ts
1183:     // will re-inject them if missing, so no need to add them here.
1184:     const env = { ...process.env }
1185:     delete env.__KIMAKI_CHILD
1186:     spawn(process.argv[0]!, [...process.execArgv, ...process.argv.slice(1)], {
1187:       stdio: 'inherit',
1188:       detached: true,
1189:       cwd: process.cwd(),
1190:       env,
1191:     }).unref()
1192:     process.exit(0)
1193:   })
1194: 
1195:   process.on('uncaughtException', (error) => {
1196:     discordLogger.error('Uncaught exception:', formatErrorWithStack(error))
1197:     notifyError(error, 'Uncaught exception in bot process')
1198:     void handleShutdown('uncaughtException', { skipExit: true }).catch(
1199:       (shutdownError) => {
1200:         discordLogger.error(
1201:           '[uncaughtException] shutdown failed:',
1202:           formatErrorWithStack(shutdownError),
1203:         )
1204:       },
1205:     )
1206:     setTimeout(() => {
1207:       process.exit(1)
1208:     }, 250).unref()
1209:   })
1210: 
1211:   process.on('unhandledRejection', (reason, promise) => {
1212:     if ((global as any).shuttingDown) {
1213:       discordLogger.log('Ignoring unhandled rejection during shutdown:', reason)
1214:       return
1215:     }
1216:     discordLogger.error(
1217:       'Unhandled rejection:',
1218:       formatErrorWithStack(reason),
1219:       'at promise:',
1220:       promise,
1221:     )
1222:     const error =
1223:       reason instanceof Error
1224:         ? reason
1225:         : new Error(formatErrorWithStack(reason))
1226:     void notifyError(error, 'Unhandled rejection in bot process')
1227:   })
1228: }

(End of file - total 1228 lines)
</content>
```


*Completed in 3.8s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Now I have a thorough understanding of the kimaki codebase. Here's the full analysis:

---

## Kimaki Discord Features Inventory

Kimaki is a **very deep** discord.js integration. Here's everything it does:

### Core Gateway features (requires persistent WebSocket)
- **MessageCreate** - The primary event loop (~600 lines). Receives every message, routes to sessions
- **ThreadCreate** - Detects bot-initiated threads, auto-starts sessions
- **InteractionCreate** - 33 slash commands, select menus, modals, autocomplete, buttons
- **VoiceStateUpdate** - Joins voice channels, captures audio streams, real-time transcription via Gemini

### Discord API usage (REST + Gateway)
- **Thread creation** - `message.startThread()` with auto-archive duration
- **Thread member management** - `thread.members.add(userId)`
- **Reactions** - `reactToThread()` via REST API
- **Message splitting** - Custom 2000-char chunking with markdown preservation
- **Embed footer markers** - YAML in embed footers for CLI-injected metadata
- **Partial message fetching** - `message.fetch()` for partial events
- **Guild channel scanning** - Category management, channel topic parsing
- **Message flags** - `SILENT_MESSAGE_FLAGS`, `NOTIFY_MESSAGE_FLAGS`
- **Slash command modals** - Login API key modal, file upload modal, transcription key modal
- **Select menus** - Model picker, agent picker, fork target picker, ask-question dropdowns
- **Buttons** - Permission approve/deny, action buttons, file upload triggers
- **Autocomplete** - Session search, project paths, resume, queue commands
- **Message editing** - Streaming updates via edit
- **Channel/category creation** - `guild.channels.create()` for Kimaki categories

### Deep discord.js-specific features
- **Voice connections** - `@discordjs/voice` with `joinVoiceChannel`, opus decoding, PCM resampling
- **Per-thread message queue** - Serial processing with abort-on-new-message
- **Permission system** - Role-based (`hasKimakiBotPermission`, `hasNoKimakiRole`), member/role cache handling
- **Mention detection** - Bot mention check, role mention mode, leading mention filtering
- **CLI-injected prompts** - Bot sends messages to itself with embed markers, detected via `isSelfBotMessage`
- **Worktree management** - Git worktrees tied to Discord threads
- **Multi-bot support** - `channelAppId` filtering per channel

---

## What Chat SDK Can Cover

| Kimaki Feature | Chat SDK Support | Notes |
|---|---|---|
| Receive messages | Yes | `onNewMention` / `onSubscribedMessage` |
| Post messages | Yes | `thread.post()` |
| Reactions | Yes | `addReaction` / `onReaction` |
| Typing indicator | Yes | `startTyping()` |
| DMs | Yes | `openDM()` |
| File attachments | Yes | `extractFiles` / file uploads |
| Cards/Embeds | Yes | JSX Card system |
| Buttons | Yes | `onAction(actionId)` |
| Message editing | Yes | `editMessage()` |
| Thread history | Yes | `fetchMessages()` |
| Slash commands | Partial | Basic handler, no autocomplete |
| Cross-platform format | Yes | mdast AST conversion |

## What Chat SDK **Cannot** Do

### 1. Voice connections - Total blocker for voice features
Kimaki uses `@discordjs/voice` for real-time audio capture, opus decoding, and WebSocket voice gateway. Chat SDK has zero voice support. This is ~850 lines (`voice-handler.ts`) that would need to stay as a separate discord.js-only module.

### 2. Slash command modals - Slack only
Chat SDK modals only work on Slack (`views.open`). Discord modals (`showModal()`) are not implemented. Kimaki uses modals for API key input, file upload, and login flows.

### 3. Autocomplete - Not supported
7 commands use autocomplete (session search, project paths, resume, queue). Chat SDK's slash command handler has no autocomplete concept.

### 4. Select menus - Not supported
Model picker, agent picker, fork targets - these use Discord `StringSelectMenuBuilder`. Chat SDK only has buttons, not select menus.

### 5. Ephemeral messages - DM fallback only
Kimaki uses `MessageFlags.Ephemeral` on interaction replies. Chat SDK falls back to DMs on Discord, which is a very different UX.

### 6. Thread creation from channel messages
Kimaki's core flow is: message in channel -> create thread -> start session in thread. Chat SDK's model is event-driven (mention -> handler), not "create a thread and move the conversation there."

### 7. Embed footer markers / CLI injection
Kimaki embeds YAML in embed footers so the CLI (`kimaki send`) can inject prompts, worktree names, agent configs, scheduled task metadata. This is a custom protocol with no Chat SDK equivalent.

### 8. Per-thread serial message queue
The `threadMessageQueue` pattern (with abort-on-new-message) is core to how Kimaki handles concurrent messages. Chat SDK processes events independently with no queuing primitive.

### 9. Channel/category management
Creating Kimaki categories, scanning guild channels for topic metadata, managing voice+text channel pairs. All discord.js Guild API.

### 10. Permission system
Custom role-based permissions (`Kimaki` role, `no-kimaki` role, member cache handling for both cached and uncached interaction objects). Chat SDK has no permission layer.

### 11. Gateway intents and partials
Kimaki needs `MessageContent`, `GuildVoiceStates` intents and `Partials.Channel/Message/User/ThreadMember`. Chat SDK's built-in Gateway listener uses fixed intents.

### 12. Worktrees tied to threads
Git worktree lifecycle (create, pending, ready, error states) is deeply coupled to Discord thread lifecycle. Chat SDK's thread model is much simpler.

---

## Verdict

**This would be a massive rewrite with limited payoff.** Kimaki uses discord.js as a full-featured client, not just a webhook receiver. The bot is fundamentally a **persistent process** that:

- Maintains a Gateway WebSocket forever
- Manages voice connections
- Runs serial per-thread queues
- Handles 33 slash commands with autocomplete, modals, and select menus
- Uses custom embed-based IPC between CLI and bot

Chat SDK is designed for **serverless webhook-based bots** that receive events, respond, and go back to sleep. Kimaki is the opposite - it's a stateful, long-running daemon.

### What would make sense

If you wanted Slack support, a more practical approach would be:

1. **Extract the OpenCode session logic** into a platform-agnostic core (it mostly is already - `session-handler.ts` takes a `thread` object and posts messages to it)
2. **Create a thin Slack adapter** that maps Slack webhooks to the same session handler interface
3. **Keep discord.js** for Discord - it's doing too much platform-specific work to replace

The session handler pattern is already close to being abstractable:
```
handleOpencodeSession({ prompt, thread, projectDirectory, ... })
```

That `thread` is a discord.js `ThreadChannel`, but it could be wrapped in an interface that both Discord and Slack implement. The hard part is the 33 commands, voice, worktrees, and the CLI injection protocol - those are deeply Discord-specific and would need Slack-native equivalents designed from scratch.


*Completed in 49.1s*

### 👤 User

Voice message transcription from Discord user:

Finding the GitHub repository is if there is a GitHub issue tracking threads, the ability for the bot to create threads.


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: bash

**Input:**
```yaml
command: gh issue list -R vercel/chat --search "thread create" --limit 20
description: Search for thread creation issues

```

**Output:**
```
148	OPEN	Add ability to create thread handles	enhancement	2026-03-01T15:03:18Z

```

#### 🛠️ Tool: bash

**Input:**
```yaml
command: gh issue list -R vercel/chat --search "create thread" --limit 20
description: Search thread creation issues alt

```

**Output:**
```
148	OPEN	Add ability to create thread handles	enhancement	2026-03-01T15:03:18Z

```


*Completed in 5.3s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

#### 🛠️ Tool: bash

**Input:**
```yaml
command: gh issue view 148 -R vercel/chat
description: Read thread creation issue details

```

**Output:**
```
title:	Add ability to create thread handles
state:	OPEN
author:	danthegoodman1
labels:	enhancement
comments:	0
assignees:	
projects:	
milestone:	
number:	148
--
### Problem Statement

Right now there is no way to construct a Thread handle out of bounds (for example, adding a new message to a thread).

https://www.chat-sdk.dev/docs/adapters/slack#using-the-adapter-outside-webhooks shows:

<img width="669" height="363" alt="Image" src="https://github.com/user-attachments/assets/dfed4685-5608-4af5-8b41-50c712cb26b9" />

But that doesn't exist:

<img width="990" height="345" alt="Image" src="https://github.com/user-attachments/assets/7756b680-7891-4aa2-ac15-a16d3b5c8385" />

### Proposed Solution

Some constructor for a Thread based on the `.threadId` of a posted message

### Alternatives Considered

_No response_

### Use Case

```typescript

```

### Priority

None

### Contribution

- [ ] I am willing to help implement this feature

### Additional Context

_No response_

```


*Completed in 3.9s*

### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**

Found it. **Issue #148** on `vercel/chat`: https://github.com/vercel/chat/issues/148

It's titled **"Add ability to create thread handles"** - opened today actually. The problem is you can't construct a `Thread` object out of band. The SDK only gives you threads inside event handlers (`onNewMention`, `onSubscribedMessage`), but there's no way to:

- Create a new thread programmatically
- Get a `Thread` handle from a thread ID to post into an existing thread outside a webhook handler

This is exactly the pattern kimaki needs - the bot creates threads from channel messages, CLI-injected prompts, and scheduled tasks. Without this, you can't do the core `message in channel -> create thread -> start session` flow.

The issue is open with no comments and no assignee yet. It's labeled `enhancement`.


*Completed in 7.4s*

### 👤 User

[18m since last message | UTC: 2026-03-01 21:14:41 UTC | Local (Europe/Rome): 03/01/2026, 22:14]

Voice message transcription from Discord user:

Can we already be notified of thread messages or send messages in threads?


### 🤖 Assistant (claude-opus-4-6)

**Started using anthropic/claude-opus-4-6**



Based on what I read in the source code:

**Receiving thread messages - yes.** The `onSubscribedMessage` handler fires for any message in a thread you've called `thread.subscribe()` on. The `onNewMention` handler also fires when someone @mentions the bot in any thread. Both Discord and Slack adapters handle thread messages natively - Discord via Gateway forwarding, Slack via `thread_ts` in webhook events.

**Sending messages in threads - yes, but only from inside a handler.** When you're inside an `onNewMention` or `onSubscribedMessage` callback, you get a `Thread` object and can call `thread.post()`, `thread.startTyping()`, `thread.postEphemeral()`, etc. That works fine.

**The gap is exactly issue #148** - you can't get a `Thread` handle outside of an event handler. So you can't do:

```ts
// This doesn't exist
const thread = bot.getThread("slack:C123:1234567890.123")
await thread.post("Hey, scheduled reminder!")
```

You also can't **create** a thread. There's no `bot.createThread(channelId, name)` or equivalent. The SDK assumes threads are created by users on the platform, and the bot reacts to them.

For kimaki this means:
- **Responding in existing threads** - works, if you subscribe during the initial mention
- **Creating new threads from channel messages** - not possible through the SDK
- **CLI-injected prompts into threads** - not possible (no out-of-band thread handle)
- **Scheduled tasks posting to threads** - not possible

The adapter *does* have low-level methods like `postMessage(threadId, message)` on the adapter object directly, bypassing the `Thread` abstraction. So you could call `bot.adapters.discord.postMessage(encodedThreadId, "hello")` as a workaround, but you'd lose the cross-platform abstraction and all the `Thread` conveniences (subscribe, state, typing, etc.).


*Completed in 14.2s*
