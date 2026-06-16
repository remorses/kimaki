// Deterministic AI SDK provider for e2e tests with matcher-driven outputs.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'

type LegacyUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

type DeterministicUsage = LegacyUsage | LanguageModelV3Usage

type DeterministicFinishReason =
  | LanguageModelV3FinishReason
  | LanguageModelV3FinishReason['unified']

type DeterministicFinishPart = {
  type: 'finish'
  finishReason: DeterministicFinishReason
  usage: DeterministicUsage
  providerMetadata?: Extract<LanguageModelV3StreamPart, { type: 'finish' }>['providerMetadata']
}

type DeterministicStreamPart =
  | Exclude<LanguageModelV3StreamPart, { type: 'finish' }>
  | DeterministicFinishPart

const DEFAULT_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: 0,
    noCache: 0,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 0,
    text: 0,
    reasoning: 0,
  },
}

const DEFAULT_TEXT_STREAM_PARTS: DeterministicStreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'default-text' },
  { type: 'text-delta', id: 'default-text', delta: 'ok' },
  { type: 'text-end', id: 'default-text' },
  {
    type: 'finish',
    finishReason: 'stop',
    usage: DEFAULT_USAGE,
  },
]

type MessageRole = LanguageModelV3Prompt[number]['role']

export type DeterministicMatcher = {
  id: string
  enabled?: boolean
  priority?: number
  when?: {
    lastMessageRole?: MessageRole
    lastMessageTextIncludes?: string
    lastMessageTextRegex?: string
    promptTextIncludes?: string
    promptTextRegex?: string
    rawPromptIncludes?: string
    rawPromptRegex?: string
    latestUserTextEquals?: string
    latestUserTextIncludes?: string
    latestUserTextRegex?: string
  }
  then: {
    parts: DeterministicStreamPart[]
    partDelaysMs?: number[]
    defaultPartDelayMs?: number
  }
}

export type DeterministicProviderSettings = {
  name?: string
  matchers?: DeterministicMatcher[]
  defaultPartDelayMs?: number
  strict?: boolean
  defaultParts?: DeterministicStreamPart[]
}

export type BuildDeterministicOpencodeConfigOptions = {
  model: string
  smallModel?: string
  providerName?: string
  providerNpm?: string
  settings?: DeterministicProviderSettings
}

type NormalizedMatcher = DeterministicMatcher & {
  compiledLastMessageRegex?: RegExp
  compiledPromptRegex?: RegExp
  compiledRawPromptRegex?: RegExp
  compiledRegex?: RegExp
}

type ResolvedMatch = {
  parts: DeterministicStreamPart[]
  partDelaysMs?: number[]
  defaultPartDelayMs?: number
}

export interface DeterministicProvider {
  (modelId: string): LanguageModelV3
  languageModel(modelId: string): LanguageModelV3
}

export function createDeterministicProvider(
  settings: DeterministicProviderSettings = {},
): DeterministicProvider {
  const normalizedSettings = normalizeSettingsInput({ input: settings })
  const providerName = normalizedSettings.name || 'deterministic-provider'
  const normalizedMatchers = normalizeMatchers({
    matchers: normalizedSettings.matchers || [],
  })

  const buildLanguageModel = ({ modelId }: { modelId: string }): LanguageModelV3 => {
    return {
      specificationVersion: 'v3',
      provider: providerName,
      modelId,
      supportedUrls: {},
      doGenerate: async (options) => {
        const resolved = resolveMatch({
          options,
          normalizedMatchers,
          settings: normalizedSettings,
        })
        const ensured = ensureTerminalStreamPartsAndDelays({
          parts: resolved.parts,
          partDelaysMs: resolved.partDelaysMs,
        })
        return buildGenerateResult({ parts: ensured.parts })
      },
      doStream: async (options) => {
        const resolved = resolveMatch({
          options,
          normalizedMatchers,
          settings: normalizedSettings,
        })
        const ensured = ensureTerminalStreamPartsAndDelays({
          parts: resolved.parts,
          partDelaysMs: resolved.partDelaysMs,
        })
        const stream = new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            void streamPartsWithDelay({
              controller,
              parts: ensured.parts,
              partDelaysMs: ensured.partDelaysMs,
              matcherDefaultPartDelayMs: resolved.defaultPartDelayMs,
              providerDefaultPartDelayMs: normalizedSettings.defaultPartDelayMs,
            })
          },
        })
        return { stream }
      },
    }
  }

  const provider = ((modelId: string) => {
    return buildLanguageModel({ modelId })
  }) as DeterministicProvider
  provider.languageModel = (modelId: string) => {
    return buildLanguageModel({ modelId })
  }
  return provider
}

