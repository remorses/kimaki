# Changelog

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
