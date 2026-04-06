---
name: termcast
description: Build TUIs with a Raycast-like React API using termcast. Implements @raycast/api components (List, Detail, Form, Action) rendered to the terminal via opentui.
---

# termcast — Build TUIs with a Raycast-like React API

termcast is a framework for building terminal user interfaces using React. It implements the Raycast extension API (`@raycast/api`) but renders to the terminal via opentui. If you know Raycast, you know termcast.

```bash
bun install -g termcast
termcast new my-extension    # scaffold
cd my-extension && termcast dev   # hot-reload dev mode
```

IMPORTANT: before starting every task ALWAYS read opentui docs:
```bash
curl -s https://raw.githubusercontent.com/sst/opentui/refs/heads/main/packages/react/README.md
```

## Imports

For **new projects**, import from `termcast` and `@termcast/utils`:

```tsx
import { List, Detail, Action, ActionPanel, showToast, Toast, Icon, Color } from 'termcast'
import { useCachedPromise, useCachedState } from '@termcast/utils'
```

`@raycast/api` imports still work (for porting existing extensions) but `termcast` is preferred for new code.

## Project Structure

```
my-extension/
  package.json       # must have "commands" array
  src/
    index.tsx        # default command entry point
    other-command.tsx # additional commands
```

**package.json** must declare commands:

```json
{
  "name": "my-extension",
  "commands": [
    {
      "name": "index",
      "title": "Browse Items",
      "description": "Main command",
      "mode": "view"
    }
  ],
  "dependencies": {
    "termcast": "latest",
    "@termcast/utils": "latest"
  }
}
```

Each command file exports a default React component:

```tsx
export default function Command() {
  return <List>...</List>
}
```

For standalone scripts (examples, prototyping), use `renderWithProviders`:

```tsx
import { renderWithProviders } from 'termcast'

await renderWithProviders(<MyComponent />, {
  extensionName: 'my-app',  // required for LocalStorage/Cache to work
})
```

---

## 1. List — The Core Component

The simplest termcast app is a searchable list:

```tsx
import { List } from 'termcast'

export default function Command() {
  return (
    <List searchBarPlaceholder="Search items...">
      <List.Item title="First Item" subtitle="A subtitle" />
      <List.Item title="Second Item" accessories={[{ text: 'Badge' }]} />
      <List.Item
        title="Third Item"
        accessories={[
          { tag: { value: 'Important', color: Color.Red } },
          { date: new Date() },
        ]}
      />
    </List>
  )
}
```

Key props on `List`:
- `navigationTitle` — title in the top bar
- `searchBarPlaceholder` — placeholder text in search
- `isLoading` — shows a loading indicator
- `isShowingDetail` — enables the side detail panel
- `spacingMode` — `'default'` (single-line) or `'relaxed'` (two-line items)
- `onSelectionChange` — callback when selection moves
- `onSearchTextChange` — callback when search text changes
- `throttle` — throttle search change events

Key props on `List.Item`:
- `title`, `subtitle` — main text
- `icon` — emoji string or `{ source: Icon.Star, tintColor: Color.Orange }`
- `accessories` — array of `{ text?, tag?, date?, icon? }`
- `keywords` — extra search terms
- `id` — stable identifier for selection tracking
- `detail` — side panel content (when `isShowingDetail` is true)
- `actions` — ActionPanel for this item

## 2. Actions

Actions are what users can do. The first action triggers on Enter. All actions show in the action panel (ctrl+k).

```tsx
import { List, Action, ActionPanel, showToast, Toast, Icon } from 'termcast'

<List.Item
  title="My Item"
  actions={
    <ActionPanel>
      <Action
        title="Open"
        icon={Icon.Eye}
        onAction={() => { /* primary action on Enter */ }}
      />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ['ctrl'], key: 'r' }}
        onAction={() => { /* triggered by ctrl+r directly */ }}
      />
      <Action.CopyToClipboard title="Copy Name" content="My Item" />
    </ActionPanel>
  }
/>
```