export function buildDeterministicOpencodeConfig({
  model,
  smallModel,
  providerName,
  providerNpm,
  settings,
}: BuildDeterministicOpencodeConfigOptions) {
  const chosenProviderName = providerName || 'deterministic-provider'
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  )
  const chosenProviderNpm = providerNpm || packageRoot
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [chosenProviderName]: {
        npm: chosenProviderNpm,
        name: 'Deterministic Provider',
        options: settings || {},
        models: {
          [model]: {
            name: model,
          },
          ...(smallModel
            ? {
                [smallModel]: {
                  name: smallModel,
                },
              }
            : {}),
        },
      },
    },
    model: `${chosenProviderName}/${model}`,
    ...(smallModel && {
      small_model: `${chosenProviderName}/${smallModel}`,
    }),
  }
}

function normalizeMatchers({ matchers }: { matchers: DeterministicMatcher[] }) {
  return matchers.map((matcher) => {
    const rawPromptRegexText = matcher.when?.rawPromptRegex
    const promptRegexText = matcher.when?.promptTextRegex
    const lastMessageRegexText = matcher.when?.lastMessageTextRegex
    const regexText = matcher.when?.latestUserTextRegex
    if (
      !regexText &&
      !lastMessageRegexText &&
      !promptRegexText &&
      !rawPromptRegexText
    ) {
      return matcher
    }
    return {
      ...matcher,
      ...(regexText && {
        compiledRegex: new RegExp(regexText),
      }),
      ...(lastMessageRegexText && {
        compiledLastMessageRegex: new RegExp(lastMessageRegexText),
      }),
      ...(promptRegexText && {
        compiledPromptRegex: new RegExp(promptRegexText),
      }),
      ...(rawPromptRegexText && {
        compiledRawPromptRegex: new RegExp(rawPromptRegexText),
      }),
    }
  })
}

function normalizeSettingsInput({
  input,
}: {
  input: DeterministicProviderSettings
}): DeterministicProviderSettings {
  const root: Record<string, unknown> =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const candidate: Record<string, unknown> =
    'options' in root && root['options'] && typeof root['options'] === 'object'
      ? (root['options'] as Record<string, unknown>)
      : root

  const parseMatchers = (): DeterministicMatcher[] => {
    const raw = candidate['matchers']
    if (Array.isArray(raw)) {
      return raw as DeterministicMatcher[]
    }
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          return parsed as DeterministicMatcher[]
        }
      } catch {
        return []
      }
    }
    return []
  }

  const parseDefaultParts = (): DeterministicStreamPart[] | undefined => {
    const raw = candidate['defaultParts']
    if (Array.isArray(raw)) {
      return raw as DeterministicStreamPart[]
    }
    return undefined
  }

  return {
    name: typeof candidate['name'] === 'string' ? candidate['name'] : undefined,
    matchers: parseMatchers(),
    defaultPartDelayMs:
      typeof candidate['defaultPartDelayMs'] === 'number'
        ? candidate['defaultPartDelayMs']
        : undefined,
    strict: typeof candidate['strict'] === 'boolean' ? candidate['strict'] : undefined,
    defaultParts: parseDefaultParts(),
  }
}

function resolveMatch({
  options,
  normalizedMatchers,
  settings,
}: {
  options: LanguageModelV3CallOptions
  normalizedMatchers: NormalizedMatcher[]
  settings: DeterministicProviderSettings
}): ResolvedMatch {
  const sortedMatchers = [...normalizedMatchers].sort((a, b) => {
    return (b.priority || 0) - (a.priority || 0)
  })
  const matched = sortedMatchers.find((matcher) => {
    return matcherMatches({ matcher, options })
  })
  if (matched) {
    return {
      parts: matched.then.parts,
      partDelaysMs: matched.then.partDelaysMs,
      defaultPartDelayMs: matched.then.defaultPartDelayMs,
    }
  }
  if (settings.strict) {
    const latestUserText = getLatestUserText({ prompt: options.prompt })
    const lastMessageRole = getLastMessageRole({ prompt: options.prompt })
    throw new Error(
      `No deterministic matcher matched current prompt (lastRole=${String(lastMessageRole)}, latestUserText=${JSON.stringify(latestUserText)})`,
    )
  }
  return {
    parts: settings.defaultParts || DEFAULT_TEXT_STREAM_PARTS,
    defaultPartDelayMs: settings.defaultPartDelayMs,
  }
}

