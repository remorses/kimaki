# ACP Chat History API Proposal

## Summary

Add session history endpoints to ACP, enabling clients to access conversations from any ACP agent (Claude Code, Gemini CLI, etc).

## Problem

Users work with AI agents across multiple tools, creating isolated conversation histories. Current ACP only handles active sessions, not historical data.

## Proposed API

### 1. List Sessions

```typescript
// Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/list",
  "params": {
    "limit": 20,
    "offset": 0,
    "search": "debugging"
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessions": [{
      "sessionId": "sess_abc123",
      "title": "Fix Redis timeout",
      "createdAt": "2024-01-15T10:30:00Z",
      "lastModified": "2024-01-15T11:45:00Z",
      "source": "claude-code-cli",
      "messageCount": 12
    }],
    "total": 145
  }
}
```

### 2. Get Session Content

```typescript
// Request
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/get",
  "params": {
    "sessionId": "sess_abc123"
  }
}

// Response - Uses existing ACP content format
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "sess_abc123",
    "title": "Fix Redis timeout",
    "createdAt": "2024-01-15T10:30:00Z",
    "turns": [
      {
        "role": "user",
        "timestamp": "2024-01-15T10:30:00Z",
        "content": [{
          "type": "text",
          "text": "Redis keeps timing out"
        }]
      },
      {
        "role": "assistant", 
        "timestamp": "2024-01-15T10:30:15Z",
        "content": [{
          "type": "text",
          "text": "I'll check your Redis config"
        }],
        "toolCalls": [{
          "toolCallId": "call_001",
          "title": "Read redis.conf",
          "status": "completed"
        }]
      }
    ]
  }
}
```

### 3. Capability Discovery

```typescript
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "sessionHistory": {
        "supported": true,
        "maxResults": 1000
      }
    }
  }
}
```

## Benefits

- **Unified history** across all AI tools
- **Context reuse** for similar problems  
- **Backwards compatible** - optional feature
- **Simple implementation** - reuses existing content types

## Implementation

Agents store sessions locally (SQLite, JSON files) and expose via new endpoints. No changes to existing ACP flows.