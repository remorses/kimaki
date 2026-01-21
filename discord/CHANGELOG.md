# Changelog

## 0.4.39

### Patch Changes

- fix **0% token usage** race condition by fetching from API instead of relying on cached values
- display **subtask events** with indexed labels (explore-1, explore-2) for better tracking
- **filter hidden agents** from agent lists
- adopt **errore typed errors** across discord bot for better error handling

## 0.4.38

### Patch Changes

- fix **duplicate "kimaki"** in category names - now creates "Kimaki" instead of "Kimaki kimaki" when bot is named kimaki

## 0.4.37

### Patch Changes

- rename `start-session` → **`send`** command (alias kept for backwards compat)
- add **`--notify-only`** flag to create notification threads without starting AI session
- add **`app_id`** column to channel_directories for multi-bot support
- fix **JS number precision loss** for large Discord IDs in CLI arguments
- add **subfolder lookup** - walks up parent directories to find closest registered project
- fix **notification thread replies** to start new session with notification as context

## 0.4.36

### Patch Changes

- add **--project** option to `start-session` CLI command as alternative to `--channel`
- add **/remove-project** command to delete channels for a project from Discord
- add **agent** option to `/session` command for starting sessions with specific agent
- fix: use first option as **placeholder** in question tool dropdowns
- fix: limit Discord **command names to 32 characters**
- add **keep-running instructions** to CLI setup outro

## 0.4.35

### Patch Changes

- use **opencode from PATH** instead of hardcoded `~/.opencode/bin/opencode` path

## 0.4.34

### Patch Changes

- fix **numbered list code block unnesting** to avoid repeating numbers
- **send text parts immediately** when complete (time.end set)
- don't show typing indicator on question tool prompts
- instruct model to use **question tool on session end**
- fix(cli): **sanitize command names** by replacing colons with hyphens

## 0.4.33

### Patch Changes

- use **digit-with-period unicode** (⒈⒉⒊) for todo numbers instead of parenthesized digits
- add **heading depth limiter** for Discord markdown (converts h4+ to h3)

## 0.4.32

### Patch Changes

- feat: **flush pending text** before tool calls - ensures LLM text is shown before tools start
- feat: **show token usage** for large tool outputs (>3k tokens) with context percentage

## 0.4.31

### Patch Changes

- feat: **auto-create Kimaki role** on CLI startup for easier permission management
- feat: add **--install-url** CLI option to print bot invite URL without starting bot
- feat: **unnest code blocks from lists** for Discord compatibility
- perf: **parallelize CLI startup** operations for faster boot
- fix: **cancel pending question** when user sends new message
- fix: **flush pending text** before showing question dropdowns
- fix: **reply with helpful message** when user lacks Kimaki role
- fix: move **Kimaki role to bottom** position for easier assignment
- fix: prevent **infinite loop** in splitLongLine with small maxLength
- fix: context usage rendering with empty diamond symbol

## 0.4.30

### Patch Changes

- add **start-session** CLI command to programmatically create Discord threads and start sessions
- support **KIMAKI_BOT_TOKEN** env var for headless/CI usage
- add **ThreadCreate** handler to detect bot-initiated sessions with magic prefix
- add **channelId** to system prompt for session context
- add GitHub Actions example for automatic issue investigation
- docs: update README command table with /agent, /undo, /redo

## 0.4.29

### Patch Changes

- add **--data-dir** option for running multiple bot instances with separate databases
- **abbreviate paths** in project selection with `~` for home directory
- **filter out** `opencode-test-*` projects from channel creation lists
- docs: add multiple Discord servers section to README

## 0.4.28

### Patch Changes

- fix **Accept Always** not persisting - use v2 API (`permission.reply`) instead of deprecated v1 API

## 0.4.27

### Patch Changes

- replace `/accept`, `/accept-always`, `/reject` commands with **dropdown menu** for permission requests
- show Accept, Accept Always, and Deny options in a single dropdown

## 0.4.26

### Patch Changes