function matcherMatches({
  matcher,
  options,
}: {
  matcher: NormalizedMatcher
  options: LanguageModelV3CallOptions
}) {
  if (matcher.enabled === false) {
    return false
  }

  const when = matcher.when
  if (!when) {
    return true
  }

  const lastRole = getLastMessageRole({ prompt: options.prompt })
  if (when.lastMessageRole && when.lastMessageRole !== lastRole) {
    return false
  }
  const lastMessageText = getLastMessageText({ prompt: options.prompt })
  if (
    when.lastMessageTextIncludes !== undefined &&
    !lastMessageText.includes(when.lastMessageTextIncludes)
  ) {
    return false
  }
  if (
    matcher.compiledLastMessageRegex &&
    !matcher.compiledLastMessageRegex.test(lastMessageText)
  ) {
    return false
  }

  const promptText = getPromptText({ prompt: options.prompt })
  if (
    when.promptTextIncludes !== undefined &&
    !promptText.includes(when.promptTextIncludes)
  ) {
    return false
  }
  if (matcher.compiledPromptRegex && !matcher.compiledPromptRegex.test(promptText)) {
    return false
  }

  const rawPromptText = JSON.stringify(options.prompt)
  if (
    when.rawPromptIncludes !== undefined &&
    !rawPromptText.includes(when.rawPromptIncludes)
  ) {
    return false
  }
  if (
    matcher.compiledRawPromptRegex &&
    !matcher.compiledRawPromptRegex.test(rawPromptText)
  ) {
    return false
  }

  const latestUserText = getLatestUserText({ prompt: options.prompt })
  if (
    when.latestUserTextEquals !== undefined &&
    latestUserText !== when.latestUserTextEquals
  ) {
    return false
  }
  if (
    when.latestUserTextIncludes !== undefined &&
    !latestUserText.includes(when.latestUserTextIncludes)
  ) {
    return false
  }
  if (matcher.compiledRegex && !matcher.compiledRegex.test(latestUserText)) {
    return false
  }

  return true
}

function getLastMessageRole({ prompt }: { prompt: LanguageModelV3Prompt }) {
  const last = prompt[prompt.length - 1]
  if (!last) {
    return undefined
  }
  return last.role
}

function getLastMessageText({ prompt }: { prompt: LanguageModelV3Prompt }) {
  const last = prompt[prompt.length - 1]
  if (!last) {
    return ''
  }
  if (last.role === 'system') {
    return last.content
  }
  if (!Array.isArray(last.content)) {
    return ''
  }
  return last.content.reduce((acc, part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      return acc
    }
    return acc ? `${acc}\n${part.text}` : part.text
  }, '')
}

function getLatestUserText({ prompt }: { prompt: LanguageModelV3Prompt }) {
  const latestUserMessage = [...prompt].reverse().find((message) => {
    return message.role === 'user'
  })
  if (!latestUserMessage) {
    return ''
  }
  if (!Array.isArray(latestUserMessage.content)) {
    return ''
  }
  return latestUserMessage.content.reduce((acc, part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      return acc
    }
    return acc ? `${acc}\n${part.text}` : part.text
  }, '')
}

function getPromptText({ prompt }: { prompt: LanguageModelV3Prompt }) {
  return prompt
    .map((message) => {
      if (message.role === 'system') {
        return message.content
      }
      if (!Array.isArray(message.content)) {
        return ''
      }
      return message.content.reduce((acc, part) => {
        if (part.type !== 'text' || typeof part.text !== 'string') {
          return acc
        }
        return acc ? `${acc}\n${part.text}` : part.text
      }, '')
    })
    .join('\n')
}

function ensureTerminalStreamPartsAndDelays({
  parts,
  partDelaysMs,
}: {
  parts: DeterministicStreamPart[]
  partDelaysMs?: number[]
}) {
  const normalized = parts.map(normalizeStreamPart)

  const streamStartPart: LanguageModelV3StreamPart = {
    type: 'stream-start',
    warnings: [],
  }
  const finishPart: LanguageModelV3StreamPart = {
    type: 'finish',
    finishReason: normalizeFinishReason('stop'),
    usage: DEFAULT_USAGE,
  }

  const hasStreamStart = normalized.some((part) => {
    return part.type === 'stream-start'
  })
  const withStreamStart = hasStreamStart ? normalized : [streamStartPart, ...normalized]
  const delaysWithStreamStart =
    partDelaysMs && !hasStreamStart ? [0, ...partDelaysMs] : partDelaysMs

  const hasFinish = withStreamStart.some((part) => {
    return part.type === 'finish'
  })

  if (hasFinish) {
    if (delaysWithStreamStart && delaysWithStreamStart.length !== withStreamStart.length) {
      throw new Error('partDelaysMs length must equal emitted stream parts length')
    }
    return {
      parts: withStreamStart,
      partDelaysMs: delaysWithStreamStart,
    }
  }

  const withFinish = [...withStreamStart, finishPart]
  const delaysWithFinish = delaysWithStreamStart
    ? [...delaysWithStreamStart, 0]
    : undefined
  if (delaysWithFinish && delaysWithFinish.length !== withFinish.length) {
    throw new Error('partDelaysMs length must equal emitted stream parts length')
  }
  return {
    parts: withFinish,
    partDelaysMs: delaysWithFinish,
  }
}

