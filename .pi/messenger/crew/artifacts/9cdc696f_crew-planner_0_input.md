# Task for crew-planner

Create a task breakdown for implementing this request.

## Request

Investigate a bug in the Kimaki Discord bot where voice transcription is incorrectly using OpenAI instead of parakeet.

**Bug Description:**
- Bot logs show `VOICE [ASR] Voice transcription: parakeet (local, default)` at startup
- But when transcribing audio, it logs `Converting audio/ogg to WAV for OpenAI compatibility`
- Then fails with `AI_APICallError` trying to connect to OpenAI at `192.168.18.210:1234`

**Expected behavior:**
- Parakeet should be used as the default ASR provider
- Audio should be transcribed locally using parakeet, not sent to OpenAI

**Files to investigate (in discord/ package):**
1. `src/voice.ts` - Main voice transcription logic
2. `src/voice-handler.ts` - Voice message handling
3. Any configuration or provider selection code related to ASR/transcription

**Questions to answer:**
1. Why does the log say parakeet is the default but OpenAI is actually being used?
2. Is there a bug in the provider selection logic?
3. Is there a configuration issue causing OpenAI to be selected?
4. Look for the code that logs "Converting audio/ogg to WAV for OpenAI compatibility" - this is the smoking gun

**Output:**
- Identify the root cause of the bug
- Provide the specific code location and fix needed

## Available Skills

Workers can load these skills on demand during task execution. When creating tasks, you may include a `skills` array with relevant skill names to help workers prioritize which to read.

  claymorphism — Claymorphism design system skill. Use when building soft, puffy, clay-like UI components with large radii, dual inner shadows, and offset outer shadows.
  context7 — Search and query up-to-date documentation for any programming library via Context7 API. Use when you need current docs, code examples, or API references for libraries and frameworks.
  debug-helper — Debug assistant for error analysis, log interpretation, and performance profiling. Use when user encounters errors, crashes, or performance issues.
  git-workflow — Git workflow assistant for branching, commits, PRs, and conflict resolution. Use when user asks about git strategy, branch management, or PR workflow.
  glassmorphism — Glassmorphism design system skill. Use when building frosted-glass UI components with blur, transparency, and layered depth effects.
  liquid-glass — Apple Liquid Glass design system. Use when building UI with translucent, depth-aware glass morphism following Apple's design language. Provides CSS tokens, component patterns, dark/light mode, and animation specs.
  neubrutalism — Neubrutalism design system skill. Use when building bold UI with thick borders, offset solid shadows, high saturation colors, and minimal border radius.
  quick-setup — Detect project type and generate .pi/ configuration. Use when setting up pi for a new project or when user asks to initialize pi config.
  web-fetch — Fetch a web page and extract readable text content. Use when user needs to retrieve or read a web page.
  web-search — Web search via DuckDuckGo. Use when the user needs to look up current information online.


You must follow this sequence strictly:
1) Understand the request
2) Review relevant code/docs/reference resources
3) Produce sequential implementation steps
4) Produce a parallel task graph

Return output in this exact section order and headings:
## 1. PRD Understanding Summary
## 2. Relevant Code/Docs/Resources Reviewed
## 3. Sequential Implementation Steps
## 4. Parallelized Task Graph

In section 4, include both:
- markdown task breakdown
- a `tasks-json` fenced block with task objects containing title, description, dependsOn, and optionally skills (array of skill names from the Available Skills list that are relevant to the task).