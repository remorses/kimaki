// usecomputer CLI — computer automation for AI agents.
// Outline only. Commands print "not implemented" placeholders.

import { goke } from 'goke'
import { z } from 'zod'
import dedent from 'string-dedent'
import pkg from '../package.json' with { type: 'json' }

const cli = goke('usecomputer')

// ─── Core Commands ──────────────────────────────────────────────────────

cli
  .command(
    'snapshot',
    dedent`
      Capture the accessibility tree of the desktop or a window.

      Uses native accessibility APIs (macOS AX, AT-SPI on Linux, UIA on Windows)
      to produce a structured tree of UI elements with roles, names, and ref IDs.
      Refs like @e1, @e2 can be used in click, type, and other commands.
    `,
  )
  .option('-w, --window [window]', z.string().describe('Target a specific window by title or ID'))
  .option('-a, --app [app]', z.string().describe('Target a specific application by name or bundle ID'))
  .option('-i, --interactive', 'Only show interactive elements (buttons, inputs, links)')
  .option('-c, --compact', 'Remove empty structural elements')
  .option('-d, --depth [depth]', z.number().describe('Limit tree depth'))
  .example('# Full desktop accessibility snapshot')
  .example('usecomputer snapshot')
  .example('# Interactive elements in a specific app')
  .example('usecomputer snapshot --app "Visual Studio Code" -i')
  .action((options) => {
    console.log('not implemented')
  })

cli
  .command(
    'screenshot [path]',
    dedent`
      Take a screenshot of the entire screen, a window, or a region.

      Saves as PNG. If no path is given, prints the file path of a temp file.
      Use --window or --app to capture a specific window.
      Use --region to capture a rectangular area (x,y,width,height).
    `,
  )
  .option('-w, --window [window]', z.string().describe('Capture a specific window by title or ID'))
  .option('-a, --app [app]', z.string().describe('Capture a specific application by name or bundle ID'))
  .option('-r, --region [region]', z.string().describe('Capture region as x,y,width,height'))
  .option('--display [display]', z.number().describe('Display/monitor index for multi-monitor setups'))
  .option('--annotate', 'Annotate screenshot with numbered labels on interactive elements')
  .example('# Screenshot entire screen')
  .example('usecomputer screenshot')
  .example('# Screenshot a specific app window')
  .example('usecomputer screenshot --app Finder ~/Desktop/finder.png')
  .example('# Screenshot a region')
  .example('usecomputer screenshot --region 100,200,800,600')
  .action((path, options) => {
    console.log('not implemented')
  })

cli
  .command(
    'click <target>',
    dedent`
      Click at a target. Target can be:
      - Coordinates: "500,300" (x,y pixels)
      - Accessibility ref: "@e2" (from a snapshot)
      - Text match: "Submit" (finds element by accessible name)
    `,
  )
  .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
  .option('--count [count]', z.number().default(1).describe('Number of clicks (2 for double-click)'))
  .option('--modifiers [modifiers]', z.string().describe('Modifier keys held during click (ctrl,shift,alt,meta)'))
  .example('# Click at coordinates')
  .example('usecomputer click 500,300')
  .example('# Click an element from snapshot')
  .example('usecomputer click @e2')
  .example('# Right-click')
  .example('usecomputer click 500,300 --button right')
  .example('# Double-click')
  .example('usecomputer click @e5 --count 2')
  .action((target, options) => {
    console.log('not implemented')
  })

cli
  .command(
    'type <text>',
    dedent`
      Type text using keyboard input, as if the user is typing.

      Types each character sequentially with realistic key events.
      Works with the currently focused element. Use "click" first to focus.
    `,
  )
  .option('--delay [delay]', z.number().describe('Delay between keystrokes in milliseconds'))
  .example('# Type into the currently focused field')
  .example('usecomputer type "Hello, world!"')
  .action((text, options) => {
    console.log('not implemented')
  })

cli
  .command(
    'press <key>',
    dedent`
      Press a key or key combination.

      Supports modifier combos like "ctrl+c", "cmd+shift+s", "alt+tab".
      Key names: enter, tab, escape, space, backspace, delete, up, down,
      left, right, home, end, pageup, pagedown, f1-f12.
    `,
  )
  .option('--count [count]', z.number().default(1).describe('Number of times to press'))
  .option('--delay [delay]', z.number().describe('Delay between repeated presses in milliseconds'))
  .example('# Press Enter')
  .example('usecomputer press enter')
  .example('# Copy to clipboard')
  .example('usecomputer press cmd+c')
  .example('# Switch apps on macOS')
  .example('usecomputer press cmd+tab')
  .example('# Press Escape 3 times')
  .example('usecomputer press escape --count 3')
  .action((key, options) => {
    console.log('not implemented')
  })

