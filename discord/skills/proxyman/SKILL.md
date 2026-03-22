---
name: proxyman
description: >
  Reverse-engineer HTTP APIs using Proxyman for macOS. Intercept, record, and export
  network traffic from CLI tools and apps (Node.js, Python, Ruby, Go, curl).
  Export as HAR (JSON) and analyze with jq. Use this skill when the user wants
  to capture, inspect, or reverse-engineer HTTP traffic from any application.
---

# proxyman — HTTP traffic capture and reverse-engineering

Proxyman is a macOS proxy that intercepts HTTP/HTTPS traffic. Use it to
reverse-engineer APIs: capture what an app sends, inspect headers and bodies,
and build SDKs or integrations from the captured data.

## Important

**Always run `proxyman-cli --help` and `proxyman-cli <subcommand> --help`
before using.** The help output is the source of truth for all commands and
options. The CLI binary lives inside the app bundle:

```
/Applications/Proxyman.app/Contents/MacOS/proxyman-cli
```

**Proxyman GUI must be running** for the CLI to work. The CLI talks to the
running app — it does not work standalone or headless.

```bash
open -a Proxyman
```

## Node.js, Python, Ruby, Go, curl do NOT use macOS system proxy

This is critical. Even though Proxyman auto-configures macOS system proxy
settings, **CLI tools and runtimes ignore them**. You must set env vars so
traffic routes through Proxyman (default port 9090):

```bash
HTTPS_PROXY=http://127.0.0.1:9090 \
HTTP_PROXY=http://127.0.0.1:9090 \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
  <your-command-here>
```

- `HTTPS_PROXY` / `HTTP_PROXY`: route traffic through Proxyman
- `NODE_TLS_REJECT_UNAUTHORIZED=0`: accept Proxyman's SSL cert for Node.js apps
- For Python: `REQUESTS_CA_BUNDLE` or `SSL_CERT_FILE` may be needed instead
- For curl: use `--proxy http://127.0.0.1:9090 -k` or set the env vars

Proxyman also has an "Automatic Setup" feature (Setup menu > Automatic Setup)
that opens a pre-configured terminal with all env vars set. But for scripting
and agent use, set the env vars explicitly as shown above.

## CLI reference

```
proxyman-cli clear-session              Clear current captured traffic
proxyman-cli export-log [options]       Export captured traffic to file
proxyman-cli export [options]           Export debug tool rules (Map Local, etc)
proxyman-cli import --input <file>      Import debug tool rules
proxyman-cli proxy on|off               Toggle macOS system HTTP proxy
proxyman-cli breakpoint enable|disable  Toggle Breakpoint tool
proxyman-cli maplocal enable|disable    Toggle Map Local tool
proxyman-cli scripting enable|disable   Toggle Scripting tool
proxyman-cli install-root-cert <file>   Install custom root cert (requires sudo)
```

### export-log options

```
-m, --mode <mode>         all | domains (default: all)
-o, --output <path>       Output file path (required)
-d, --domains <domain>    Filter by domain (repeatable, only with -m domains)
-f, --format <format>     proxymansession | har | raw (default: proxymansession)
```

**Always use `-f har`** for agent workflows. HAR is JSON and works with jq.

### export-log timing bug

The CLI can report "Exported Completed!" before the file is actually written.
Add `sleep 3` after export-log before reading the file:

```bash
proxyman-cli export-log -m all -o capture.har -f har
sleep 3
jq '.log.entries | length' capture.har
```

## Reverse-engineering workflow

This is the primary use case. Example: figuring out how Claude Code talks to
the Anthropic API.

```bash
# 1. Make sure Proxyman is running
open -a Proxyman

# 2. Clear previous traffic
proxyman-cli clear-session

# 3. Run the target app through the proxy
HTTPS_PROXY=http://127.0.0.1:9090 \
HTTP_PROXY=http://127.0.0.1:9090 \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
  claude -p "say hi" --max-turns 1

# 4. Export captured traffic as HAR
proxyman-cli export-log -m all -o capture.har -f har
sleep 3

# 5. Filter for the domain you care about
jq '[.log.entries[] | select(.request.url | test("anthropic"))]' capture.har
```

## Analyzing HAR files with jq

### List all domains and request counts

```bash
jq '[.log.entries[].request.url] | map(split("/")[2])
  | group_by(.) | map({domain: .[0], count: length})
  | sort_by(-.count)' capture.har
```

### Filter by domain

```bash
jq '.log.entries[] | select(.request.url | test("api.example.com"))' capture.har
```

### Request summary (method, url, status)

```bash
jq '[.log.entries[] | select(.request.url | test("api.example.com")) | {
  method: .request.method,
  url: .request.url,
  status: .response.status
}]' capture.har
```

### Full request details (headers + body)

```bash
jq '.log.entries[] | select(.request.url | test("v1/messages")) | {
  url: .request.url,
  method: .request.method,
  status: .response.status,
  request_headers: [.request.headers[] | {(.name): .value}] | add,
  request_body: (.request.postData.text | fromjson? // .request.postData.text),
  response_body: (.response.content.text | fromjson? // .response.content.text)
}' capture.har
```

### Request body structure (without full content)

Useful for large payloads — see the shape without the bulk:

```bash
jq '.log.entries[] | select(.request.url | test("v1/messages"))
  | .request.postData.text | fromjson
  | {model, max_tokens, stream,
     system_count: (.system | length),
     messages_count: (.messages | length),
     tools_count: (.tools | length),
     messages: [.messages[] | {role, content_type: (.content | type)}]
  }' capture.har
```

### Extract specific headers

```bash
jq '.log.entries[] | select(.request.url | test("api.example.com"))
  | {url: .request.url, auth: (.request.headers[] | select(.name == "authorization") | .value)}' capture.har
```

### Only failed requests

```bash
jq '[.log.entries[] | select(.response.status >= 400) | {
  url: .request.url,
  status: .response.status,
  error: .response.content.text
}]' capture.har
```

## Domain-filtered export

If you only care about one domain, filter at export time to get a smaller file:

```bash
proxyman-cli export-log -m domains --domains 'api.anthropic.com' -o anthropic.har -f har
```

Multiple domains:

```bash
proxyman-cli export-log -m domains \
  --domains 'api.anthropic.com' \
  --domains 'mcp-proxy.anthropic.com' \
  -o anthropic.har -f har
```

## SSL proxying

Proxyman needs to decrypt HTTPS to see request/response bodies. For Node.js
apps, `NODE_TLS_REJECT_UNAUTHORIZED=0` handles this. For system apps and
browsers, install and trust the Proxyman root certificate:

- Proxyman menu > Certificate > Install Certificate on this Mac
- Or via CLI: `proxyman-cli install-root-cert <path-to-cert>`

Without SSL proxying enabled for a domain, you'll see the connection but not
the decrypted body content.
