// Audio transcription service using Google Gemini.
// Transcribes voice messages with code-aware context, using grep/glob tools
// to verify technical terms, filenames, and function names in the codebase.
// Uses errore for type-safe error handling.

import { GoogleGenAI, Type, type Content, type Part, type Tool } from '@google/genai'
import * as errore from 'errore'
import { createLogger } from './logger.js'
import { glob } from 'glob'
import { ripGrep } from 'ripgrep-js'
import {
  ApiKeyMissingError,
  InvalidAudioFormatError,
  TranscriptionError,
  EmptyTranscriptionError,
  NoResponseContentError,
  NoToolResponseError,
  GrepSearchError,
  GlobSearchError,
} from './errors.js'

const voiceLogger = createLogger('VOICE')

export type TranscriptionToolRunner = ({
  name,
  args,
}: {
  name: string
  args: Record<string, string> | undefined
}) => Promise<
  | { type: 'result'; transcription: string }
  | { type: 'toolResponse'; name: string; output: string }
  | { type: 'skip' }
>

function runGrep({ pattern, directory }: { pattern: string; directory: string }): Promise<GrepSearchError | string> {
  return errore.tryAsync({
    try: async () => {
      const results = await ripGrep(directory, {
        string: pattern,
        globs: ['!node_modules/**', '!.git/**', '!dist/**', '!build/**'],
      })

      if (results.length === 0) {
        return 'No matches found'
      }

      const output = results
        .slice(0, 10)
        .map((match) => {
          return `${match.path.text}:${match.line_number}: ${match.lines.text.trim()}`
        })
        .join('\n')

      return output.slice(0, 2000)
    },
    catch: (e) => new GrepSearchError({ pattern, cause: e }),
  })
}

function runGlob({ pattern, directory }: { pattern: string; directory: string }): Promise<GlobSearchError | string> {
  return errore.tryAsync({
    try: async () => {
      const files = await glob(pattern, {
        cwd: directory,
        nodir: false,
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
        maxDepth: 10,
      })

      if (files.length === 0) {
        return 'No files found'
      }

      return files.slice(0, 30).join('\n')
    },
    catch: (e) => new GlobSearchError({ pattern, cause: e }),
  })
}

const grepToolDeclaration = {
  name: 'grep',
  description:
    'Search for a pattern in file contents to verify if a technical term, function name, or variable exists in the code. Use this to check if transcribed words match actual code.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      pattern: {
        type: Type.STRING,
        description:
          'The search pattern (case-insensitive). Can be a word, function name, or partial match.',
      },
    },
    required: ['pattern'],
  },
}

const globToolDeclaration = {
  name: 'glob',
  description:
    'Search for files by name pattern. Use this to verify if a filename or directory mentioned in the audio actually exists in the project.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      pattern: {
        type: Type.STRING,
        description:
          'The glob pattern to match files. Examples: "*.ts", "**/*.json", "**/config*", "src/**/*.tsx"',
      },
    },
    required: ['pattern'],
  },
}

const transcriptionResultToolDeclaration = {
  name: 'transcriptionResult',
  description:
    'MANDATORY: You MUST call this tool to complete the task. This is the ONLY way to return results - text responses are ignored. Call this with your transcription, even if imperfect. An imperfect transcription is better than none.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      transcription: {
        type: Type.STRING,
        description:
          'The final transcription of the audio. MUST be non-empty. If audio is unclear, transcribe your best interpretation. If silent, use "[inaudible audio]".',
      },
    },
    required: ['transcription'],
  },
}

function createToolRunner({ directory }: { directory?: string }): TranscriptionToolRunner {
  const hasDirectory = directory && directory.trim().length > 0

  return async ({ name, args }) => {
    if (name === 'transcriptionResult') {
      return {
        type: 'result',
        transcription: args?.transcription || '',
      }
    }

    if (name === 'grep' && hasDirectory) {
      const pattern = args?.pattern || ''
      voiceLogger.log(`Grep search: "${pattern}"`)
      const result = await runGrep({ pattern, directory })
      const output = (() => {
        if (errore.isError(result)) {
          voiceLogger.error('grep search failed:', result)
          return 'grep search failed'
        }
        return result
      })()
      voiceLogger.log(`Grep result: ${output.slice(0, 100)}...`)
      return { type: 'toolResponse', name: 'grep', output }
    }

    if (name === 'glob' && hasDirectory) {
      const pattern = args?.pattern || ''
      voiceLogger.log(`Glob search: "${pattern}"`)
      const result = await runGlob({ pattern, directory })
      const output = (() => {
        if (errore.isError(result)) {
          voiceLogger.error('glob search failed:', result)
          return 'glob search failed'
        }
        return result
      })()
      voiceLogger.log(`Glob result: ${output.slice(0, 100)}...`)
      return { type: 'toolResponse', name: 'glob', output }
    }

    return { type: 'skip' }
  }
}

