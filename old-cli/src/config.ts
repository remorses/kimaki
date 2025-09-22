import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const PreferredModelSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
})

export const KimakiConfigSchema = z.object({
  preferredModel: PreferredModelSchema.optional(),
})

export type KimakiConfig = z.infer<typeof KimakiConfigSchema>

const configDir = path.join(os.homedir(), '.kimaki')
const configPath = path.join(configDir, 'kimaki.json')

export async function readConfig(): Promise<KimakiConfig> {
  try {
    const configData = await fs.promises.readFile(configPath, 'utf-8')
    const config = JSON.parse(configData)
    return KimakiConfigSchema.parse(config)
  } catch (error) {
    return {}
  }
}

export async function writeConfig(config: KimakiConfig): Promise<void> {
  await fs.promises.mkdir(configDir, { recursive: true })
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2))
}

export async function updateConfig(updates: Partial<KimakiConfig>): Promise<void> {
  const config = await readConfig()
  const updatedConfig = { ...config, ...updates }
  await writeConfig(updatedConfig)
}