### Action sections

Group related actions:

```tsx
<ActionPanel>
  <ActionPanel.Section title="Primary">
    <Action title="Open" onAction={() => {}} />
  </ActionPanel.Section>
  <ActionPanel.Section title="Copy">
    <Action.CopyToClipboard title="Copy ID" content={item.id} />
    <Action.CopyToClipboard title="Copy Title" content={item.title} />
  </ActionPanel.Section>
</ActionPanel>
```

### Built-in action types

- `Action` — generic action with `onAction`
- `Action.Push` — push a new view onto the navigation stack
- `Action.CopyToClipboard` — copy text to clipboard
- `Action.SubmitForm` — submit a form (used inside Form)

### Keyboard shortcuts

Shortcuts use `ctrl` or `alt` modifiers with letter keys. `cmd` (hyper) does **not** work in terminals — the parent terminal app intercepts it.

```tsx
shortcut={{ modifiers: ['ctrl'], key: 'r' }}           // ctrl+r
shortcut={{ modifiers: ['ctrl', 'shift'], key: 'r' }}  // ctrl+shift+r
shortcut={{ modifiers: ['alt'], key: 'd' }}             // alt+d
// Also available: Keyboard.Shortcut.Common.Refresh, etc.
```

**Note**: `ctrl+digit` shortcuts don't work reliably. Always use letters.

## 3. Navigation

Push and pop views onto a navigation stack. Esc goes back.

```tsx
import { useNavigation, Detail, Action, ActionPanel } from 'termcast'

function ItemDetail({ item }: { item: Item }) {
  const { pop } = useNavigation()
  return (
    <Detail
      navigationTitle={item.title}
      markdown={`# ${item.title}\n\n${item.description}`}
      actions={
        <ActionPanel>
          <Action title="Go Back" onAction={() => { pop() }} />
        </ActionPanel>
      }
    />
  )
}

// In a list item:
function MyList() {
  const { push } = useNavigation()
  return (
    <List>
      <List.Item
        title="Item A"
        actions={
          <ActionPanel>
            <Action
              title="View Detail"
              onAction={() => { push(<ItemDetail item={itemA} />) }}
            />
            {/* Or use Action.Push for declarative navigation */}
            <Action.Push
              title="View Detail"
              target={<ItemDetail item={itemA} />}
            />
          </ActionPanel>
        }
      />
    </List>
  )
}
```

**Important**: props passed via `push()` are captured at push time and won't sync with parent state changes. If the child needs reactive parent state, use zustand or pass a zustand store via props.

## 4. Detail View

Full-screen markdown view with optional metadata sidebar:

```tsx
import { Detail, Color } from 'termcast'

<Detail
  navigationTitle="Server Status"
  markdown={`# Server Status\n\nAll systems operational.\n\n| Service | Status |\n|---------|--------|\n| API | Running |\n| DB | Running |`}
  metadata={
    <Detail.Metadata>
      <Detail.Metadata.Label title="Status" text={{ value: "Active", color: Color.Green }} />
      <Detail.Metadata.Label title="Uptime" text="14d 3h" />
      <Detail.Metadata.Separator />
      <Detail.Metadata.Link
        title="Dashboard"
        target="https://example.com"
        text="example.com"
      />
      <Detail.Metadata.Separator />
      <Detail.Metadata.TagList title="Tags">
        <Detail.Metadata.TagList.Item text="production" color={Color.Green} />
        <Detail.Metadata.TagList.Item text="critical" color={Color.Red} />
      </Detail.Metadata.TagList>
    </Detail.Metadata>
  }
  actions={
    <ActionPanel>
      <Action title="Refresh" onAction={() => {}} />
    </ActionPanel>
  }