cli
  .command(
    'scroll <direction> [amount]',
    dedent`
      Scroll in a direction. Amount is in pixels (default: 300).

      Directions: up, down, left, right.
      Scrolls at the current mouse position unless --at is specified.
    `,
  )
  .option('--at [at]', z.string().describe('Scroll at specific coordinates (x,y)'))
  .example('# Scroll down')
  .example('usecomputer scroll down')
  .example('# Scroll up 500px at a specific position')
  .example('usecomputer scroll up 500 --at 400,300')
  .action((direction, amount, options) => {
    console.log('not implemented')
  })

cli
  .command(
    'drag <from> <to>',
    dedent`
      Drag from one position to another.

      Positions are x,y coordinates or accessibility refs (@e1).
      Performs mouse-down at "from", moves to "to", then mouse-up.
    `,
  )
  .option('--duration [duration]', z.number().describe('Duration of the drag in milliseconds'))
  .example('# Drag from one position to another')
  .example('usecomputer drag 100,200 500,200')
  .example('# Drag an accessibility element')
  .example('usecomputer drag @e3 400,600')
  .action((from, to, options) => {
    console.log('not implemented')
  })

cli
  .command(
    'hover <target>',
    dedent`
      Move the mouse to a target without clicking.

      Target can be coordinates (x,y) or an accessibility ref (@e1).
    `,
  )
  .example('usecomputer hover 500,300')
  .example('usecomputer hover @e4')
  .action((target) => {
    console.log('not implemented')
  })

// ─── Mouse Commands ─────────────────────────────────────────────────────

cli
  .command('mouse move <x> <y>', 'Move mouse cursor to absolute screen coordinates.')
  .action((x, y) => {
    console.log('not implemented')
  })

cli
  .command('mouse down', 'Press and hold mouse button.')
  .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
  .action((options) => {
    console.log('not implemented')
  })

cli
  .command('mouse up', 'Release mouse button.')
  .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
  .action((options) => {
    console.log('not implemented')
  })

cli
  .command('mouse position', 'Print the current mouse cursor position as x,y.')
  .action(() => {
    console.log('not implemented')
  })

// ─── Get Info Commands ──────────────────────────────────────────────────

cli
  .command(
    'get text <target>',
    'Get the accessible text content of an element. Target is an accessibility ref (@e1) or coordinates.',
  )
  .action((target) => {
    console.log('not implemented')
  })

cli
  .command(
    'get title <target>',
    'Get the title/name of a window or element. Target is a ref, coordinates, or window ID.',
  )
  .action((target) => {
    console.log('not implemented')
  })

cli
  .command(
    'get value <target>',
    'Get the current value of an input element (text fields, sliders, checkboxes).',
  )
  .action((target) => {
    console.log('not implemented')
  })

cli
  .command(
    'get bounds <target>',
    'Get the bounding rectangle (x, y, width, height) of an element or window.',
  )
  .action((target) => {
    console.log('not implemented')
  })

cli
  .command(
    'get focused',
    'Get the currently focused element and its accessibility info.',
  )
  .action(() => {
    console.log('not implemented')
  })

// ─── Window Management ─────────────────────────────────────────────────

cli
  .command(
    'window list',
    'List all open windows with their titles, apps, positions, and sizes.',
  )
  .option('--app [app]', z.string().describe('Filter by application name'))
  .option('--json', 'Output as JSON')
  .action((options) => {
    console.log('not implemented')
  })

cli
  .command(
    'window focus <target>',
    'Bring a window to the foreground. Target is a window title, ID, or app name.',
  )
  .action((target) => {
    console.log('not implemented')
  })

cli
  .command(
    'window resize <target> <width> <height>',
    'Resize a window. Target is a window title, ID, or app name.',
  )
  .action((target, width, height) => {
    console.log('not implemented')
  })

cli
  .command(
    'window move <target> <x> <y>',
    'Move a window to absolute screen coordinates.',
  )
  .action((target, x, y) => {
    console.log('not implemented')
  })

cli
  .command(
    'window minimize <target>',
    'Minimize a window.',
  )
  .action((target) => {
    console.log('not implemented')
  })

cli
  .command(
    'window maximize <target>',
    'Maximize/fullscreen a window.',
  )
  .action((target) => {
    console.log('not implemented')
  })

cli
  .command(
    'window close <target>',
    'Close a window.',
  )
  .action((target) => {
    console.log('not implemented')
  })

