// Walk an unbash AST into executable command leaves.
// Parse errors and unsupported nodes never skip.

import path from 'node:path'
import {
  parse,
  type ArithmeticExpression,
  type Node,
  type ParsedScript,
  type Redirect,
  type TestExpression,
  type Word,
  type WordPart,
} from 'unbash'

const MAX_SOURCE_LENGTH = 1024 * 1024
const MAX_NESTED_SHELL_DEPTH = 16
const TRANSPARENT = new Set(['command', 'exec', 'env'])
const NESTED_SHELLS = new Set(['bash', 'sh'])
const EXEC_WRAPPERS = new Set(['sudo', 'doas', 'nice', 'nohup', 'timeout', 'ionice', 'stdbuf'])
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])

export type AnalyzedRedirect = {
  operator: Redirect['operator']
  target?: string
  targetText?: string
  targetDynamic: boolean
  tildeExpansion: boolean
}

export type AnalyzedCommand = {
  name?: string
  nameText?: string
  args: string[]
  argTexts: string[]
  argTildeExpansions: boolean[]
  dynamicName: boolean
  unresolved: boolean
  pathQualified: boolean
  envMutatesPath: boolean
}

export type AnalyzedPipeline = {
  commands: AnalyzedCommand[]
}

export type BashAnalysis = {
  commands: AnalyzedCommand[]
  pipelines: AnalyzedPipeline[]
  redirects: AnalyzedRedirect[]
  hasFileRedirect: boolean
  hasCommandSubstitution: boolean
  hasDynamicContent: boolean
  structureSafe: boolean
  errors: string[]
}

function commandName(value: string | undefined) {
  if (!value) return undefined
  return path.basename(value).toLowerCase()
}

