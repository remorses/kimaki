# Changelog

## 2025-01-24 11:30

### Automatic Session Reconnection Support

- **Automatic reconnection** when connection is lost unexpectedly
- **Session resumption** using Google GenAI's session handle mechanism
- **Configurable retry logic** with exponential backoff (max 5 attempts by default)
- **GoAway message handling** for graceful server-initiated disconnections
- **Transparent reconnection** preserves conversation context and state

#### New Configuration Options:

```typescript
const client = new LiveAPIClient({
  apiKey: 'YOUR_API_KEY',
  autoReconnect: true, // Enable auto-reconnect (default: true)
  maxReconnectAttempts: 5, // Max reconnection attempts (default: 5)
  config: {
    sessionResumption: {
    },
  },
})
```

#### Key Features:

- Automatically stores session handle from `sessionResumptionUpdate` messages
- Reconnects with exponential backoff (1s, 2s, 4s, 8s, 10s max)
- Distinguishes between explicit disconnects (via `disconnect()`) and unexpected closures
- Only attempts reconnection when session is resumable
- Clears session handle on explicit disconnect to prevent unwanted reconnections

#### New Methods:

- `getSessionHandle()` - Retrieve current session resumption handle
- `setSessionHandle(handle)` - Manually set session handle for custom management
- `isAutoReconnectEnabled()` - Check if auto-reconnect is enabled
