# Voice Channel Code Flow Analysis

## Current Architecture Overview

The voice system consists of several interconnected components:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MAIN THREAD                                  │
├─────────────────────────────────────────────────────────────────────┤
│  voice-handler.ts                                                    │
│  ├── registerVoiceStateHandler() - handles user join/leave events   │
│  ├── setupVoiceHandling() - sets up audio pipeline                  │
│  ├── cleanupVoiceConnection() - cleanup resources                   │
│  └── Audio Pipeline:                                                 │
│      Discord Opus → prism.opus.Decoder → Downsample → Frame         │
│      (48kHz stereo)   (48kHz stereo)     (16kHz mono)  (100ms)      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      WORKER THREAD (genai-worker.ts)                 │
├─────────────────────────────────────────────────────────────────────┤
│  ├── Resampler: 24kHz mono → 48kHz stereo                           │
│  ├── Opus Encoder: PCM → Opus packets                               │
│  ├── Packet Queue with 20ms interval                                │
│  └── GenAI Session (genai.ts) → Google Gemini Live API              │
└─────────────────────────────────────────────────────────────────────┘
```

## Audio Flow Details

### 1. User Audio Reception (voice-handler.ts)

```
receiver.subscribe(userId) → audioStream (Opus packets)
    ↓
prism.opus.Decoder (48kHz, stereo, frameSize=960)
    ↓
convertToMono16k() - Downsample 48kHz stereo → 16kHz mono
    ↓
frameMono16khz() - Frame into 100ms chunks (3200 bytes each)
    ↓
genAiWorker.sendRealtimeInput({ audio: { mimeType: 'audio/pcm;rate=16000', data: base64 }})
```

### 2. Assistant Audio Output (genai-worker.ts)

```
Google Gemini Live API → onAssistantAudioChunk (24kHz mono PCM)
    ↓
Resampler (24kHz mono → 48kHz stereo)
    ↓
Opus Encoder (48kHz stereo, frameSize=960)
    ↓
opusPacketQueue (buffered)
    ↓
20ms interval → parentPort.postMessage('assistantOpusPacket')
    ↓
connection.playOpusPacket()
```

---

## Identified Issues

### Issue 1: `ERR_SOCKET_DGRAM_NOT_RUNNING` Crash (GitHub #7)

**Root Cause:** The `@discordjs/voice` package's `VoiceUDPSocket` has a keepAlive mechanism that runs every 5 seconds. When the connection is destroyed/closed, there's a race condition where:

1. The UDP socket is closed
2. The keepAlive interval fires before being cleared
3. `socket.send()` throws `ERR_SOCKET_DGRAM_NOT_RUNNING`

**Evidence from @discordjs/voice source:**
```javascript
keepAlive() {
  this.keepAliveBuffer.writeUInt32LE(this.keepAliveCounter, 0);
  this.send(this.keepAliveBuffer);  // <-- Crashes if socket closed
  // ...
}
```

**Current Problem:** The bot doesn't handle this error, causing the entire process to crash.

### Issue 2: Missing Audio from Some Users

**Potential Causes:**

1. **Speaking session collision** - The code uses `speakingSessionCount` to prevent processing audio from older speaking sessions, but this might be too aggressive:
   ```typescript
   if (currentSessionCount !== speakingSessionCount) {
     return  // Drops audio frames
   }
   ```

2. **Stream error handling is passive** - Errors on streams are logged but not recovered:
   ```typescript
   decoder.on('error', (error) => {
     voiceLogger.error(`Opus decoder error for user ${userId}:`, error)
   })
   // No recovery mechanism!
   ```

3. **No audio subscription persistence** - When `receiver.subscribe()` is called with `AfterSilence` behavior, the subscription ends after 500ms of silence. A new subscription is created only when the user speaks again, but there's no guarantee this always works.

4. **Corrupted audio encoding** - The prism-media opus decoder might receive malformed packets from Discord, especially during network instability.

### Issue 3: Connection State Race Conditions

The code checks connection state before sending:
```typescript
if (connection.state.status !== VoiceConnectionStatus.Ready) {
  voiceLogger.log('Skipping packet: connection not ready')
  return
}
```

But the state can change between the check and `playOpusPacket()`, causing errors.

---

## Recommended Fixes

### Plan 1: Add Global Error Handler for UDP Socket Errors

Add an uncaught exception handler that specifically handles voice-related errors without crashing:

```typescript
// In discord-bot.ts or voice-handler.ts initialization
process.on('uncaughtException', (error) => {
  if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
    voiceLogger.error('UDP socket error (non-fatal):', error.message)
    // Optionally trigger reconnection
    return
  }
  // Re-throw other errors
  throw error
})
```

### Plan 2: Wrap Voice Connection Operations with Error Handling

```typescript
// Safe wrapper for playOpusPacket
function safePlayOpusPacket(connection: VoiceConnection, packet: Buffer) {
  try {
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      connection.playOpusPacket(packet)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
      voiceLogger.warn('Socket closed during packet send, ignoring')
    } else {
      throw error
    }
  }
}
```

### Plan 3: Improve Audio Receive Robustness

1. **Persistent subscription mode** - Use `EndBehaviorType.Manual` instead of `AfterSilence` for more control:
   ```typescript
   const audioStream = receiver.subscribe(userId, {
     end: { behavior: EndBehaviorType.Manual }
   })
   ```

2. **VAD (Voice Activity Detection)** - Handle silence detection in application code rather than relying on Discord's behavior

3. **Error recovery for decoder** - Recreate decoder on error:
   ```typescript
   decoder.on('error', (error) => {
     voiceLogger.error(`Decoder error, recreating:`, error)
     // Unsubscribe and resubscribe to reset the pipeline
   })
   ```

### Plan 4: Connection State Machine Hardening

Add a state wrapper that queues operations when connection is transitioning:

```typescript
class SafeVoiceConnection {
  private pendingPackets: Buffer[] = []
  private isTransitioning = false
  
