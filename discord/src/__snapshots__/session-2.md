# find oxc linter repo. is it possible to create custom rules? how?

## Conversation

### 👤 User

find oxc linter repo. is it possible to create custom rules? how?

[Current branch: main]


### 🤖 Assistant (gpt-5.2-codex)

**Started using openai/gpt-5.2-codex**

#### 🛠️ Tool: websearch

**Input:**
```yaml
query: oxc linter custom rules create custom rule plugin
numResults: 8
livecrawl: preferred
type: auto

```

**Output:**
```
Title: Adding Linter Rules | The JavaScript Oxidation Compiler - Oxc
Author: 
URL: https://oxc.rs/docs/contribute/linter/adding-rules
Text: Adding Linter Rules | The JavaScript Oxidation Compiler
[![] 
Announcing Type-Aware Linting Alpha
] 
[Skip to content] 
[![Oxc]![Oxc]] 
Search
Appearance
[] [] [] [] 
[] [] [] [] 
Menu
Return to top
Are you an LLM? You can read better optimized documentation at /docs/contribute/linter/adding-rules.md for this page in Markdown format
# Adding Linter Rules[​] 
The best and easiest way to contribute to Oxlint is by adding new linter rules.
This guide will walk you through this process, using ESLint&#39;s[`no-debugger`] rule as an example.
TIP
Make sure you&#39;ve read the[setup instructions] first.
## Step 1: Pick a Rule[​] 
Our[Linter product plan and progress] issue tracks the status of all rules we want to implement from existing ESLint plugins. From there, pick a plugin that looks interesting to you and find a rule that has not been implemented.
**Important**: Since ESLint-compatible JavaScript plugin support is now available, we do not plan to add new Rust-based plugins. However, contributions that add rules to existing plugins are**highly encouraged**. If you think a rule or plugin would 

Title: JS Plugins | The JavaScript Oxidation Compiler - Oxc
Author: 
URL: https://oxc.rs/docs/guide/usage/linter/js-plugins
Text: JS Plugins | The JavaScript Oxidation Compiler
[![] 
Announcing Type-Aware Linting Alpha
] 
[Skip to content] 
[![Oxc]![Oxc]] 
Search
Appearance
[] [] [] [] 
[] [] [] [] 
Menu
Return to top
Are you an LLM? You can read better optimized documentation at /docs/guide/usage/linter/js-plugins.md for this page in Markdown format
# JS Plugins[​] 
Oxlint supports plugins written in JS - either custom-written, or from NPM.
Oxlint&#39;s plugin API is compatible with ESLint v9+, so most existing ESLint plugins should work out of the box with Oxlint.
We are working towards implementing*all*of ESLint&#39;s plugin APIs, and Oxlint will soon be able to run*any*ESLint plugin.
WARNING
JS plugins are currently in technical preview, and remain under heavy development. Almost all of ESLint&#39;s plugin API is implemented (see[below]).
All APIs should behave identically to ESLint. If you find any differences in behavior, that&#39;s a bug - please[report it].
## Using JS plugins[​] 
1. Add a path to the plugin to the`.oxlintrc.json`config file, under`jsPlugins`.
2. Add rules from the plugin, under`rules`.
The path can be a

Title: ️ Oxlint Custom JavaScript Plugin Milestone 1 · Issue #9905 - GitHub
Author: oxc-project
Published Date: 2025-03-19T00:00:00.000Z
URL: https://github.com/oxc-project/oxc/issues/9905
Text: ☂️ Oxlint Custom JavaScript Plugin Milestone 1 ·Issue #9905 ·oxc-project/oxc ·GitHub
[Skip to content] 
## Navigation Menu
Toggle navigation
[] 
[Sign in] 
Appearance settings
Search or jump to...
# Search code, repositories, users, issues, pull requests...
 
Search
Clear
[Search syntax tips] 
# Provide feedback
 
We read every piece of feedback, and take your input very seriously.
Include my email address so I can be contacted
CancelSubmit feedback
# Saved searches
## Use saved searches to filter your results more quickly
 
Name
Query
To see all available qualifiers, see our[documentation].
CancelCreate saved search
[Sign in] 
[Sign up] 
Appearance settings
Resetting focus
You signed in with another tab or window.[Reload] to refresh your session.You signed out in another tab or window.[Reload] to refresh your session.You switched accounts on another tab or window.[Reload] to refresh your session.Dismiss alert
{{ message }}
[oxc-project] /**[oxc] **Public
* ### Uh oh!
There was an error while loading.[Please reload this page].
* [Notific

Title: Announcing Oxlint 1.0 - VoidZero
Published Date: 2025-06-09T00:00:00.000Z
URL: https://voidzero.dev/posts/announcing-oxlint-1-stable
Text: Announcing Oxlint 1.0 | VoidZero
[] 
[124.5k] [Explore Vite+] 
// announcements# Announcing Oxlint 1.0
JUN 10, 2025
![Announcing Oxlint 1.0] 
![Boshen Chen]![Cameron Clark] 
![Boshen Chen]![Cameron Clark] 
Boshen Chen and Cameron Clark
5 MIN READ
Copy Link
TL;DR: The first stable version Oxlint has been released! With a[50\~100x] performance improvement over ESLint, support for over 500 ESLint rules, and[usage in major companies] like Shopify, Airbnb, and Mercedes-Benz, you should give it a try.[Get started now].
Oxlint is a Rust-powered linter for JavaScript and TypeScript is designed to be fast and simple to adopt. Since its first announcement back in December 2023, Oxlint has undergone significant improvements and is now shipping its first stable version, 1.0. In addition to the stable release, we also want to announce that Oxlint has a dedicated full-time maintainer,[Cameron], and a growing core team working on maintaining and improving the linter.
## Real-World Impact[​] 
We are extremely proud of the performance of Oxlint and its impact on real, large-scale codebases, which has l

Title: Adding Linter Rules
Author: 
Published Date: 2025-08-17T00:00:00.000Z
URL: https://oxc-project.github.io/docs/contribute/linter/adding-rules.html
Text: Adding Linter Rules | The JavaScript Oxidation Compiler
[![] 
Announcing Type-Aware Linting Alpha
] 
[Skip to content] 
[![Oxc]![Oxc]] 
Search
Appearance
[] [] [] [] 
[] [] [] [] 
Menu
Return to top
Are you an LLM? You can read better optimized documentation at /docs/contribute/linter/adding-rules.md for this page in Markdown format
# Adding Linter Rules[​] 
The best and easiest way to contribute to Oxlint is by adding new linter rules.
This guide will walk you through this process, using ESLint&#39;s[`no-debugger`] rule as an example.
TIP
Make sure you&#39;ve read the[setup instructions] first.
## Step 1: Pick a Rule[​] 
Our[Linter product plan and progress] issue tracks the status of all rules we want to implement from existing ESLint plugins. From there, pick a plugin that looks interesting to you and find a rule that has not been implemented.
**Important**: Since ESLint-compatible JavaScript plugin support is now available, we do not plan to add new Rust-based plugins. However, contributions that add rules to existing plugins are**highly encouraged**. If you think a ru

Title: Plugins
Author: 
Published Date: 2025-08-17T00:00:00.000Z
URL: https://oxc-project.github.io/docs/guide/usage/linter/plugins.html
Text: Built-in Plugins | The JavaScript Oxidation Compiler
[![] 
Announcing Type-Aware Linting Alpha
] 
[Skip to content] 
[![Oxc]![Oxc]] 
Search
Appearance
[] [] [] [] 
[] [] [] [] 
Menu
Return to top
Are you an LLM? You can read better optimized documentation at /docs/guide/usage/linter/plugins.md for this page in Markdown format
# Built-in Plugins[​] 
Oxlint includes built-in implementations of many popular ESLint plugin rule sets. Most rules in the`recommended`configs are already implemented, so you can get useful results without extra setup.
Oxlint also supports plugins written in JavaScript with an ESLint-compatible API. See[JS Plugins].
## What a plugin means in Oxlint[​] 
A plugin is a named group of rules. Enabling a plugin makes its rules available, and category flags control which rules are enabled and at what severity.
If you are migrating from ESLint, plugins map to the ecosystems you already know, such as import, react, jsx-a11y, jest, unicorn, and more.
## Enable a plugin[​] 
It is**strongly recommended**to use a config file to enable plugins, as it makes it considerably easier t

Title: Configuring Oxlint
Author: 
Published Date: 2025-08-17T00:00:00.000Z
URL: https://oxc-project.github.io/docs/guide/usage/linter/config.html
Text: Configuration | The JavaScript Oxidation Compiler
[![] 
Announcing Type-Aware Linting Alpha
] 
[Skip to content] 
[![Oxc]![Oxc]] 
Search
Appearance
[] [] [] [] 
[] [] [] [] 
Menu
Return to top
Are you an LLM? You can read better optimized documentation at /docs/guide/usage/linter/config.md for this page in Markdown format
# Configuration[​] 
Oxlint works out of the box, but most teams commit a configuration file to keep linting consistent across local runs, editors, and CI.
This page focuses on project configuration: rules, categories, plugins, overrides, and shared settings.
## Create a config file[​] 
To generate a starter config in the current directory:
sh
```
`oxlint--init`
```
Oxlint automatically looks for a`.oxlintrc.json`in the current working directory. You can also pass a config explicitly (note that this will disable nested config lookup):
sh
```
`oxlint-c./oxlintrc.json# oroxlint--config./oxlintrc.json`
```
Notes:
* Only`.json`config files are supported, but oxlint configuration files support comments (like jsonc).
* The configuration format aims to be compatible wi

Title: Oxlint JS Plugins Preview
Author: overlookmotel Core
Published Date: 2025-10-09T00:00:00.000Z
URL: https://oxc.rs/blog/2025-10-09-oxlint-js-plugins
Text: Oxlint JS Plugins Preview | The JavaScript Oxidation Compiler
[![] 
Announcing Type-Aware Linting Alpha
] 
[Skip to content] 
[![Oxc]![Oxc]] 
Search
Appearance
[] [] [] [] 
[] [] [] [] 
Menu
Return to top
# Oxlint JS Plugins Preview
* ![overlookmotel] 
[overlookmotel] Core
* ![Cameron] 
[Cameron] Core
Earlier this year[we asked for input from the community] to inform design for Oxlint support for custom JS plugins. Today, we are pleased to announce the result of many months of research, prototyping, and finally building:
**Oxlint supports plugins written in JS!**
#### Key features[​] 
* ESLint-compatible plugin API. Oxlint will be able to run many existing ESLint plugins without modification.
* An alternative API which is slightly different, and unlocks better performance.#### What this is and isn&#39;t[​] 
This preview release is just the beginning. It is important to note that:
* This initial release does not implement all of ESLint&#39;s plugin API.
* Performance is good, but it&#39;s going to get*way*better - we have many optimizations in the pipeline.
The most commo


```


*Completed in 5.1s*

### 🤖 Assistant (gpt-5.2-codex)

**Started using openai/gpt-5.2-codex**

Oxc linter repo: https://github.com/oxc-project/oxc

Yes, you can create custom rules. Two paths:
- JavaScript plugins (recommended for custom rules): Oxlint supports ESLint v9-compatible JS plugins in technical preview. You ship a JS plugin and point `jsPlugins` in `.oxlintrc.json`, then enable the rules under `rules`. Docs: https://oxc.rs/docs/guide/usage/linter/js-plugins
- Rust rules inside Oxc repo (contributing upstream): You add rules to existing built-in plugins. New Rust plugins aren’t planned; they want rules added to existing plugins. Docs: https://oxc.rs/docs/contribute/linter/adding-rules

Minimal JS plugin setup (outline):
1) Create an ESLint-style plugin module exporting `rules`.
2) In `.oxlintrc.json`:
```json
{
  "jsPlugins": ["./path/to/my-plugin.js"],
  "rules": {
    "my-plugin/my-rule": "error"
  }
}
```
3) Run `oxlint`.

Want me to draft a skeleton JS plugin rule file tailored to your use case?


*Completed in 7.9s*