// ─── App Management ────────────────────────────────────────────────────

cli
  .command(
    'app list',
    'List all running applications with their process IDs and window counts.',
  )
  .option('--json', 'Output as JSON')
  .action((options) => {
    console.log('not implemented')
  })

cli
  .command(
    'app launch <name>',
    dedent`
      Launch an application by name or path.

      On macOS: app name ("Safari"), bundle ID ("com.apple.Safari"), or path.
      On Linux: executable name or .desktop file.
      On Windows: executable name or Start Menu shortcut.
    `,
  )
  .option('--wait', 'Wait for the application window to appear before returning')
  .action((name, options) => {
    console.log('not implemented')
  })

cli
  .command(
    'app quit <name>',
    'Quit an application gracefully by name or process ID.',
  )
  .option('--force', 'Force-kill the application if it does not quit gracefully')
  .action((name, options) => {
    console.log('not implemented')
  })

// ─── Clipboard ──────────────────────────────────────────────────────────

cli
  .command(
    'clipboard get',
    'Print the current clipboard text content.',
  )
  .action(() => {
    console.log('not implemented')
  })

cli
  .command(
    'clipboard set <text>',
    'Set the clipboard content to the given text.',
  )
  .action((text) => {
    console.log('not implemented')
  })

// ─── Wait ───────────────────────────────────────────────────────────────

cli
  .command(
    'wait <target>',
    dedent`
      Wait for a condition before continuing.

      Target can be:
      - Milliseconds: "2000" (wait 2 seconds)
      - Accessibility ref: "@e5" (wait for element to appear)
      - Window title: "--window Untitled" (wait for window to appear)
    `,
  )
  .option('-w, --window [window]', z.string().describe('Wait for a window with this title to appear'))
  .option('--timeout [timeout]', z.number().default(30000).describe('Maximum wait time in milliseconds'))
  .example('# Wait 2 seconds')
  .example('usecomputer wait 2000')
  .example('# Wait for an element to appear')
  .example('usecomputer wait @e5')
  .example('# Wait for a window to appear')
  .example('usecomputer wait --window "Save As"')
  .action((target, options) => {
    console.log('not implemented')
  })

// ─── Display ────────────────────────────────────────────────────────────

cli
  .command(
    'display list',
    'List connected displays with their resolutions, positions, and scale factors.',
  )
  .option('--json', 'Output as JSON')
  .action((options) => {
    console.log('not implemented')
  })

// ─── Find Elements ──────────────────────────────────────────────────────

cli
  .command(
    'find <query>',
    dedent`
      Search for UI elements matching a text query across the accessibility tree.

      Returns matching elements with their refs, roles, and positions.
      Useful for locating elements before clicking or typing.
    `,
  )
  .option('-w, --window [window]', z.string().describe('Scope search to a specific window'))
  .option('-a, --app [app]', z.string().describe('Scope search to a specific application'))
  .option('--role [role]', z.string().describe('Filter by accessibility role (button, textField, link, etc.)'))
  .option('--limit [limit]', z.number().default(20).describe('Maximum number of results'))
  .example('# Find all buttons with "Save" in the name')
  .example('usecomputer find "Save" --role button')
  .example('# Find elements in a specific app')
  .example('usecomputer find "File" --app "Visual Studio Code"')
  .action((query, options) => {
    console.log('not implemented')
  })

// ─── Diff ───────────────────────────────────────────────────────────────

cli
  .command(
    'diff snapshot',
    'Compare the current accessibility snapshot against the previous one. Shows added, removed, and changed elements.',
  )
  .option('-w, --window [window]', z.string().describe('Scope to a specific window'))
  .option('-a, --app [app]', z.string().describe('Scope to a specific application'))
  .action((options) => {
    console.log('not implemented')
  })

cli
  .command(
    'diff screenshot',
    'Compare the current screenshot against a baseline image. Highlights visual differences.',
  )
  .option('--baseline <baseline>', z.string().describe('Path to the baseline screenshot'))
  .option('--threshold [threshold]', z.number().default(0.1).describe('Pixel difference threshold (0-1)'))
  .action((options) => {
    console.log('not implemented')
  })

// ─── Global Options ─────────────────────────────────────────────────────

cli.option('--json', 'Output as JSON')
cli.option('--display [display]', z.number().describe('Target display/monitor index for multi-monitor setups'))
cli.option('--timeout [timeout]', z.number().default(25000).describe('Default timeout for operations in milliseconds'))
cli.option('--debug', 'Enable debug output')

cli.help()
cli.version(pkg.version)
cli.parse()
