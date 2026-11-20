---
'kimaki': patch
---

Make "Sign in with ChatGPT" work in `/login` when your browser is on another device. This method sends the browser back to a `127.0.0.1` page on the computer that runs OpenCode, so on a phone the last page fails to load and the login never finished.

`/login` now shows a **Paste redirect URL** button for such methods. Copy the address of the page that failed to load and paste it. Kimaki waits for OpenCode to finish the login and shows the result.

The CLI works the same way:

```bash
kimaki login openai --method chatgpt-token-sharing   # prints the URL and paste: true
kimaki login openai --attempt <id> --code 'http://127.0.0.1:<port>/auth/callback?code=...'
```
