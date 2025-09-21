import { openai } from '@ai-sdk/openai';
import { experimental_transcribe as transcribe } from 'ai';

export async function transcribeAudio(
  audio: Buffer | Uint8Array | ArrayBuffer | string,
  options?: {
    language?: string;
    prompt?: string;
    temperature?: number;
  }
): Promise<string> {
  try {
    const result = await transcribe({
      model: openai.transcription('whisper-1'),
      audio,
      ...(options && {
        providerOptions: {
          openai: {
            ...(options.language && { language: options.language }),
            ...(options.prompt && { prompt: options.prompt }),
            ...(options.temperature !== undefined && { temperature: options.temperature }),
          }
        }
      })
    });

    return result.text;
  } catch (error) {
    console.error('Failed to transcribe audio:', error);
    throw new Error(`Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}