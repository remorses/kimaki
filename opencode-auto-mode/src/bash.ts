// Walk an unbash AST into executable command leaves.
// Used by skip and hard-deny. Parse errors never skip.

import path from 'node:path'
import {
  parse,
  type Node,
  type ParsedScript,
  type Redirect,
  type Word,
  type WordPart,
} from 'unbash'

const MAX_SOURCE_LENGTH = 1024 * 1024
const MAX_NESTED_SHELL_DEPTH = 16
const TRANSPARENT = new Set(['command', 'exec', 'env'])
const NESTED_SHELLS = new Set(['bash', 'sh'])
const FILE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '<', '<<', '<<-', '<<<'])

export type AnalyzedCommand = {
  name?: string
  args: string[]
  dynamicName: boolean
  unresolved: boolean
}

export type BashAnalysis = {
  commands: AnalyzedCommand[]
  hasFileRedirect: boolean
  hasCommandSubstitution: boolean
  errors: string[]
}

function commandName(value: string | undefined) {
  if (!value) return undefined
  return path.basename(value).toLowerCase()
}

function wordParts(word: Word) {
  return word.parts ?? []
}

function partIsStatic(part: WordPart): boolean {
  if (part.type === 'Literal' || part.type === 'SingleQuoted' || part.type === 'AnsiCQuoted') {
    return true
  }
  if (part.type === 'DoubleQuoted') {
    return part.parts.every((child) => child.type === 'Literal')
  }
  return false
}

function wordIsStatic(word: Word) {
  const parts = wordParts(word)
  if (parts.length === 0) return true
  return parts.every(partIsStatic)
}

function unwrapTransparent(name: string | undefined, argumentWords: Word[]) {
  if (!name || !TRANSPARENT.has(name)) {
    return { name, argumentWords, unresolved: false }
  }
  let index = 0
  let optionsEnded = false
  while (index < argumentWords.length) {
    const word = argumentWords[index]
    if (!word || !wordIsStatic(word)) {
      return { name: undefined, argumentWords: [] as Word[], unresolved: true }
    }
    const value = word.value
    if (!optionsEnded && value === '--') {
      optionsEnded = true
      index += 1
      continue
    }
    if (name === 'env') {
      if (!optionsEnded && value.startsWith('-')) {
        return { name: undefined, argumentWords: [] as Word[], unresolved: true }
      }
      if (/^[^=]+=/.test(value)) {
        index += 1
        continue
      }
    }
    if ((name === 'command' || name === 'exec') && !optionsEnded && value.startsWith('-')) {
      index += 1
      continue
    }
    return {
      name: commandName(value),
      argumentWords: argumentWords.slice(index + 1),
      unresolved: false,
    }
  }
  return { name: undefined, argumentWords: [] as Word[], unresolved: true }
}

function effectiveInvocation(name: string | undefined, argumentWords: Word[]) {
  let invocation = { name, argumentWords, unresolved: false }
  for (let depth = 0; depth < MAX_NESTED_SHELL_DEPTH; depth += 1) {
    const next = unwrapTransparent(invocation.name, invocation.argumentWords)
    if (next.unresolved) return next
    if (next.name === invocation.name && next.argumentWords === invocation.argumentWords) {
      return next
    }
    invocation = next
  }
  return { name: undefined, argumentWords: [] as Word[], unresolved: true }
}

function nestedShellSource(name: string | undefined, argumentWords: Word[]) {
  if (name === 'eval') {
    if (argumentWords.length === 0 || !argumentWords.every(wordIsStatic)) return undefined
    return argumentWords.map((word) => word.value).join(' ')
  }
  if (!name || !NESTED_SHELLS.has(name)) return undefined
  const commandOptionIndex = argumentWords.findIndex((word) => /^-[^-]*c/.test(word.value))
  if (commandOptionIndex < 0) return undefined
  const scriptWord = argumentWords[commandOptionIndex + 1]
  if (!scriptWord || !wordIsStatic(scriptWord)) return undefined
  return scriptWord.value
}

function isFileRedirect(redirect: Redirect) {
  return FILE_REDIRECTS.has(redirect.operator)
}

export function analyzeBash(source: string): BashAnalysis {
  const analysis: BashAnalysis = {
    commands: [],
    hasFileRedirect: false,
    hasCommandSubstitution: false,
    errors: [],
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    analysis.errors.push(`Bash input length ${source.length} exceeds ${MAX_SOURCE_LENGTH}`)
    return analysis
  }

  function visitPart(part: WordPart, depth: number) {
    if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
      for (const child of part.parts) visitPart(child, depth)
      return
    }
    if (part.type === 'CommandExpansion' || part.type === 'ProcessSubstitution') {
      analysis.hasCommandSubstitution = true
      if (part.script) visitScript(part.script, depth)
    }
  }

  function visitWord(word: Word, depth: number) {
    for (const part of wordParts(word)) visitPart(part, depth)
  }

  function visitRedirects(redirects: Redirect[]) {
    for (const redirect of redirects) {
      if (isFileRedirect(redirect)) analysis.hasFileRedirect = true
      if (redirect.target) visitWord(redirect.target, 0)
    }
  }

  function visitNode(node: Node, depth: number) {
    switch (node.type) {
      case 'Command': {
        visitRedirects(node.redirects)
        if (node.name) visitWord(node.name, depth)
        for (const word of node.suffix) visitWord(word, depth)
        const normalizedName = commandName(node.name?.value)
        const invocation = effectiveInvocation(normalizedName, node.suffix)
        const wrapperSource = nestedShellSource(invocation.name, invocation.argumentWords)
        if (wrapperSource !== undefined) {
          if (depth >= MAX_NESTED_SHELL_DEPTH) {
            analysis.errors.push(`Nested shell depth exceeds ${MAX_NESTED_SHELL_DEPTH}`)
            return
          }
          const nested = parse(wrapperSource)
          visitScript(nested, depth + 1)
          return
        }
        analysis.commands.push({
          name: invocation.name,
          args: invocation.argumentWords.map((word) => word.value),
          dynamicName: !!node.name && !wordIsStatic(node.name),
          unresolved: invocation.unresolved,
        })
        return
      }
      case 'Pipeline':
      case 'AndOr':
        for (const command of node.commands) visitNode(command, depth)
        return
      case 'If':
        visitNode(node.clause, depth)
        visitNode(node.then, depth)
        if (node.else) visitNode(node.else, depth)
        return
      case 'For':
      case 'Select':
        visitNode(node.body, depth)
        return
      case 'ArithmeticFor':
      case 'While':
        visitNode(node.body, depth)
        return
      case 'Function':
      case 'Subshell':
      case 'BraceGroup':
      case 'Coproc':
        visitNode(node.body, depth)
        return
      case 'CompoundList':
        for (const statement of node.commands) visitNode(statement, depth)
        return
      case 'Case':
        for (const item of node.items) visitNode(item.body, depth)
        return
      case 'Statement':
        visitRedirects(node.redirects)
        visitNode(node.command, depth)
        return
      case 'TestCommand':
      case 'ArithmeticCommand':
        return
    }
  }

  function visitScript(script: ParsedScript, depth: number) {
    for (const error of script.errors ?? []) analysis.errors.push(error.message)
    for (const statement of script.commands) visitNode(statement, depth)
  }

  const parsed = parse(source)
  visitScript(parsed, 0)
  return analysis
}
