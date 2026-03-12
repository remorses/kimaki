---
name: x-articles
description: >
  Edit x.com (Twitter) long-form article drafts reliably. Use this for
  markdown imports, bulk formatting, code blocks, headings, lists, and
  repeated inline styling. Inspect and validate with Playwriter, but prefer
  x.com (Twitter) article GraphQL mutations for deterministic updates.
version: 0.1.0
---

<!-- Skill for editing x.com (Twitter) article drafts through Playwriter plus content-state mutations. -->

Use this skill when editing long-form article drafts on `x.com/compose/articles`
(Twitter Articles).

## Read Playwriter First

Before using this skill, read the `playwriter` skill and run:

```bash
playwriter skill
```

This skill assumes Playwriter is already set up and connected to the user's
existing Chrome session.

Read the full output. Do not pipe it through `head`, `tail`, or other
truncation commands.

## Core idea

Use Playwriter for three things:

1. connect to the already-open x.com (Twitter) article draft
2. inspect the editor and capture one real network mutation
3. validate the final rendered result after updates

For anything bigger than a tiny tweak, do **not** rely on manual typing inside
the editor. Generate the article `content_state` locally and send the same
GraphQL mutation x.com (Twitter) already uses.

## Editor model

The article body is represented as a `content_state` object with two main
parts:

- `blocks`: ordered content blocks
- `entity_map`: supporting entities, especially code blocks

Important block types:

- `unstyled` — normal paragraph
- `header-two` — section subheading
- `ordered-list-item` — numbered list item
- `atomic` — embedded block like a markdown code block

Important entity type:

- `MARKDOWN` — used for code blocks, with the markdown fence stored in
  `entity_map[*].value.data.markdown`

## Recommended workflow

### 1. Open or locate the draft

Find the existing article editor page in the connected browser. The URL format
is:

```text
https://x.com/compose/articles/edit/<article_id>
```

Always parse and keep the numeric `article_id`. The content mutation needs it.

Example Playwriter check:

```bash
playwriter session new
playwriter -s 1 -e '
state.page = context.pages().find((p) => {
  return p.url().includes("/compose/articles/edit/")
})
if (!state.page) {
  throw new Error("No article editor page found")
}
console.log(state.page.url())
'
```

### 2. Explore with small manual edits first

Use the UI to learn how the editor reacts before doing bulk updates. Good
exploration tasks:

- add one paragraph
- convert one block to `Sottotitolo`
- insert one code block
- bold one word in one paragraph

After each change, inspect the rendered HTML with `getCleanHTML()`.

Example validation command:

```bash
playwriter -s 1 -e '
state.page = context.pages().find((p) => {
  return p.url().includes("/compose/articles/edit/")
})
console.log(
  await getCleanHTML({
    locator: state.page.locator("[data-testid=\"composer\"]"),
    showDiffSinceLastCall: false,
  }),
)
'
```

### 3. Capture real network traffic

Watch GraphQL requests while making one tiny manual change. This gives you the
exact mutation names and payload shapes used by the current x.com (Twitter)
editor.

The two important mutations found in this session were:

- `ArticleEntityUpdateTitle`
- `ArticleEntityUpdateContent`

The content mutation URL looked like:

```text
https://x.com/i/api/graphql/<queryId>/ArticleEntityUpdateContent
```

The exact `queryId` can change over time. Do not hardcode it blindly without
first confirming it from a real request in the current session.

Example request logger:

```bash
playwriter -s 1 -e '
state.page = context.pages().find((p) => {
  return p.url().includes("/compose/articles/edit/")
})
state.requests = []
state.page.removeAllListeners("request")
state.page.on("request", (req) => {
  if (req.url().includes("ArticleEntity") || req.url().includes("graphql")) {
    state.requests.push({
      url: req.url(),
      method: req.method(),
      postData: req.postData(),
    })
  }
})
console.log(
  "Ready: now make one tiny manual edit in the page, then rerun this command to inspect state.requests",
)
'
```

### 4. Use direct content updates for bulk work

Once you know the current mutation shape, generate the full `content_state`
locally and send the content update directly.

This is the reliable path for:

- full markdown import
- replacing large sections
- converting paragraphs to ordered lists
- adding one bold keyword per paragraph
- fixing code block languages

Concrete pattern:

1. build `content_state` in a local JSON file
2. read `ct0` from `document.cookie`
3. send `ArticleEntityUpdateContent` with the same `queryId` and feature flags
4. reload the page

### 5. Reload and validate

After every direct mutation:

1. reload the article editor page
2. inspect `getCleanHTML()`
3. search for expected headings, list items, bold splits, and code labels

Do not trust the visual editor alone.

Example reload + search:

```bash
playwriter -s 1 -e '
state.page = context.pages().find((p) => {
  return p.url().includes("/compose/articles/edit/")
})
await state.page.reload({ waitUntil: "domcontentloaded" })
await waitForPageLoad({ page: state.page, timeout: 8000 })
console.log(
  await getCleanHTML({
    locator: state.page.locator("[data-testid=\"composer\"]"),
    search: /debugging with event streams|typescript|ordered-list-item/i,
    showDiffSinceLastCall: false,
  }),
)
'
```

## Block type cheatsheet

### Paragraphs

Use:

```json
{
  "type": "unstyled",
  "text": "your paragraph text"
}
```

### Subheadings

Use:

```json
{
  "type": "header-two",
  "text": "debugging with event streams"
}
```