  constructor(private connection: VoiceConnection) {
    connection.on('stateChange', (oldState, newState) => {
      this.isTransitioning = 
        newState.status === VoiceConnectionStatus.Connecting ||
        newState.status === VoiceConnectionStatus.Signalling
      
      if (newState.status === VoiceConnectionStatus.Ready) {
        this.flushPendingPackets()
      }
    })
  }
  
  playOpusPacket(packet: Buffer) {
    if (this.isTransitioning) {
      this.pendingPackets.push(packet)
      return
    }
    // ... safe play logic
  }
}
```

### Plan 5: Voice Connection Lifecycle Improvements

1. **Add connection error listener in setupVoiceHandling:**
   ```typescript
   connection.on('error', (error) => {
     voiceLogger.error('Connection error:', error)
     // Attempt graceful recovery instead of crash
     cleanupVoiceConnection(guildId)
   })
   ```

2. **Implement exponential backoff for reconnection:**
   ```typescript
   let reconnectAttempts = 0
   const maxAttempts = 5
   
   connection.on(VoiceConnectionStatus.Disconnected, async () => {
     if (reconnectAttempts < maxAttempts) {
       const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000)
       await sleep(delay)
       reconnectAttempts++
       // Attempt reconnection
     }
   })
   ```

### Plan 6: Worker Thread Error Isolation

The worker thread already has error handlers, but they could be improved:

```typescript
// In genai-worker.ts
process.on('uncaughtException', (error) => {
  // Don't exit, just notify main thread
  sendError(`Worker exception: ${error.message}`)
  // Attempt to cleanup and restart session
  cleanupAsync().catch(() => {})
})
```

---

## Priority Order

1. **High: Fix UDP socket crash** (Plan 1 + Plan 2) - This causes complete bot failure
2. **Medium: Connection error handling** (Plan 5) - Improves reliability
3. **Medium: Audio receive robustness** (Plan 3) - Fixes missing user audio
4. **Low: State machine hardening** (Plan 4) - Nice to have for edge cases
5. **Low: Worker isolation** (Plan 6) - Already partially implemented

---

## References

- [@discordjs/voice source code](https://github.com/discordjs/voice)
- [Discord.js voice guide](https://discordjs.guide/voice/)
- [prism-media documentation](https://github.com/amishshah/prism-media)
- [Related issue: ERR_SOCKET_DGRAM_NOT_RUNNING](https://github.com/nodejs/help/issues/1780)
- [Voice receive issues](https://github.com/discordjs/discord.js/issues/8778)
