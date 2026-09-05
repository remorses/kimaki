---
name: parallel-security-review
repo: https://github.com/remorses/kimaki
description: >
  DeepSec-inspired security review workflow for branch or PR changes. Use when
  the user asks for a thorough, high-signal security review that should derive
  repository context, split candidate discovery across focused agents, and run
  per-finding false-positive validation before reporting.
allowed-tools:
  - Bash(git status:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git show:*)
  - Read
  - Glob
  - Grep
  - Task
---

# Parallel security review

Use this workflow for **high-confidence security reviews** of branch or PR
changes. It borrows the useful parts of DeepSec's prompt architecture: small
core instructions, repo context, tech-specific reminders, finding-specific
false-positive rules, concrete target files, strict output, and independent
validation.

## Goal

Report only **real vulnerabilities introduced by the change under review**.
Do not report hardening gaps, existing issues, test-only problems, style, or
generic best-practice concerns.

Keep the final report short. If there are no high-confidence findings, say so.

## Review architecture

Split the work into discovery and validation:

```text
main reviewer
  │
  ├─► context scout
  │     auth model, trust boundaries, safe patterns, tech stack
  │
  ├─► candidate discovery agents
  │     focused by vulnerability family, not by random files
  │
  ├─► one validator per candidate
  │     tries to disprove exploitability and assign confidence
  │
  └─► final report
        only validated findings with confidence >= 8/10
```

Discovery agents can be broad. Validator agents must be skeptical.

## Step 1: collect branch context

Use git to understand the review scope. Prefer the repository's base branch if
known; otherwise use the merge base with the upstream/default branch when
available.

Read:

- `git status -s -u`
- changed file names
- commit messages on the branch
- complete diff for the review range

Do not modify files. Do not commit.

## Step 2: derive a compact repo security context

Launch a **context scout** subagent before vulnerability discovery. Ask it to
read relevant unchanged files too, not just the diff.

The context scout returns at most 40 lines:

```md
## Security context

**Auth primitives**
- `requireUser()` protects server routes
- `canManageTeam()` gates team admin actions

**Trust boundaries**
- HTTP route params and request bodies are attacker-controlled
- CLI flags and environment variables are trusted for this review

**Sensitive sinks**
- database writes through `db.*`
- filesystem writes under workspace root
- subprocess execution through `execAsync()`

**Known safe patterns**
- Prisma object filters are parameterized
- React text interpolation is escaped by default

**Tech notes**
- Next.js Server Actions are public POST endpoints unless guarded server-side
```

Use this context in every later subagent prompt.

## Step 3: inject tech-specific reminders

Add only the reminders that match the repository. Keep them short.

**React / Angular**
- Do not report XSS for normal text interpolation.
- Only investigate raw HTML sinks like `dangerouslySetInnerHTML`,
  `bypassSecurityTrustHtml`, DOM writes, or template compilation.

**Next.js / React Server Components**
- Server Actions are public POST endpoints. Check backend auth inside the
  action, not just UI visibility.
- Middleware is useful but not sufficient if routes can be reached through
  alternate paths or internal handlers.
- `params`, `searchParams`, headers, cookies, and request bodies are untrusted.

**Express / Node HTTP servers**
- Middleware order matters. Verify auth/validation runs before handlers.
- For command execution, prove untrusted input reaches a shell or argv sink.
- For path traversal, require a containment check like resolved path starts
  with the intended root.

**Prisma / SQL ORMs**
- Prisma object filters are safe from SQL injection by default.
- Investigate raw SQL APIs like `$queryRawUnsafe`, string-built SQL, or manual
  driver calls.

**Cloudflare Workers / edge apps**
- Request headers, cookies, URL, and body are untrusted.
- Bindings and environment variables are trusted.
- Verify tenant/account identifiers are checked server-side before data access.

**Rust / Go / memory-safe services**
- Do not report memory safety issues unless unsafe/native code is directly in
  scope and the exploit path is concrete.
- Focus on auth, deserialization, filesystem, command execution, and SSRF.

## Step 4: candidate discovery agents

Launch focused agents in parallel when the diff is non-trivial. Use fewer
agents for tiny diffs.

Good split:

1. **Auth and authorization**
   - auth bypass
   - privilege escalation
   - cross-tenant access
   - missing server-side checks

2. **Injection and code execution**
   - SQL/NoSQL/template injection
   - command execution
   - unsafe deserialization
   - XSS through raw HTML sinks

3. **Filesystem, network, and data exposure**
   - path traversal
   - SSRF with attacker-controlled host/protocol
   - sensitive data leakage
   - unsafe file upload/download paths

4. **Business logic and state transitions**
   - payment/subscription bypass
   - permission state confusion
   - irreversible actions missing authorization
   - trust boundary changes introduced by the PR