type TranscriptionLoopError =
  | NoResponseContentError
  | TranscriptionError
  | EmptyTranscriptionError
  | NoToolResponseError

export async function runTranscriptionLoop({
  genAI,
  model,
  initialContents,
  tools,
  temperature,
  toolRunner,
  maxSteps = 10,
}: {
  genAI: GoogleGenAI
  model: string
  initialContents: Content[]
  tools: Tool[]
  temperature: number
  toolRunner: TranscriptionToolRunner
  maxSteps?: number
}): Promise<TranscriptionLoopError | string> {
  // Wrap external API call that can throw
  const initialResponse = await errore.tryAsync({
    try: () =>
      genAI.models.generateContent({
        model,
        contents: initialContents,
        config: {
          temperature,
          thinkingConfig: {
            thinkingBudget: 1024,
          },
          tools,
        },
      }),
    catch: (e) => new TranscriptionError({ reason: `API call failed: ${String(e)}`, cause: e }),
  })

  if (errore.isError(initialResponse)) {
    return initialResponse
  }

  let response = initialResponse
  const conversationHistory: Content[] = [...initialContents]
  let stepsRemaining = maxSteps

  while (true) {
    const candidate = response.candidates?.[0]
    if (!candidate?.content?.parts) {
      const text = response.text?.trim()
      if (text) {
        voiceLogger.log(`No parts but got text response: "${text.slice(0, 100)}..."`)
        return text
      }
      return new NoResponseContentError()
    }

    const functionCalls = candidate.content.parts.filter(
      (part): part is Part & { functionCall: NonNullable<Part['functionCall']> } =>
        'functionCall' in part && !!part.functionCall,
    )

    if (functionCalls.length === 0) {
      const text = response.text?.trim()
      if (text) {
        voiceLogger.log(`No function calls but got text: "${text.slice(0, 100)}..."`)
        return text
      }
      return new TranscriptionError({ reason: 'Model did not produce a transcription' })
    }

    conversationHistory.push({
      role: 'model',
      parts: candidate.content.parts,
    })

    const functionResponseParts: Array<{
      functionResponse: { name: string; response: { output: string } }
    }> = []

    for (const part of functionCalls) {
      const call = part.functionCall
      const args = call.args as Record<string, string> | undefined
      const result = await toolRunner({ name: call.name || '', args })

      if (result.type === 'result') {
        const transcription = result.transcription?.trim() || ''
        voiceLogger.log(`Transcription result received: "${transcription.slice(0, 100)}..."`)
        if (!transcription) {
          return new EmptyTranscriptionError()
        }
        return transcription
      }

      if (result.type === 'toolResponse') {
        stepsRemaining--
        const stepsWarning: string = (() => {
          if (stepsRemaining <= 0) {
            return '\n\n[CRITICAL: Tool limit reached. You MUST call transcriptionResult NOW. No more grep/glob allowed. Call transcriptionResult immediately with your best transcription.]'
          }
          if (stepsRemaining === 1) {
            return '\n\n[URGENT: FINAL STEP. You MUST call transcriptionResult NOW. Do NOT call grep or glob. Call transcriptionResult with your transcription immediately.]'
          }
          if (stepsRemaining <= 3) {
            return `\n\n[WARNING: Only ${stepsRemaining} steps remaining. Finish searching soon and call transcriptionResult. Do not wait until the last step.]`
          }
          return ''
        })()

        functionResponseParts.push({
          functionResponse: {
            name: result.name,
            response: { output: result.output + stepsWarning },
          },
        })
      }
    }

    if (functionResponseParts.length === 0) {
      return new NoToolResponseError()
    }

    conversationHistory.push({
      role: 'user',
      parts: functionResponseParts,
    } as Content)

    // Wrap external API call that can throw
    const nextResponse = await errore.tryAsync({
      try: () =>
        genAI.models.generateContent({
          model,
          contents: conversationHistory,
          config: {
            temperature,
            thinkingConfig: {
              thinkingBudget: 512,
            },
            tools:
              stepsRemaining <= 0
                ? [{ functionDeclarations: [transcriptionResultToolDeclaration] }]
                : tools,
          },
        }),
      catch: (e) => new TranscriptionError({ reason: `API call failed: ${String(e)}`, cause: e }),
    })

    if (errore.isError(nextResponse)) {
      return nextResponse
    }

    response = nextResponse
  }
}

