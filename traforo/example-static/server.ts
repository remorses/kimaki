/**
 * Example Bun server for testing traforo tunnel.
 * Features: static files, WebSocket, SSE, and slow endpoint.
 */

const PORT = parseInt(process.env.PORT || '3000', 10)

// Track WebSocket connections
const wsConnections = new Set<WebSocket>()

Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url)
    const path = url.pathname

    // WebSocket upgrade
    if (path === '/ws') {
      const upgraded = server.upgrade(req)
      if (upgraded) {
        return undefined
      }
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    // SSE endpoint - sends events every second for 10 seconds
    if (path === '/sse') {
      const encoder = new TextEncoder()
      let count = 0
      const maxCount = 10

      const stream = new ReadableStream({
        async start(controller) {
          const interval = setInterval(() => {
            count++
            const data = `data: {"count": ${count}, "time": "${new Date().toISOString()}"}\n\n`
            controller.enqueue(encoder.encode(data))

            if (count >= maxCount) {
              clearInterval(interval)
              controller.close()
            }
          }, 1000)
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    // Slow endpoint - waits 5 seconds before responding
    if (path === '/slow') {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({
                message: 'This response was delayed by 5 seconds',
                timestamp: new Date().toISOString(),
              }),
              {
                headers: { 'Content-Type': 'application/json' },
              }
            )
          )
        }, 5000)
      })
    }

    // Echo endpoint - returns request info
    if (path === '/echo') {
      return new Response(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: Object.fromEntries(req.headers),
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // Static files
    const staticFiles: Record<string, { content: string; type: string }> = {
      '/': {
        type: 'text/html',
        content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Traforo Test Server</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="container">
    <h1>Traforo Test Server</h1>
    <p>Testing HTTP, WebSocket, and SSE through the tunnel.</p>
    
    <section>
      <h2>HTTP Tests</h2>
      <button onclick="testEcho()">Test Echo</button>
      <button onclick="testSlow()">Test Slow (5s)</button>
      <div id="http-result" class="result"></div>
    </section>
    
    <section>
      <h2>SSE Test</h2>
      <button onclick="testSSE()">Start SSE</button>
      <button onclick="stopSSE()">Stop SSE</button>
      <div id="sse-result" class="result"></div>
    </section>
    
    <section>
      <h2>WebSocket Test</h2>
      <button onclick="connectWS()">Connect</button>
      <button onclick="sendWS()">Send Message</button>
      <button onclick="closeWS()">Close</button>
      <div id="ws-result" class="result"></div>
    </section>
  </div>
  <script src="/app.js"></script>
</body>
</html>`,
      },
      '/style.css': {
        type: 'text/css',
        content: `* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, sans-serif;
  background: #1a1a2e;
  color: #fff;
  min-height: 100vh;
  padding: 2rem;
}
.container { max-width: 800px; margin: 0 auto; }
h1 { margin-bottom: 0.5rem; }
h2 { margin: 1.5rem 0 0.5rem; font-size: 1.2rem; }
p { opacity: 0.7; margin-bottom: 1rem; }
section { background: rgba(255,255,255,0.05); padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
button {
  padding: 0.5rem 1rem;
  background: #4f46e5;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-right: 0.5rem;
  margin-bottom: 0.5rem;
}
button:hover { background: #4338ca; }
.result {
  margin-top: 0.5rem;
  padding: 0.5rem;
  background: rgba(0,0,0,0.3);
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.85rem;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}`,
      },
      '/app.js': {
        type: 'application/javascript',
        content: `let eventSource = null;
let ws = null;

async function testEcho() {
  const result = document.getElementById('http-result');
  result.textContent = 'Loading...';
  try {
    const res = await fetch('/echo');
    const data = await res.json();
    result.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    result.textContent = 'Error: ' + err.message;
  }
}

async function testSlow() {
  const result = document.getElementById('http-result');
  result.textContent = 'Waiting 5 seconds...';
  const start = Date.now();
  try {
    const res = await fetch('/slow');
    const data = await res.json();
    const elapsed = Date.now() - start;
    result.textContent = 'Elapsed: ' + elapsed + 'ms\\n' + JSON.stringify(data, null, 2);
  } catch (err) {
    result.textContent = 'Error: ' + err.message;
  }
}

function testSSE() {
  const result = document.getElementById('sse-result');
  result.textContent = 'Connecting...\\n';
  
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/sse');
  
  eventSource.onmessage = (e) => {
    result.textContent += e.data + '\\n';
    result.scrollTop = result.scrollHeight;
  };
  
  eventSource.onerror = () => {
    result.textContent += '[SSE connection closed]\\n';
    eventSource.close();
  };
}

function stopSSE() {
  if (eventSource) {
    eventSource.close();
    document.getElementById('sse-result').textContent += '[Stopped]\\n';
  }
}

function connectWS() {
  const result = document.getElementById('ws-result');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = protocol + '//' + location.host + '/ws';
  result.textContent = 'Connecting to ' + wsUrl + '...\\n';
  
  if (ws) ws.close();
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    result.textContent += '[Connected]\\n';
  };
  
  ws.onmessage = (e) => {
    result.textContent += 'Received: ' + e.data + '\\n';
    result.scrollTop = result.scrollHeight;
  };
  
  ws.onclose = () => {
    result.textContent += '[Disconnected]\\n';
  };
  
  ws.onerror = () => {
    result.textContent += '[Error]\\n';
  };
}

function sendWS() {
  const result = document.getElementById('ws-result');
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    result.textContent += '[Not connected]\\n';
    return;
  }
  const msg = 'Hello at ' + new Date().toISOString();
  ws.send(msg);
  result.textContent += 'Sent: ' + msg + '\\n';
}

function closeWS() {
  if (ws) {
    ws.close();
    ws = null;
  }
}`,
      },
    }

    const file = staticFiles[path]
    if (file) {
      return new Response(file.content, {
        headers: { 'Content-Type': file.type },
      })
    }

    return new Response('Not Found', { status: 404 })
  },

  websocket: {
    open(ws) {
      wsConnections.add(ws)
      console.log(`WebSocket connected (total: ${wsConnections.size})`)
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }))
    },
    message(ws, message) {
      console.log(`WebSocket message: ${message}`)
      // Echo back with timestamp
      ws.send(
        JSON.stringify({
          type: 'echo',
          message: message.toString(),
          timestamp: new Date().toISOString(),
        })
      )
    },
    close(ws) {
      wsConnections.delete(ws)
      console.log(`WebSocket disconnected (total: ${wsConnections.size})`)
    },
  },
})

console.log(`Server running at http://localhost:${PORT}`)
console.log(`Endpoints:`)
console.log(`  GET  /        - Static HTML page`)
console.log(`  GET  /echo    - Echo request info`)
console.log(`  GET  /slow    - Delayed response (5s)`)
console.log(`  GET  /sse     - Server-Sent Events`)
console.log(`  WS   /ws      - WebSocket echo`)