async function streamPartsWithDelay({
  controller,
  parts,
  partDelaysMs,
  matcherDefaultPartDelayMs,
  providerDefaultPartDelayMs,
}: {
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  parts: LanguageModelV3StreamPart[]
  partDelaysMs?: number[]
  matcherDefaultPartDelayMs?: number
  providerDefaultPartDelayMs?: number
}) {
  try {
    for (const [index, part] of parts.entries()) {
      const delayFromList = partDelaysMs?.[index]
      const delay =
        delayFromList ?? matcherDefaultPartDelayMs ?? providerDefaultPartDelayMs ?? 0
      if (delay > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delay)
        })
      }
      controller.enqueue(part)
    }
    controller.close()
  } catch (error) {
    controller.error(error)
  }
}

function buildGenerateResult({
  parts,
}: {
  parts: LanguageModelV3StreamPart[]
}): LanguageModelV3GenerateResult {
  const content: LanguageModelV3Content[] = []
  const textById = new Map<string, string>()
  for (const part of parts) {
    if (part.type === 'text-start') {
      textById.set(part.id, '')
      continue
    }
    if (part.type === 'text-delta') {
      const existing = textById.get(part.id) || ''
      textById.set(part.id, `${existing}${part.delta}`)
      continue
    }
    if (part.type === 'text-end') {
      const text = textById.get(part.id) || ''
      textById.delete(part.id)
      if (text) {
        content.push({ type: 'text', text })
      }
      continue
    }
    if (isToolCallPart(part)) {
      content.push(part)
      continue
    }
    if (isToolResultPart(part) || isFilePart(part) || isSourcePart(part)) {
      content.push(part)
    }
  }

  const finish = [...parts].reverse().find(isFinishPart)
  const streamStart = parts.find(isStreamStartPart)

  const finishReason = finish ? finish.finishReason : normalizeFinishReason('stop')
  const usage = finish ? finish.usage : DEFAULT_USAGE
  const warnings: Extract<LanguageModelV3StreamPart, { type: 'stream-start' }>['warnings'] =
    streamStart ? streamStart.warnings : []

  return {
    content,
    finishReason,
    usage,
    warnings,
  }
}

function isToolCallPart(
  part: LanguageModelV3StreamPart,
): part is Extract<LanguageModelV3StreamPart, { type: 'tool-call' }> {
  return part.type === 'tool-call'
}

function isToolResultPart(
  part: LanguageModelV3StreamPart,
): part is Extract<LanguageModelV3StreamPart, { type: 'tool-result' }> {
  return part.type === 'tool-result'
}

function isFilePart(
  part: LanguageModelV3StreamPart,
): part is Extract<LanguageModelV3StreamPart, { type: 'file' }> {
  return part.type === 'file'
}

function isSourcePart(
  part: LanguageModelV3StreamPart,
): part is Extract<LanguageModelV3StreamPart, { type: 'source' }> {
  return part.type === 'source'
}

function isStreamStartPart(
  part: LanguageModelV3StreamPart,
): part is Extract<LanguageModelV3StreamPart, { type: 'stream-start' }> {
  return part.type === 'stream-start'
}

function isFinishPart(
  part: LanguageModelV3StreamPart,
): part is Extract<LanguageModelV3StreamPart, { type: 'finish' }> {
  return part.type === 'finish'
}

function normalizeStreamPart(part: DeterministicStreamPart): LanguageModelV3StreamPart {
  if (part.type !== 'finish') {
    return part
  }

  return {
    type: 'finish',
    finishReason: normalizeFinishReason(part.finishReason),
    usage: normalizeUsage(part.usage),
    providerMetadata: part.providerMetadata,
  }
}

function normalizeFinishReason(
  reason: DeterministicFinishReason,
): LanguageModelV3FinishReason {
  if (typeof reason === 'string') {
    return {
      unified: reason,
      raw: reason,
    }
  }

  return {
    unified: reason.unified,
    raw: reason.raw,
  }
}

function normalizeUsage(usage: DeterministicUsage): LanguageModelV3Usage {
  if (isV3Usage(usage)) {
    return usage
  }

  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokens,
      cacheRead: usage.cachedInputTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokens,
      reasoning: usage.reasoningTokens,
    },
    raw: {
      totalTokens: usage.totalTokens,
    },
  }
}

function isV3Usage(usage: DeterministicUsage): usage is LanguageModelV3Usage {
  return typeof usage.inputTokens === 'object'
}
