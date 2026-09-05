---
'kimaki': minor
---

Show a short bash **description** in Discord when the command is longer than 50 characters.

Kimaki now adds `description` and `hasSideEffect` to the built-in OpenCode bash tool schema. Models still run the real bash tool. Discord shows the command when it is short, and the description when it is long.

```ts
await session.prompt({
  parts: [{
    type: 'text',
    text: 'run the tests',
  }],
})
```

A typical bash call now looks like:

```ts
{
  command: 'pnpm run test --run src/message-formatting.test.ts',
  description: 'Run formatting tests',
  hasSideEffect: false,
}
```