### Numbered lists

Each item is its own block:

```json
{
  "type": "ordered-list-item",
  "text": "doubles your bug surface"
}
```

### Code blocks

Code blocks are not plain text blocks. They are:

1. one `atomic` block in `blocks`
2. one `MARKDOWN` entity in `entity_map`

The atomic block points to the entity with `entity_ranges`.

The entity markdown should include the full fence, for example:

````text
```typescript
const x = 1
```
````

If you want the visible language label to say `typescript`, the stored fence
must be ` ```typescript `, not ` ```ts `.

## Inline styles

Bold text is represented with `inlineStyleRanges` inside a block.

Important session learning:

- the style name is `Bold`
- not `BOLD`

Example:

```json
{
  "text": "your clanker loves state",
  "inlineStyleRanges": [
    { "offset": 19, "length": 5, "style": "Bold" }
  ]
}
```

Always calculate offsets against the raw block text exactly as stored.

## Known UI pitfalls

The manual editor flow has several traps:

### Heading inheritance

After creating a heading, pressing `Enter` once can keep the next block in the
same heading style. To reset to a paragraph, press `Enter` again.

### Post-code-block cursor placement

Typing after a code block is unreliable. The editor can:

- append text to the wrong block
- split text unexpectedly
- create stray headings
- leave part of a sentence in one block and the rest in another

For anything more than a tiny manual tweak, use direct content updates instead.

### Visual feedback is incomplete

The editor can look correct while the underlying block structure is wrong.
Always inspect the HTML or mutation payload.

### Playwriter sessions can reset

If the relay server restarts or the extension reconnects, Playwriter sessions
can disappear. If that happens, create a new Playwriter session and reattach to
the already-open article page.

Recovery command:

```bash
playwriter session new
playwriter -s 1 -e '
state.page = context.pages().find((p) => {
  return p.url().includes("/compose/articles/edit/")
})
if (!state.page) {
  throw new Error("No article editor page found")
}
console.log(state.page.url())
'
```

## Auth and request details

Direct content updates need proper auth headers. In this session, the direct
`fetch()` worked only after including:

- the X bearer token
- `x-csrf-token` from the `ct0` cookie
- the standard X active-user/auth/client-language headers

If you get `403`, inspect the successful browser request and match its headers.

In this session, the direct fetch succeeded only after matching:

- bearer token
- `x-csrf-token`
- `x-twitter-active-user`
- `x-twitter-auth-type`
- `x-twitter-client-language`

## Validation checklist

After updating an article, verify all of these:

1. correct title in the title field
2. headings appear as `header-two`
3. ordered lists appear as `ordered-list-item`
4. code blocks render as `markdown-code-block`
5. code block language labels say what you expect, for example `typescript`
6. bold keywords are split into separate styled spans in the HTML
7. no stray empty headings or broken split paragraphs remain

## Useful recipes

### Import a markdown article

1. parse the markdown locally
2. map paragraphs to `unstyled`
3. map `##` headings to `header-two`
4. map numbered list items to `ordered-list-item`
5. map fenced code blocks to `atomic` + `MARKDOWN` entities
6. send `ArticleEntityUpdateContent`
7. reload and validate

The fastest implementation is usually:

1. generate `./tmp/x-article-content-state.json`
2. read it from a Playwriter command with `fs.readFileSync`
3. push it with the direct content mutation

### Bold one keyword per paragraph

1. choose one keyword per paragraph
2. compute exact `offset` and `length`
3. add `inlineStyleRanges` with style `Bold`
4. push the updated `content_state`
5. reload and verify the HTML splits around the bold span

### Fix code language labels

Update the markdown entity fences. Example:

- bad: ` ```ts `
- good: ` ```typescript `

Then resend the full `content_state` and reload the editor.

## Minimal bulk update example

Use this pattern when you already have the right `queryId` and payload shape:

```bash
playwriter -s 1 -e '
const fs = require("node:fs")
state.page = context.pages().find((p) => {
  return p.url().includes("/compose/articles/edit/")
})
const articleId = state.page.url().match(/edit\/(\d+)/)?.[1]
const contentState = JSON.parse(
  fs.readFileSync("./tmp/x-article-content-state.json", "utf8"),
)
const csrfToken = await state.page.evaluate(() => {
  return document.cookie
    .split("; ")
    .find((x) => x.startsWith("ct0="))
    ?.slice(4) || ""
})
const payload = {
  variables: {
    content_state: contentState,
    article_entity: articleId,
  },
  features: {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  },
  queryId: "<capture-from-real-request>",
}
const response = await state.page.evaluate(async ({ payload, csrfToken }) => {
  const res = await fetch(
    `https://x.com/i/api/graphql/${payload.queryId}/ArticleEntityUpdateContent`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        authorization: "<capture-from-real-request>",
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": "it",
      },
      body: JSON.stringify(payload),
    },
  )
  return { status: res.status, text: await res.text() }
}, { payload, csrfToken })
console.log(response.status)
console.log(response.text.slice(0, 1000))
'
```

Replace the bearer token and `queryId` with values captured from a successful
browser request in the current session.

## Default strategy

Use this default unless the task is tiny:

1. inspect the current draft in the browser
2. capture one real content mutation from X
3. generate the final `content_state` locally
4. update the draft with the same mutation shape
5. validate the result in the live editor HTML

That is the fastest path and the most likely to work in one shot.