Each discovery agent must output **candidates**, not final findings:

```md
## Candidate

- File: `path/to/file.ts:42`
- Category: `auth_bypass`
- Changed code: what changed
- Input source: where attacker-controlled data enters
- Sensitive sink or boundary: what is reached
- Possible exploit path: concrete steps if real
- Why it might be false positive: known guard, framework protection, trusted input, etc.
```

Discard candidates that do not name both an **attacker-controlled source** and a
**security-sensitive sink or privilege boundary**.

## Step 5: finding-specific false-positive rules

Before validation, attach the relevant rules to each candidate.

**SSRF**
- Only report if attacker controls host, protocol, or can route to internal
  services.
- Do not report path-only control as SSRF.

**SQL injection**
- Only report if untrusted input reaches string-built SQL or explicitly unsafe
  raw SQL APIs.
- Do not report parameterized queries or normal ORM object filters.

**Command injection**
- Report shell injection when untrusted input reaches a shell string.
- For argv-array execution, prove the called program interprets the argument as
  code, flags, paths with dangerous semantics, or another command.
- Shell scripts are usually trusted tooling. Only report if there is a concrete
  untrusted input path.

**Path traversal**
- Report only when untrusted path segments can escape the intended root and
  read/write/delete sensitive files.
- A correct `resolve()` plus `startsWith(root)` or equivalent containment check
  is usually enough to reject the finding.

**XSS**
- In React/Angular, ignore normal interpolation.
- Look for raw HTML sinks, DOM APIs, markdown-to-HTML without sanitization, or
  user-controlled script/style URLs.

**Auth bypass**
- Client-side missing checks are not vulnerabilities by themselves.
- Prove the backend route/action/job lacks the required authorization or trusts
  client-provided roles, tenant IDs, user IDs, or ownership claims.

**Data exposure**
- Logging URLs or non-PII data is not enough.
- Report plaintext secrets, passwords, tokens, or concrete PII exposure.

**AI prompt injection**
- User-controlled content in an AI prompt is not automatically a vulnerability.
- Report only if the prompt output controls a privileged tool, data access,
  command execution, or authorization decision without a guard.

## Step 6: one validator per candidate

Launch one validator subagent per candidate, in parallel. The validator's job is
to **disprove** the candidate.

Validator prompt shape:

````md
You are validating one security-review candidate. Try to prove this is a false
positive before accepting it.

Repository security context:
<paste compact context>

Candidate:
<paste one candidate>

Rules:
- Only consider vulnerabilities introduced by the reviewed diff.
- Require a concrete attacker-controlled source.
- Require a concrete sensitive sink or authorization boundary.
- Apply the finding-specific false-positive rules.
- Ignore tests, docs, generated files, hardening gaps, DoS, rate limiting,
  dependency age, regex injection, regex DoS, and log spoofing.

Return exactly:

```json
{
  "verdict": "true_positive",
  "confidence": 8,
  "reasoning": "short explanation",
  "exploitPath": "concrete exploit steps",
  "fix": "specific fix"
}
```

Use `"verdict": "false_positive"` or `"verdict": "uncertain"` when the exploit
path is not concrete enough. Set `exploitPath` and `fix` to `null` in those
cases.
````

Only keep candidates with `verdict: "true_positive"` and confidence `>= 8`.

## Step 7: final report format

If there are no findings:

```md
# Security review

No high-confidence security findings in the reviewed changes.
```

If there are findings:

```md
# Security review

## Finding 1: <category> in `<file>:<line>`

- **Severity:** High | Medium
- **Confidence:** 8/10
- **Category:** `auth_bypass`
- **Introduced by:** short description of the changed code
- **Exploit path:** concrete attacker steps
- **Impact:** what the attacker gains
- **Recommendation:** specific fix
```

Never include rejected candidates in the final report unless the user asks for
review notes or methodology.

## Severity rules

- **High:** direct path to authentication bypass, privilege escalation, RCE,
  sensitive data breach, cross-tenant access, or account takeover.
- **Medium:** concrete exploit path with meaningful impact but extra
  preconditions or limited blast radius.
- **Low:** do not report by default. Mention only if the user explicitly asks
  for defense-in-depth findings.

## Hard exclusions

Never report these as findings:

- Denial of service, resource exhaustion, memory/CPU/file descriptor leaks
- Rate limiting gaps
- Dependency age or vulnerable dependency advisories
- Documentation-only issues
- Test-only issues
- Log spoofing
- Regex injection or regex DoS
- Generic lack of hardening, audit logs, or best practices
- Environment variable or CLI flag attacks, unless the repo explicitly treats
  them as untrusted input
