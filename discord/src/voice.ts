import {
  GoogleGenAI,
  Type,
  type Content,
  type Part,
  type Tool,
} from '@google/genai'
import { createLogger } from './logger.js'
import { glob } from 'glob'
import { ripGrep } from 'ripgrep-js'

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

async function runGrep({
  pattern,
  directory,
}: {
  pattern: string
  directory: string
}): Promise<string> {
  try {
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
  } catch {
    return 'grep search failed'
  }
}

async function runGlob({
  pattern,
  directory,
}: {
  pattern: string
  directory: string
}): Promise<string> {
  try {
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
  } catch (error) {
    return `Glob search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
  }
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
    'Submit the final transcription result. You MUST call this tool with a non-empty transcription. Always transcribe what you hear, never return empty.',
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

function createToolRunner({
  directory,
}: {
  directory?: string
}): TranscriptionToolRunner {
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
      const output = await runGrep({ pattern, directory })
      voiceLogger.log(`Grep result: ${output.slice(0, 100)}...`)
      return { type: 'toolResponse', name: 'grep', output }
    }

    if (name === 'glob' && hasDirectory) {
      const pattern = args?.pattern || ''
      voiceLogger.log(`Glob search: "${pattern}"`)
      const output = await runGlob({ pattern, directory })
      voiceLogger.log(`Glob result: ${output.slice(0, 100)}...`)
      return { type: 'toolResponse', name: 'glob', output }
    }

    return { type: 'skip' }
  }
}

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
}): Promise<string> {
  let response = await genAI.models.generateContent({
    model,
    contents: initialContents,
    config: {
      temperature,
      thinkingConfig: {
        thinkingBudget: 1024,
      },
      tools,
    },
  })

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
      throw new Error('Transcription failed: No response content from model')
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
      throw new Error('Transcription failed: Model did not produce a transcription')
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
        voiceLogger.log(
          `Transcription result received: "${transcription.slice(0, 100)}..."`,
        )
        if (!transcription) {
          throw new Error('Transcription failed: Model returned empty transcription')
        }
        return transcription
      }

      if (result.type === 'toolResponse') {
        stepsRemaining--
        const stepsWarning =
          stepsRemaining <= 0
            ? '\n\n[SYSTEM: No more tool calls allowed. You MUST call transcriptionResult NOW with your best transcription.]'
            : stepsRemaining === 1
              ? '\n\n[SYSTEM: 1 step remaining. Call transcriptionResult next.]'
              : `\n\n[SYSTEM: ${stepsRemaining} steps remaining before you must call transcriptionResult.]`

        functionResponseParts.push({
          functionResponse: {
            name: result.name,
            response: { output: result.output + stepsWarning },
          },
        })
      }
    }

    if (functionResponseParts.length === 0) {
      throw new Error('Transcription failed: No valid tool responses')
    }

    conversationHistory.push({
      role: 'user',
      parts: functionResponseParts,
    } as Content)

    response = await genAI.models.generateContent({
      model,
      contents: conversationHistory,
      config: {
        temperature,
        thinkingConfig: {
          thinkingBudget: 512,
        },
        tools: stepsRemaining <= 0 ? [{ functionDeclarations: [transcriptionResultToolDeclaration] }] : tools,
      },
    })
  }
}

export async function transcribeAudio({
  audio,
  prompt,
  language,
  temperature,
  geminiApiKey,
  directory,
  sessionMessages,
}: {
  audio: Buffer | Uint8Array | ArrayBuffer | string
  prompt?: string
  language?: string
  temperature?: number
  geminiApiKey?: string
  directory?: string
  sessionMessages?: string
}): Promise<string> {
  try {
    const apiKey = geminiApiKey || process.env.GEMINI_API_KEY

    if (!apiKey) {
      throw new Error('Gemini API key is required for audio transcription')
    }

    const genAI = new GoogleGenAI({ apiKey })

    let audioBase64: string
    if (typeof audio === 'string') {
      audioBase64 = audio
    } else if (audio instanceof Buffer) {
      audioBase64 = audio.toString('base64')
    } else if (audio instanceof Uint8Array) {
      audioBase64 = Buffer.from(audio).toString('base64')
    } else if (audio instanceof ArrayBuffer) {
      audioBase64 = Buffer.from(audio).toString('base64')
    } else {
      throw new Error('Invalid audio format')
    }

    const languageHint = language ? `The audio is in ${language}.\n\n` : ''

    const transcriptionPrompt = `${languageHint}Transcribe this audio for a coding agent (like Claude Code or OpenCode).

This is a software development environment. The speaker is giving instructions to an AI coding assistant. Expect:
- File paths, function names, CLI commands, package names, API endpoints

RULES:
1. Call "transcriptionResult" with a non-empty transcription
2. If audio is unclear, transcribe your best interpretation
3. If audio seems silent/empty, respond with "[inaudible audio]"
4. You have limited tool calls - call multiple grep/glob tools in parallel to optimize for speed

Common corrections (apply without tool calls):
- "reacked" → "React", "jason" → "JSON", "get hub" → "GitHub", "no JS" → "Node.js", "dacker" → "Docker"

Project context for reference:
<context>
${prompt}
</context>
${sessionMessages ? `\nRecent session messages:\n<session_messages>\n${sessionMessages}\n</session_messages>` : ''}

Call "transcriptionResult" with your transcription.

Note: "critique" is a CLI tool for showing diffs in the browser.`

    const hasDirectory = directory && directory.trim().length > 0
    const tools = [
      {
        functionDeclarations: [
          transcriptionResultToolDeclaration,
          ...(hasDirectory ? [grepToolDeclaration, globToolDeclaration] : []),
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

    return await runTranscriptionLoop({
      genAI,
      model: 'gemini-2.5-flash',
      initialContents,
      tools,
      temperature: temperature ?? 0.3,
      toolRunner,
    })
  } catch (error) {
    voiceLogger.error('Failed to transcribe audio:', error)
    throw new Error(
      `Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