- add Discord dropdowns for AI question tool prompts
- add **/agent** command to set agent preference per channel or session
- add user-defined OpenCode slash command support
- add dev-mode file logging
- add abort-and-retry flow when switching models mid-session
- add graceful shutdown with SIGTERM before SIGKILL and **/stop** alias
- add image attachment downloads with prompt path inclusion
- add bot username to category names for multi-bot support
- fix OpenCode server startup reliability
- fix transcription errors sent to thread instead of channel
- fix long-line markdown splitting and inline markdown escaping
- fix `-cmd` command parsing
- chore: update **@opencode-ai/sdk** to 1.1.3 and gitignore tmp
- chore: simplify system prompt and silence noisy debug log
- refactor: update Discord message icons and formatting

## 0.4.25

### Patch Changes

- add **/queue** command to queue messages during active sessions
- add **/clear-queue** command to clear queued messages
- add **/undo** and **/redo** commands for session history navigation
- add **/fork** improvements - show last assistant message in selection
- feat: **auto-kill existing kimaki instance** instead of failing when another instance is running
- fix: **prevent killing own process** when checking for existing instance (use `-sTCP:LISTEN` flag)
- feat: **notification badge** on session completion message
- feat: **lowercase capitalization rules** in system prompt for Discord-style messaging
- refactor: extract commands into separate files with cleaner dispatcher

## 0.4.24

### Patch Changes

- add **test-model-id.ts** script for validating model ID format and provider.list API
- cleanup **pnpm-lock.yaml** - remove stale liveapi dependencies

## 0.4.23

### Patch Changes

- fix **command timeouts**: fixed issue where `/fork`, `/abort`, and `/share` commands would time out by deferring replies immediately
- fix **startup race condition**: fixed issue where interaction handlers were not registered if the client was already ready during startup
- add **/model command**: new command to set preferred model for a channel or session
- update **/model** to use dropdowns with models sorted by release date (newest first)
- improve **customId handling**: use hash keys for select menus to avoid Discord's 100-char limit on custom IDs

## 0.4.22

### Patch Changes

- add **table formatting** for Discord - markdown tables are converted to monospace code blocks for better readability
- add `formatMarkdownTables` utility and tests

## 0.4.21

### Patch Changes

- add **Manage Server** permission to allowed users (in addition to Owner/Admin)
- add **"Kimaki" role** support - users with a role named "Kimaki" (case-insensitive) can now interact with the bot
- add **model configuration** info to system prompt - explains how to change model via `opencode.json`
- update README with permissions and model configuration docs

## 0.4.20

### Patch Changes

- add **200ms debounce** after aborting interrupted sessions to prevent race conditions
- fix **race condition** where requests could hang if aborted between checks and async calls
- remove slow Discord API calls - use local SQLite for tracking sent parts instead of fetching messages
- move **⏳ reaction** to right before prompt (not on message arrival) so superseded requests don't leave orphaned reactions
- show **filename in italics** for edit/write tools: `◼︎ edit _file.ts_ (+5-3)`
- use **italics** for bash commands and tool titles instead of backticks

## 0.4.19

### Patch Changes

- add **single instance lock** to prevent running multiple kimaki bots
- add `/add-new-project` command to create project folder, init git, and start session
- add `/share` command to share current session as public URL
- show **tool running status** immediately instead of waiting for completion
- inform user that **bash outputs are not visible** in system prompt
- add README best practices for notifications, long messages, permissions

## 0.4.18

### Patch Changes

- mention long files as uploadable in system prompt

## 0.4.17

### Patch Changes

- remove misleading error message in upload-to-discord

## 0.4.16

### Patch Changes

- move upload-to-discord instructions to system prompt instead of separate command

## 0.4.15

### Patch Changes

- re-publish with CLI command fixes

## 0.4.14

### Patch Changes

- add `upload-to-discord` CLI command to upload files to Discord thread
- add `/upload-to-discord` OpenCode command for LLM-driven file uploads
- refactor system prompt to include session ID for LLM access
- remove plugin dependency - commands now instruct LLM to run CLI directly
- rename command files to support multiple commands

## 0.4.13

### Patch Changes

