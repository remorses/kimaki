# Changelog

## 0.2.0

1. **Add TypeSafe AI Jev support through the Vercel AI Gateway and make it the default classifier.** Jev returns a typed allow probability, and auto mode blocks uncertain, invalid, or failed evaluations. Configure it with an optional allow-probability threshold:

   ```json
   {
     "model": "typesafe-ai/jev",
     "allowProbability": 0.9,
     "timeoutMs": 8000
   }
   ```

   Set `AI_GATEWAY_API_KEY` in the OpenCode process environment. To reuse the active model from the current OpenCode user turn instead:

   ```json
   {
     "model": "main"
   }
   ```

   Auto mode now accepts only `"typesafe-ai/jev"` and `"main"`. Replace any configured provider model ID, such as `"anthropic/claude-haiku-4-5"`, with one of these values.

## 0.1.1

1. **Tighten skip and hard-deny paths.** Command substitutions, assignment prefixes, PATH-qualified binaries, sudo wrappers, and mutating forms of `git` / `rg` / `sed` / `find` / `awk` / `sort` / `printf` no longer auto-allow. Recursive `rm` of `/.` and `$HOME`, profile redirects, and `curl | cat | sh` hard-deny. Invalid config JSON fails closed. Only the latest user message counts as authorization.

## 0.1.0

1. **Gate tool execution before it runs.** Read-only bash (`ls`, `cat`, `git status`, pipelines of those) and in-project edits skip the model. Recursive deletes of `/` or `$HOME`, shell-profile writes, `authorized_keys` redirects, and `curl | sh` are denied from the bash AST. Everything else goes to a two-stage classifier that fails closed.

   Uses [unbash](https://github.com/webpro-nl/unbash) to parse commands. Not the same plugin as injection-guard, which scans tool output after execution.
