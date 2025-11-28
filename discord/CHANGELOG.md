# Changelog

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