/>
```

### Metadata components

- `Label` — key-value row. `text` can be a string or `{ value, color }`
- `Separator` — horizontal divider
- `Link` — clickable link (OSC 8 hyperlinks in supported terminals)
- `TagList` — row of colored tags via `TagList.Item`

## 5. List with Side Detail Panel

Show a detail panel alongside the list. The detail updates as the user navigates items:

```tsx
<List isShowingDetail={true} navigationTitle="Pokemon List">
  {pokemons.map((pokemon) => (
    <List.Item
      key={pokemon.id}
      title={pokemon.name}
      subtitle={`#${pokemon.id}`}
      detail={
        <List.Item.Detail
          markdown={`# ${pokemon.name}\n\nTypes: ${pokemon.types.join(', ')}`}
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title="Height" text={`${pokemon.height}m`} />
              <List.Item.Detail.Metadata.Label title="Weight" text={`${pokemon.weight}kg`} />
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.TagList title="Types">
                {pokemon.types.map((t) => (
                  <List.Item.Detail.Metadata.TagList.Item key={t} text={t} />
                ))}
              </List.Item.Detail.Metadata.TagList>
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          <Action title="Toggle Detail" onAction={() => { setShowingDetail(!showingDetail) }} />
        </ActionPanel>
      }
    />
  ))}
</List>
```

## 6. Sections and Dropdowns

### Sections

Group items with headers:

```tsx
<List>
  <List.Section title="Fruits">
    <List.Item title="Apple" />
    <List.Item title="Banana" />
  </List.Section>
  <List.Section title="Vegetables">
    <List.Item title="Carrot" />
  </List.Section>
</List>
```

Empty sections are automatically hidden.

### Dropdown filter

Add a dropdown next to the search bar:

```tsx
<List
  searchBarAccessory={
    <List.Dropdown tooltip="Category" onChange={setCategory}>
      <List.Dropdown.Item title="All" value="all" />
      <List.Dropdown.Section title="Types">
        <List.Dropdown.Item title="Beer" value="beer" />
        <List.Dropdown.Item title="Wine" value="wine" />
      </List.Dropdown.Section>
    </List.Dropdown>
  }
>
  {filteredItems.map((item) => (
    <List.Item key={item.id} title={item.name} />
  ))}
</List>
```

## 7. Forms

Collect user input. Navigate fields with Tab/arrows. Submit with ctrl+enter or via action panel.

```tsx
import { Form, Action, ActionPanel, showToast, Toast } from 'termcast'