export type TranscribeAudioErrors =
  | ApiKeyMissingError
  | InvalidAudioFormatError
  | TranscriptionLoopError

export function transcribeAudio({
  audio,
  prompt,
  language,
  temperature,
  geminiApiKey,
  directory,
  currentSessionContext,
  lastSessionContext,
}: {
  audio: Buffer | Uint8Array | ArrayBuffer | string
  prompt?: string
  language?: string
  temperature?: number
  geminiApiKey?: string
  directory?: string
  currentSessionContext?: string
  lastSessionContext?: string
}): Promise<TranscribeAudioErrors | string> {
  const apiKey = geminiApiKey || process.env.GEMINI_API_KEY

  if (!apiKey) {
    return Promise.resolve(new ApiKeyMissingError({ service: 'Gemini' }))
  }

  const genAI = new GoogleGenAI({ apiKey })

  const audioBase64: string = (() => {
    if (typeof audio === 'string') {
      return audio
    }
    if (audio instanceof Buffer) {
      return audio.toString('base64')
    }
    if (audio instanceof Uint8Array) {
      return Buffer.from(audio).toString('base64')
    }
    if (audio instanceof ArrayBuffer) {
      return Buffer.from(audio).toString('base64')
    }
    return ''
  })()

  if (!audioBase64) {
    return Promise.resolve(new InvalidAudioFormatError())
  }

  const languageHint = language ? `The audio is in ${language}.\n\n` : ''

  // build session context section
  const sessionContextParts: string[] = []
  if (lastSessionContext) {
    sessionContextParts.push(`<last_session>
${lastSessionContext}
</last_session>`)
  }
  if (currentSessionContext) {
    sessionContextParts.push(`<current_session>
${currentSessionContext}
</current_session>`)
  }
  const sessionContextSection =
    sessionContextParts.length > 0
      ? `\nSession context (use to understand references to files, functions, tools used):\n${sessionContextParts.join('\n\n')}`
      : ''

  const transcriptionPrompt = `${languageHint}Transcribe this audio for a coding agent (like Claude Code or OpenCode).

CRITICAL REQUIREMENT: You MUST call the "transcriptionResult" tool to complete this task.
- The transcriptionResult tool is the ONLY way to return results
- Text responses are completely ignored - only tool calls work
- You MUST call transcriptionResult even if you run out of tool calls
- An imperfect transcription is better than no transcription
- DO NOT end without calling transcriptionResult

This is a software development environment. The speaker is giving instructions to an AI coding assistant. Expect:
- File paths, function names, CLI commands, package names, API endpoints

RULES:
1. If audio is unclear, transcribe your best interpretation, interpreting words event with strong accents are present, identifying the accent being used first so you can guess what the words meawn
2. If audio seems silent/empty, call transcriptionResult with "[inaudible audio]"
3. Use the session context below to understand technical terms, file names, function names mentioned

Common corrections (apply without tool calls):
- "reacked" → "React", "jason" → "JSON", "get hub" → "GitHub", "no JS" → "Node.js", "dacker" → "Docker"

Project file structure:
<file_tree>
${prompt}
</file_tree>
${sessionContextSection}

REMEMBER: Call "transcriptionResult" tool with your transcription. This is mandatory.

Note: "critique" is a CLI tool for showing diffs in the browser.`

  // const hasDirectory = directory && directory.trim().length > 0
  const tools = [
    {
      functionDeclarations: [
        transcriptionResultToolDeclaration,
        // grep/glob disabled - was causing transcription to hang
        // ...(hasDirectory ? [grepToolDeclaration, globToolDeclaration] : []),
      ],
    },
  ]

  const initialContents: Content[] = [
    {
      role: 'user',
      parts: [
        { text: transcriptionPrompt },
        {
          inlineData: {
            data: audioBase64,
            mimeType: 'audio/mpeg',
          },
        },
      ],
    },
  ]

  const toolRunner = createToolRunner({ directory })

  return runTranscriptionLoop({
    genAI,
    model: 'gemini-2.5-flash',
    initialContents,
    tools,
    temperature: temperature ?? 0.3,
    toolRunner,
  })
}