function isPathQualified(value: string | undefined) {
  if (!value) return false
  return value.includes('/') || value.includes('\\')
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

function wordHasTildeExpansion(word: Word) {
  if (!word.text.startsWith('~')) return false
  for (const character of word.text.slice(1)) {
    if (character === '/') return true
    if (['\\', "'", '"', '$', '`'].includes(character)) return false
  }
  return true
}

function envAssignmentName(value: string) {
  const equals = value.indexOf('=')
  if (equals <= 0) return undefined
  return value.slice(0, equals)
}

function unwrapTransparent(name: string | undefined, argumentWords: Word[]) {
  if (!name || !TRANSPARENT.has(name)) {
    return { name, argumentWords, unresolved: false, envMutatesPath: false }
  }
  let index = 0
  let optionsEnded = false
  let envMutatesPath = false
  while (index < argumentWords.length) {
    const word = argumentWords[index]
    if (!word || !wordIsStatic(word)) {
      return { name: undefined, argumentWords: [] as Word[], unresolved: true, envMutatesPath }
    }
    const value = word.value
    if (!optionsEnded && value === '--') {
      optionsEnded = true
      index += 1
      continue
    }
    if (name === 'env') {
      if (!optionsEnded && value.startsWith('-')) {
        return { name: undefined, argumentWords: [] as Word[], unresolved: true, envMutatesPath }
      }
      const assignment = envAssignmentName(value)
      if (assignment) {
        envMutatesPath = true
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
      nameText: value,
      argumentWords: argumentWords.slice(index + 1),
      unresolved: false,
      envMutatesPath,
      pathQualified: isPathQualified(value),
    }
  }
  return { name: undefined, argumentWords: [] as Word[], unresolved: true, envMutatesPath }
}

function unwrapExecutionWrapper(name: string | undefined, argumentWords: Word[]) {
  if (!name || !EXEC_WRAPPERS.has(name)) {
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
    if (!optionsEnded && value.startsWith('-')) {
      if (name === 'timeout' && !value.startsWith('--')) {
        index += 1
        continue
      }
      if (['-n', '-u', '-g', '-p', '-E', '-H', '-S'].includes(value) || value.startsWith('--')) {
        const takesValue = ['-u', '-g', '-p', '-C', '--user', '--group', '--prompt'].includes(value)
        index += takesValue ? 2 : 1
        continue
      }
      index += 1
      continue
    }
    if (name === 'timeout' && /^\d/.test(value)) {
      index += 1
      continue
    }
    return {
      name: commandName(value),
      nameText: value,
      argumentWords: argumentWords.slice(index + 1),
      unresolved: false,
      pathQualified: isPathQualified(value),
    }
  }
  return { name: undefined, argumentWords: [] as Word[], unresolved: true }
}

function effectiveInvocation(name: string | undefined, argumentWords: Word[]) {
  let invocation = {
    name,
    nameText: name,
    argumentWords,
    unresolved: false,
    envMutatesPath: false,
    pathQualified: isPathQualified(name),
  }
  for (let depth = 0; depth < MAX_NESTED_SHELL_DEPTH; depth += 1) {
    const transparent = unwrapTransparent(invocation.name, invocation.argumentWords)
    const wrapped = unwrapExecutionWrapper(transparent.name, transparent.argumentWords)
    const next = {
      name: wrapped.name,
      nameText: 'nameText' in wrapped ? wrapped.nameText : wrapped.name,
      argumentWords: wrapped.argumentWords,
      unresolved: transparent.unresolved || wrapped.unresolved,
      envMutatesPath: transparent.envMutatesPath || invocation.envMutatesPath,
      pathQualified:
        ('pathQualified' in wrapped ? wrapped.pathQualified : false) ||
        ('pathQualified' in transparent ? transparent.pathQualified : false) ||
        invocation.pathQualified,
    }
    if (next.unresolved) return next
    if (next.name === invocation.name && next.argumentWords === invocation.argumentWords) {
      return next
    }
    invocation = next
  }
  return {
    name: undefined,
    nameText: undefined,
    argumentWords: [] as Word[],
    unresolved: true,
    envMutatesPath: true,
    pathQualified: false,
  }
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

function exhaustiveNode(node: never): never {
  throw new Error(`Unsupported unbash AST node: ${JSON.stringify(node)}`)
}

function exhaustivePart(part: never): never {
  throw new Error(`Unsupported unbash word part: ${JSON.stringify(part)}`)
}

export function analyzeBash(source: string): BashAnalysis {
  const analysis: BashAnalysis = {
    commands: [],
    pipelines: [],
    redirects: [],
    hasFileRedirect: false,
    hasCommandSubstitution: false,
    hasDynamicContent: false,
    structureSafe: true,
    errors: [],
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    analysis.errors.push(`Bash input length ${source.length} exceeds ${MAX_SOURCE_LENGTH}`)
    return analysis
  }

  function visitPart(part: WordPart, depth: number) {
    switch (part.type) {
      case 'Literal':
      case 'SingleQuoted':
      case 'AnsiCQuoted':
      case 'SimpleExpansion':
        if (part.type === 'SimpleExpansion') analysis.hasDynamicContent = true
        return
      case 'DoubleQuoted':
      case 'LocaleString':
        for (const child of part.parts) visitPart(child, depth)
        return
      case 'ParameterExpansion':
        analysis.hasDynamicContent = true
        for (const indexPart of part.indexParts ?? []) visitPart(indexPart, depth)
        if (part.operand) visitWord(part.operand, depth)
        if (part.slice) {
          visitWord(part.slice.offset, depth)
          if (part.slice.length) visitWord(part.slice.length, depth)
        }
        if (part.replace) {
          visitWord(part.replace.pattern, depth)
          visitWord(part.replace.replacement, depth)
        }
        return
      case 'CommandExpansion':
      case 'ProcessSubstitution':
        analysis.hasCommandSubstitution = true
        analysis.hasDynamicContent = true
        analysis.structureSafe = false
        if (part.script) visitScript(part.script, depth)
        return
      case 'ArithmeticExpansion':
        analysis.hasDynamicContent = true
        if (part.expression) visitArithmetic(part.expression, depth)
        return
      case 'ExtendedGlob':
      case 'BraceExpansion':
        analysis.hasDynamicContent = true
        for (const nested of part.parts ?? []) visitPart(nested, depth)
        return
      default:
        exhaustivePart(part)
    }
  }

  function visitWord(word: Word, depth: number) {
    if (!wordIsStatic(word)) analysis.hasDynamicContent = true
    for (const part of wordParts(word)) visitPart(part, depth)
  }

  function visitRedirect(redirect: Redirect, depth: number) {
    const analyzed: AnalyzedRedirect = {
      operator: redirect.operator,
      target: redirect.target?.value,
      targetText: redirect.target?.text,
      targetDynamic: !!redirect.target && !wordIsStatic(redirect.target),
      tildeExpansion: redirect.target ? wordHasTildeExpansion(redirect.target) : false,
    }
    analysis.redirects.push(analyzed)
    if (OUTPUT_REDIRECTS.has(redirect.operator)) analysis.hasFileRedirect = true
    if (redirect.target) visitWord(redirect.target, depth)
    if (redirect.body) visitWord(redirect.body, depth)
  }

  function visitArithmetic(expression: ArithmeticExpression, depth: number) {
    switch (expression.type) {
      case 'ArithmeticBinary':
        visitArithmetic(expression.left, depth)
        visitArithmetic(expression.right, depth)
        return
      case 'ArithmeticUnary':
        visitArithmetic(expression.operand, depth)
        return
      case 'ArithmeticTernary':
        visitArithmetic(expression.test, depth)
        visitArithmetic(expression.consequent, depth)
        visitArithmetic(expression.alternate, depth)
        return
      case 'ArithmeticGroup':
        visitArithmetic(expression.expression, depth)
        return
      case 'ArithmeticWord':
        for (const part of expression.parts ?? []) visitPart(part, depth)
        return
      case 'ArithmeticCommandExpansion':
        analysis.hasCommandSubstitution = true
        analysis.hasDynamicContent = true
        analysis.structureSafe = false
        if (expression.script) visitScript(expression.script, depth)
        return
    }
  }

  function visitTest(expression: TestExpression, depth: number) {
    switch (expression.type) {
      case 'TestUnary':
        visitWord(expression.operand, depth)
        return
      case 'TestBinary':
        visitWord(expression.left, depth)
        visitWord(expression.right, depth)
        return
      case 'TestLogical':
        visitTest(expression.left, depth)
        visitTest(expression.right, depth)
        return
      case 'TestNot':
        visitTest(expression.operand, depth)
        return
      case 'TestGroup':
        visitTest(expression.expression, depth)
        return
    }
  }

  function pushCommand(command: AnalyzedCommand, pipeline: AnalyzedCommand[]) {
    analysis.commands.push(command)
    pipeline.push(command)
  }

  function visitNode(node: Node, depth: number, pipeline: AnalyzedCommand[]) {
    switch (node.type) {
      case 'Command': {
        for (const redirect of node.redirects) visitRedirect(redirect, depth)
        if (node.prefix.length > 0) analysis.hasDynamicContent = true
        for (const prefix of node.prefix) {
          if (prefix.value) visitWord(prefix.value, depth)
          for (const word of prefix.array ?? []) visitWord(word, depth)
          for (const part of prefix.indexParts ?? []) visitPart(part, depth)
        }
        if (node.name) visitWord(node.name, depth)
        for (const word of node.suffix) visitWord(word, depth)
        const rawName = node.name?.value
        const invocation = effectiveInvocation(commandName(rawName), node.suffix)
        const wrapperSource = nestedShellSource(invocation.name, invocation.argumentWords)
        if (wrapperSource !== undefined) {
          if (depth >= MAX_NESTED_SHELL_DEPTH) {
            analysis.errors.push(`Nested shell depth exceeds ${MAX_NESTED_SHELL_DEPTH}`)
            return
          }
          visitScript(parse(wrapperSource), depth + 1)
          return
        }
        pushCommand(
          {
            name: invocation.name,
            nameText: invocation.nameText ?? rawName,
            args: invocation.argumentWords.map((word) => word.value),
            argTexts: invocation.argumentWords.map((word) => word.text),
            argTildeExpansions: invocation.argumentWords.map(wordHasTildeExpansion),
            dynamicName: !!node.name && !wordIsStatic(node.name),
            unresolved: invocation.unresolved,
            pathQualified: invocation.pathQualified || isPathQualified(rawName),
            envMutatesPath: invocation.envMutatesPath,
          },
          pipeline,
        )
        return
      }
      case 'Pipeline': {
        const nested: AnalyzedCommand[] = []
        for (const command of node.commands) visitNode(command, depth, nested)
        analysis.pipelines.push({ commands: nested })
        return
      }
      case 'AndOr':
        for (const command of node.commands) {
          const nested: AnalyzedCommand[] = []
          visitNode(command, depth, nested)
          if (nested.length > 0) analysis.pipelines.push({ commands: nested })
        }
        return
      case 'If':
        visitNode(node.clause, depth, [])
        visitNode(node.then, depth, [])
        if (node.else) visitNode(node.else, depth, [])
        return
      case 'For':
      case 'Select':
        analysis.structureSafe = false
        visitWord(node.name, depth)
        for (const word of node.wordlist) visitWord(word, depth)
        visitNode(node.body, depth, [])
        return
      case 'ArithmeticFor':
        analysis.structureSafe = false
        if (node.initialize) visitArithmetic(node.initialize, depth)
        if (node.test) visitArithmetic(node.test, depth)
        if (node.update) visitArithmetic(node.update, depth)
        visitNode(node.body, depth, [])
        return
      case 'While':
        visitNode(node.clause, depth, [])
        visitNode(node.body, depth, [])
        return
      case 'Function':
        analysis.structureSafe = false
        visitWord(node.name, depth)
        for (const redirect of node.redirects) visitRedirect(redirect, depth)
        visitNode(node.body, depth, [])
        return
      case 'Subshell':
      case 'BraceGroup':
        visitNode(node.body, depth, [])
        return
      case 'Coproc':
        analysis.structureSafe = false
        if (node.name) visitWord(node.name, depth)
        for (const redirect of node.redirects) visitRedirect(redirect, depth)
        visitNode(node.body, depth, [])
        return
      case 'CompoundList':
        for (const statement of node.commands) visitNode(statement, depth, [])
        return
      case 'Case':
        analysis.structureSafe = false
        visitWord(node.word, depth)
        for (const item of node.items) {
          for (const pattern of item.pattern) visitWord(pattern, depth)
          visitNode(item.body, depth, [])
        }
        return
      case 'Statement': {
        for (const redirect of node.redirects) visitRedirect(redirect, depth)
        if (pipeline.length > 0) {
          visitNode(node.command, depth, pipeline)
          return
        }
        const nested: AnalyzedCommand[] = []
        visitNode(node.command, depth, nested)
        if (nested.length > 0) analysis.pipelines.push({ commands: nested })
        return
      }
      case 'TestCommand':
        analysis.structureSafe = false
        visitTest(node.expression, depth)
        return
      case 'ArithmeticCommand':
        analysis.structureSafe = false
        if (node.expression) visitArithmetic(node.expression, depth)
        return
      default:
        exhaustiveNode(node)
    }
  }

  function visitScript(script: ParsedScript, depth: number) {
    for (const error of script.errors ?? []) analysis.errors.push(error.message)
    for (const statement of script.commands) visitNode(statement, depth, [])
  }

  const parsed = parse(source)
  visitScript(parsed, 0)
  if (analysis.pipelines.length === 0 && analysis.commands.length > 0) {
    analysis.pipelines.push({ commands: analysis.commands })
  }
  return analysis
}