- bash tool displays actual command in inline code (`` `command` ``) instead of description when short (≤120 chars, single line)

## 0.4.12

### Patch Changes

- system prompt instruction for 85 char max code block width to prevent Discord wrapping

## 0.4.11

### Patch Changes

- preserve code block formatting when splitting long Discord messages
- add closing/opening fences when code blocks span multiple messages
- use marked Lexer for robust markdown parsing instead of regex

## 0.4.10

### Patch Changes

- show "Creating Discord thread..." toast at start of command
- update command description to clarify it creates a Discord thread

## 0.4.9

### Patch Changes

- improve error handling in OpenCode plugin, check stderr and stdout for error messages

## 0.4.8

### Patch Changes

- add `send-to-discord` CLI command to send an OpenCode session to Discord
- add OpenCode plugin for `/send-to-kimaki-discord` command integration

## 0.4.7

### Patch Changes

- add `/accept`, `/accept-always`, `/reject` commands for handling OpenCode permission requests
- show permission requests in Discord thread with type, action, and pattern info
- `/accept-always` auto-approves future requests matching the same pattern

## 0.4.6

### Patch Changes

- add support for images
- update discord sdk

## 0.4.5

### Patch Changes

- Batch assistant messages in resume command to avoid spamming Discord with multiple messages for single response
- Add SIGUSR2 signal handler to restart the process


## 0.4.4

### Patch Changes

- add used model info

## 0.4.3

### Patch Changes

- fix: truncate autocomplete choices to 100 chars in resume and add-project commands to avoid DiscordAPIError[50035]
- fix: filter out autocomplete choices in session command that exceed Discord's 100 char value limit

## 0.4.2

### Patch Changes

- Revert 0.4.1 changes that caused multiple event listeners to accumulate

## 0.4.1

### Patch Changes

- Separate abort controllers for event subscription and prompt requests (reverted in 0.4.2)

## 0.4.0

### Minor Changes

- hide the too many params in discord

## 0.3.2

### Patch Changes

- support DOMException from undici in isAbortError

## 0.3.1

### Patch Changes

- display custom tool calls in Discord with tool name and colon-delimited key-value fields
- add special handling for webfetch tool to display URL without protocol
- truncate field values at 100 chars with unicode ellipsis

## 0.3.0

### Minor Changes

- Fix abort errors after 5 mins. DIsable permissions.

## 0.2.1

### Patch Changes

- fix fetch timeout. restore voice channels

## 0.2.0

### Minor Changes

- simpler onboarding. do not ask for server id

## 0.1.6

### Patch Changes

- Check for OpenCode CLI availability at startup and offer to install it if missing
- Automatically install OpenCode using the official install script when user confirms
- Set OPENCODE_PATH environment variable for the current session after installation
- Use the discovered OpenCode path for all subsequent spawn commands

## 0.1.5

### Patch Changes

- Store database in homedir

## 0.1.5

### Patch Changes

- Move database file to ~/.kimaki/ directory for better organization
- Database is now stored as ~/.kimaki/discord-sessions.db

## 0.1.4

### Patch Changes

- Store gemini api key in database

## 2025-09-25

- Switch audio transcription from OpenAI to Gemini for unified API usage
- Store Gemini API key in database for both voice channels and audio transcription
- Remove OpenAI API key requirement and dependency
- Update CLI to only prompt for Gemini API key with clearer messaging

## 0.1.3

### Patch Changes

- Nicer onboarding

## 0.1.2

### Patch Changes

- fix entrypoint bin.sh

## 0.1.1

### Patch Changes

- fix woring getClient call

## 0.1.0

### Minor Changes

- init

## 2025-09-24 09:20

- Add comprehensive error handling to prevent process crashes from corrupted audio data
- Add error handlers to prism-media opus decoder to catch "The compressed data passed is corrupted" errors
- Add error handlers to all stream components in voice pipeline (audioStream, downsampleTransform, framer)
- Add error handling in genai-worker for resampler, opus encoder, and audio log streams
- Add write callbacks with error handling for stream writes
- Add global uncaughtException and unhandledRejection handlers in worker thread
- Prevent Discord browser clients' corrupted opus packets from crashing the bot