function CreateItem() {
  return (
    <Form
      navigationTitle="New Item"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Create"
            onSubmit={async (values) => {
              await showToast({ style: Toast.Style.Success, title: 'Created!' })
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" placeholder="Item name" />
      <Form.TextArea id="description" title="Description" placeholder="Describe..." />
      <Form.Dropdown id="priority" title="Priority">
        <Form.Dropdown.Item value="high" title="High" />
        <Form.Dropdown.Item value="medium" title="Medium" />
        <Form.Dropdown.Item value="low" title="Low" />
      </Form.Dropdown>
      <Form.Checkbox id="urgent" title="Flags" label="Mark as urgent" />
      <Form.DatePicker id="dueDate" title="Due Date" type={Form.DatePicker.Type.Date} />
      <Form.Separator />
      <Form.Description title="Help" text="Tab to move between fields. ctrl+enter to submit." />
    </Form>
  )
}
```

Form field types: `TextField`, `PasswordField`, `TextArea`, `Checkbox`, `Dropdown`, `DatePicker`, `TagPicker`, `FilePicker`, `Separator`, `Description`.

## 8. Toasts

Show feedback to the user:

```tsx
import { showToast, Toast, showFailureToast } from 'termcast'

// Success
await showToast({ style: Toast.Style.Success, title: 'Saved', message: 'Item updated' })

// Failure
await showToast({ style: Toast.Style.Failure, title: 'Error', message: 'Connection failed' })

// From a caught error (shows title + error message)
await showFailureToast(error, { title: 'Failed to fetch' })
```

---

## Data Fetching

### useCachedPromise

The primary hook for async data. Handles loading state, caching, revalidation, and pagination.

```tsx
import { useCachedPromise } from '@termcast/utils'

function MyList() {
  const { data, isLoading, revalidate } = useCachedPromise(
    async (query: string) => {
      const response = await fetch(`/api/search?q=${query}`)
      return response.json()
    },
    [searchText],  // re-fetches when these change
  )

  return (
    <List isLoading={isLoading}>
      {data?.map((item) => (
        <List.Item key={item.id} title={item.name} />
      ))}
    </List>
  )
}
```

### Pagination

For infinite scroll lists:

```tsx
const { data, isLoading, pagination } = useCachedPromise(
  (query: string) => {
    return async ({ cursor }: { page: number; cursor?: string }) => {
      const result = await fetchItems({ query, pageToken: cursor })
      return {
        data: result.items,
        hasMore: !!result.nextPageToken,
        cursor: result.nextPageToken,
      }
    }
  },
  [searchText],
  { keepPreviousData: true },
)

return (
  <List isLoading={isLoading} pagination={pagination}>
    {data?.map((item) => <List.Item key={item.id} title={item.name} />)}
  </List>
)
```

### useCachedState

Persistent UI state that survives across sessions (stored in SQLite):

```tsx
import { useCachedState } from '@termcast/utils'

const [selectedAccount, setSelectedAccount] = useCachedState(
  'selectedAccount',     // key
  'all',                 // default value
  { cacheNamespace: 'my-extension' },
)

const [isShowingDetail, setIsShowingDetail] = useCachedState(
  'isShowingDetail',
  true,
  { cacheNamespace: 'my-extension' },
)
```

### Revalidation pattern

After mutations, call `revalidate()` to refresh the data:

```tsx
const { data, revalidate } = useCachedPromise(fetchItems, [])

const handleDelete = async (id: string) => {
  await deleteItem(id)
  await showToast({ style: Toast.Style.Success, title: 'Deleted' })
  revalidate()  // refresh the list
}
```

---

## Termcast-Exclusive Components

These components are unique to termcast — not available in Raycast. They can be placed inside `Detail.Metadata`, `List.Item.Detail.Metadata`, or used standalone in a Detail view.

### Graph (line chart with braille rendering)

```tsx
import { Graph, Color, Detail } from 'termcast'

<Detail
  markdown="# Stock Price"
  metadata={
    <Graph height={15} xLabels={['Jan', 'Apr', 'Jul', 'Oct']} yTicks={6}>
      <Graph.Line data={[150, 162, 175, 190, 201]} color={Color.Orange} title="AAPL" />
      <Graph.Line data={[120, 135, 140, 155, 160]} color={Color.Blue} title="MSFT" />
    </Graph>
  }
/>
```

Variants: `'area'` (default), `'filled'`, `'striped'`. Set via the `variant` prop on Graph.

### BarGraph (vertical stacked bars)

```tsx
import { BarGraph } from 'termcast'

<BarGraph height={10} labels={['Mon', 'Tue', 'Wed', 'Thu', 'Fri']}>
  <BarGraph.Series data={[40, 30, 25, 15, 50]} title="Direct" />
  <BarGraph.Series data={[30, 35, 15, 20, 35]} title="Organic" />
  <BarGraph.Series data={[20, 25, 10, 10, 25]} title="Referral" />
</BarGraph>
```

### BarChart (horizontal stacked bars)

```tsx
import { BarChart } from 'termcast'

<BarChart
  segments={[
    { title: 'Used', value: 75 },
    { title: 'Free', value: 25 },
  ]}
/>
```

### CalendarHeatmap

GitHub-style contribution grid:

```tsx
import { CalendarHeatmap, Color } from 'termcast'
import type { CalendarHeatmapData } from 'termcast'

const data: CalendarHeatmapData[] = days.map((date) => ({
  date: new Date(date),
  value: Math.floor(Math.random() * 8),
}))

<CalendarHeatmap data={data} color={Color.Green} />
<CalendarHeatmap data={data} color={Color.Blue} emptyColor={Color.Purple} />
```

### Table

Borderless table with header background and alternating row stripes:

```tsx
import { Table } from 'termcast'

<Table
  headers={['Region', 'Latency', 'Status']}
  rows={[
    ['us-east-1', '**12ms**', 'OK'],
    ['eu-west-1', '*45ms*', 'OK'],
    ['ap-south-1', '`89ms`', 'Degraded'],
  ]}
/>
```

Cells support inline markdown: `**bold**`, `*italic*`, `` `code` ``, `~~strikethrough~~`, `[links](url)`.

### ProgressBar

Usage/progress display:

```tsx
import { ProgressBar } from 'termcast'

<ProgressBar title="Current session" value={37} percentageSuffix="used" label="Resets 9pm" />
<ProgressBar title="Weekly quota" value={82} percentageSuffix="used" label="Resets Mar 1" />
```

### Row (side-by-side layout)

Place any components side by side:

```tsx
import { Row, Graph, BarGraph, Table, Color } from 'termcast'

<Row>
  <Graph height={10} xLabels={['Mon', 'Fri']}>
    <Graph.Line data={cpuData} color={Color.Orange} title="CPU" />
  </Graph>
  <Graph height={10} xLabels={['Mon', 'Fri']}>
    <Graph.Line data={memData} color={Color.Blue} title="Memory" />
  </Graph>
</Row>

<Row>
  <Table headers={['Region', 'Latency']} rows={[['us-east', '12ms']]} />
  <Table headers={['Endpoint', 'RPS']} rows={[['/api/auth', '1200']]} />
</Row>
```

### Markdown (standalone block in metadata)

Render markdown anywhere inside metadata:

```tsx
import { Markdown, CalendarHeatmap, Color, Detail } from 'termcast'

<Detail.Metadata>
  <Markdown content="**Long history** — 5 years of daily data in purple." />
  <CalendarHeatmap data={longData} color={Color.Purple} />
  <Markdown content="**Recent** — last 150 days in red." />
  <CalendarHeatmap data={recentData} color={Color.Red} />
</Detail.Metadata>
```

### Combining components in metadata

All termcast-exclusive components compose freely inside metadata:

```tsx
<Detail
  markdown="# Dashboard"
  metadata={
    <Detail.Metadata>
      <Detail.Metadata.Label title="Status" text={{ value: "Active", color: Color.Green }} />
      <Detail.Metadata.Separator />
      <Graph height={12} xLabels={['6h', '12h', '18h', '24h']}>
        <Graph.Line data={requestsPerHour} color={Color.Orange} title="RPS" />
      </Graph>
      <Row>
        <BarGraph height={8} labels={['Mon', 'Tue', 'Wed']}>
          <BarGraph.Series data={[100, 150, 120]} title="2xx" />
          <BarGraph.Series data={[5, 8, 3]} title="5xx" />
        </BarGraph>
        <Table
          headers={['Endpoint', 'p99']}
          rows={[['/api/auth', '45ms'], ['/api/data', '120ms']]}
        />
      </Row>
      <ProgressBar title="Rate limit" value={62} percentageSuffix="used" />
      <CalendarHeatmap data={uptimeData} color={Color.Green} />
      <Detail.Metadata.TagList title="Regions">
        <Detail.Metadata.TagList.Item text="us-east" color={Color.Blue} />
        <Detail.Metadata.TagList.Item text="eu-west" color={Color.Green} />
      </Detail.Metadata.TagList>
    </Detail.Metadata>
  }
/>
```

---

## Real-World Patterns

These patterns are drawn from a production termcast extension (a Gmail TUI wrapping an existing CLI tool).

### Gluing a CLI tool with a TUI

The pattern: import your existing business logic, wrap it with termcast components.

```
┌─────────────────────────────────────────────┐
│  mail-tui.tsx (termcast UI)                 │
│  - List, Detail, Form, ActionPanel          │
│  - useCachedPromise for data fetching       │
│  - useCachedState for persistent prefs      │
├─────────────────────────────────────────────┤
│  auth.ts / gmail-client.ts (business logic) │
│  - OAuth, API calls, data models            │
│  - Pure TypeScript, no React dependencies   │
└─────────────────────────────────────────────┘
```

The TUI file only handles rendering. All API calls, auth, and data processing live in separate files that work independently of the UI.

### Multi-account dropdown

```tsx
function AccountDropdown({ accounts, value, onChange }: {
  accounts: { email: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <List.Dropdown tooltip="Account" value={value} onChange={onChange}>
      <List.Dropdown.Item title="All Accounts" value="all" icon={Icon.Globe} />
      <List.Dropdown.Section title="Accounts">
        {accounts.map((a) => (
          <List.Dropdown.Item key={a.email} title={a.email} value={a.email} />
        ))}
      </List.Dropdown.Section>
    </List.Dropdown>
  )
}

// Usage:
<List searchBarAccessory={
  <AccountDropdown accounts={accounts} value={selected} onChange={setSelected} />
}>
```

### Date-based section grouping

```tsx
function dateSection(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)

  if (date >= today) return 'Today'
  if (date >= yesterday) return 'Yesterday'
  return 'Older'
}

const sections = useMemo(() => {
  const groups = new Map<string, Item[]>()
  for (const item of items) {
    const section = dateSection(item.date)
    const list = groups.get(section) ?? []
    list.push(item)
    groups.set(section, list)
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }))
}, [items])

