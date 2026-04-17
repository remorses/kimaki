// Proxy bootstrap for Node.js environments behind a corporate firewall or GFW.
// Loaded via --require when HTTPS_PROXY or https_proxy is set.
// Monkey-patches the `ws` module's WebSocket constructor to route all
// WebSocket connections through the configured HTTP/SOCKS proxy.
// This is needed because Node.js does not natively respect proxy env vars
// for WebSocket connections, and --use-env-proxy only covers HTTP fetch.

const proxyUrl =
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY

if (!proxyUrl) {
  return
}

let HttpsProxyAgent
try {
  HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent
} catch {
  // https-proxy-agent not available (e.g. in a minimal install) — skip patching
  return
}

const agent = new HttpsProxyAgent(proxyUrl)

const Module = require('module')
const origRequire = Module.prototype.require
Module.prototype.require = function (id) {
  const mod = origRequire.apply(this, arguments)
  if (id === 'ws' && mod && !mod.__proxyPatched) {
    const OrigWS = mod.WebSocket
    if (OrigWS && !OrigWS.__proxyPatched) {
      const PatchedWS = function (url, protocols, options) {
        if (!options || !options.agent) {
          options = Object.assign(options || {}, { agent })
        }
        return new OrigWS(url, protocols, options)
      }
      Object.assign(PatchedWS, OrigWS)
      PatchedWS.prototype = OrigWS.prototype
      PatchedWS.__proxyPatched = true
      mod.WebSocket = PatchedWS
      mod.__proxyPatched = true
    }
  }
  return mod
}