## 2025-09-23 14:15

- Update PCM audio logging to only activate when DEBUG environment variable is set
- Extract audio stream creation into `createAudioLogStreams` helper function
- Use optional chaining for stream writes to handle missing streams gracefully
- Simplify cleanup logic with optional chaining

## 2025-09-23 14:00

- Add PCM audio logging for Discord voice chats
- Audio streams for both user input and assistant output saved to files
- Files saved in `discord-audio-logs/<guild_id>/<channel_id>/` directory structure
- Format: 16kHz mono s16le PCM with FFmpeg-compatible naming convention
- Automatic cleanup when voice sessions end
- Add documentation for audio file playback and conversion

## 2025-09-22 12:05

- Fix event listener leak warning by removing existing 'start' listeners on receiver.speaking before adding new ones
- Add { once: true } option to abort signal event listener to prevent accumulation
- Stop existing voice streamer and GenAI session before creating new ones in setupVoiceHandling
- Prevent max event listeners warning when voice connections are re-established

## 2025-09-22 11:45

- Replace AudioPlayer/AudioResource with direct voice streaming implementation
- Create `directVoiceStreaming.ts` module that uses VoiceConnection's low-level APIs
- Implement custom 20ms timer cycle for Opus packet scheduling
- Handle packet queueing, silence frames, and speaking state directly
- Remove dependency on discord.js audio player abstraction for continuous streaming

## 2025-09-22 10:15

- Add tool support to `startGenAiSession` function
- Import `aiToolToCallableTool` from liveapi package
- Convert AI SDK tools to GenAI CallableTools format
- Handle tool calls and send tool responses back to session

## 2025-09-21

- Add `/resume` slash command for resuming existing OpenCode sessions
- Implement autocomplete for session selection showing title and last updated time
- Create new Discord thread when resuming a session
- Fetch and render all previous messages from the resumed session
- Store thread-session associations in SQLite database
- Reuse existing part-message mapping logic for resumed sessions
- Add session-utils module with tests for fetching and processing session messages
- Add `register-commands` script for standalone command registration

## 2025-01-25 01:30

- Add prompt when existing channels are connected to ask if user wants to add new channels or start server immediately
- Skip project selection flow when user chooses to start with existing channels only
- Improve user experience by not forcing channel creation when channels already exist

## 2025-01-25 01:15

- Convert `processVoiceAttachment` to use object arguments for better API design
- Add project file tree context to voice transcription prompts using `git ls-files | tree --fromfile`
- Include file structure in transcription prompt to improve accuracy for file name references
- Add 2-second timeout for thread name updates to handle rate limiting gracefully

## 2025-01-25 01:00

- Refactor message handling to eliminate duplicate code between threads and channels
- Extract voice transcription logic into `processVoiceAttachment` helper function
- Simplify project directory extraction and validation
- Remove unnecessary conditional branches and streamline control flow
- Update thread name with transcribed content after voice message transcription completes

## 2025-01-25 00:30

- Add voice message handling to Discord bot
- Transcribe audio attachments using OpenAI Whisper before processing
- Transform voice messages to text and reuse existing text message handler
- Support all audio/\* content types from Discord attachments

## 2025-01-25 00:15

- Update todowrite rendering to use unicode characters (□ ◈ ☑ ☒) instead of text symbols
- Remove code block wrapping for todowrite output for cleaner display

## 2025-01-24 23:30

- Add voice transcription functionality with OpenAI Whisper
- Export `transcribeAudio` and `transcribeAudioWithOptions` functions from new voice.ts module
- Support multiple audio input formats: Buffer, Uint8Array, ArrayBuffer, and base64 string

## 2025-01-24 21:10

- Refactor typing to be local to each session (not global)
- Define typing function inside event handler as a simple local function
- Start typing on step-start events
- Continue typing between parts and steps as needed
- Stop typing when session ends via cleanup
- Remove all thinking message code

## 2025-01-24 19:50

- Changed abort controller mapping from directory-based to session-based to properly handle multiple concurrent sessions per directory