return (
  <List>
    {sections.map((section) => (
      <List.Section key={section.name} title={section.name}>
        {section.items.map((item) => (
          <List.Item key={item.id} title={item.title} />
        ))}
      </List.Section>
    ))}
  </List>
)
```

### Mutations with loading state

```tsx
const [activeMutations, setActiveMutations] = useState(0)
const isMutating = activeMutations > 0

const withMutation = async <T,>(fn: () => Promise<T>): Promise<T> => {
  setActiveMutations((n) => n + 1)
  try { return await fn() }
  finally { setActiveMutations((n) => n - 1) }
}

// Usage in an action:
<Action
  title="Archive"
  onAction={() => withMutation(async () => {
    await archiveItem(item.id)
    await showToast({ style: Toast.Style.Success, title: 'Archived' })
    revalidate()
  })}
/>

<List isLoading={isLoading || isMutating}>
```

### Compose forms via Action.Push

```tsx
<ActionPanel.Section title="Reply & Forward">
  <Action.Push
    title="Reply"
    icon={Icon.Reply}
    shortcut={{ modifiers: ['ctrl'], key: 'r' }}
    target={
      <ComposeForm
        mode={{ type: 'reply', threadId: thread.id }}
        onSent={revalidate}
      />
    }
  />
  <Action.Push
    title="Forward"
    icon={Icon.Forward}
    shortcut={{ modifiers: ['ctrl'], key: 'f' }}
    target={
      <ComposeForm
        mode={{ type: 'forward', threadId: thread.id }}
        onSent={revalidate}
      />
    }
  />
</ActionPanel.Section>
```

---

## Porting from Raycast

If you're converting an existing Raycast extension:

1. **Change imports**: `@raycast/api` -> `termcast`, `@raycast/utils` -> `@termcast/utils`
2. **Keyboard modifiers**: `cmd` doesn't work in terminals. Replace with `ctrl` or `alt`
3. **Enter key**: named `return` in opentui key events
4. **Images**: no pixel rendering in terminals. Emoji and text fallbacks are used
5. **Everything else** works the same: List, Detail, Form, Action, Toast, Navigation, LocalStorage, Cache, Clipboard, OAuth

The compound component patterns are identical:
- `List.Item`, `List.Section`, `List.Dropdown`, `List.Dropdown.Item`
- `Detail.Metadata`, `Detail.Metadata.Label`, `Detail.Metadata.TagList`
- `Form.TextField`, `Form.Dropdown`, `Form.Dropdown.Item`
- `ActionPanel.Section`

---

## Gotchas

- **Use `logger.log`** instead of `console.log` — logs go to `app.log` in the extension directory
- **Never use `setTimeout`** for scheduling React state updates
- **Never pass functions** to `useEffect` dependencies — causes infinite loops
- **Minimize `useState`** — compute derived state inline when possible
- **Always use `.tsx` extension** for files with JSX
- **`useEffect` is discouraged** — colocate logic in event handlers when possible
- **Never use `as any`** — find proper types, import them, or use `@ts-expect-error` with explanation
- **Shortcuts**: use `ctrl`/`alt` + **letter** keys only (not digits)
- **`showFailureToast(error, { title })`** is the standard way to handle errors in actions
- **`revalidate()`** after every mutation to refresh data

## Running and Testing Extensions

### Running with `termcast dev`

The primary way to develop and try out an extension:

```bash
cd my-extension
termcast dev
```

This launches the TUI with hot-reload. File changes rebuild and refresh automatically. This is the fast iteration loop for development.

### Interactive experimentation with tuistory CLI

tuistory is a CLI tool for driving terminal applications from the shell — like Playwright but for TUIs. Use it to launch your extension, interact with it, and take snapshots without manual intervention.

**Always run `tuistory --help` first** to see the latest commands and options.

```bash
# Launch the extension in a managed terminal session
tuistory launch "termcast dev" -s my-ext --cols 120 --rows 36

# See current terminal state
tuistory -s my-ext snapshot --trim

# Interact
tuistory -s my-ext type "search query"
tuistory -s my-ext press enter
tuistory -s my-ext press ctrl k        # open action panel
tuistory -s my-ext press tab           # next form field
tuistory -s my-ext press esc           # go back

# Take a screenshot as image
tuistory -s my-ext screenshot -o ./tmp/screenshot.jpg --pixel-ratio 2

# Observe after each action
tuistory -s my-ext snapshot --trim

# Cleanup
tuistory -s my-ext close
```

### Automated tests with vitest + tuistory JS API

tuistory provides a Playwright-style JS API for writing automated TUI tests. The workflow is **observe-act-observe**: take a snapshot, interact, take another snapshot.

```ts
import { test, expect } from 'vitest'
import { launchTerminal } from 'tuistory'

test('extension shows items and navigates to detail', async () => {
  const session = await launchTerminal({
    command: 'termcast',
    args: ['dev'],
    cols: 120,
    rows: 36,
    cwd: '/path/to/my-extension',
  })

  // Wait for the list to render
  await session.waitForText('Search', { timeout: 10000 })

  // Observe initial state
  const initial = await session.text({ trimEnd: true })
  expect(initial).toMatchInlineSnapshot()

  // Type a search query
  await session.type('project')
  const filtered = await session.text({ trimEnd: true })
  expect(filtered).toMatchInlineSnapshot()

  // Press Enter to trigger primary action
  await session.press('enter')
  await session.waitForText('Detail', { timeout: 5000 })
  const detail = await session.text({ trimEnd: true })
  expect(detail).toMatchInlineSnapshot()

  // Go back
  await session.press('esc')

  session.close()
}, 30000)
```

Run with:

```bash
vitest --run -u        # fill in snapshots
vitest --run           # verify snapshots match
```

Always leave `toMatchInlineSnapshot()` empty the first time, run with `-u` to fill them, then read back the test file to verify the captured output is correct.
