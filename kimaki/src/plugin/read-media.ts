import fs from 'node:fs/promises'
import path from 'node:path'
import * as errore from 'errore'

export const READ_MEDIA_TOOL = 'readMediaIntoContext'
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024

export type MediaKind = 'image' | 'video'

const MEDIA_TYPES: Record<string, { mime: string; kind: MediaKind }> = {
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.heic': { mime: 'image/heic', kind: 'image' },
  '.heif': { mime: 'image/heif', kind: 'image' },
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.m4v': { mime: 'video/mp4', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
  '.mpeg': { mime: 'video/mpeg', kind: 'video' },
  '.mpg': { mime: 'video/mpeg', kind: 'video' },
}

export class MediaError extends errore.createTaggedError({
  name: 'MediaError',
  message: '$reason',
}) {}

export type Media = { bytes: Buffer; name: string; mime: string; kind: MediaKind }

function isUrl(source: string) {
  return source.startsWith('http://') || source.startsWith('https://')
}

export function checkMediaSize({ size, name }: { size: number; name: string }) {
  if (size <= MAX_MEDIA_BYTES) return null
  const mb = (size / 1024 / 1024).toFixed(1)
  return new MediaError({ reason: `${name} is ${mb} MB, over the 20 MB limit. Shrink it first, for example: ffmpeg -i in.mp4 -t 30 -vf scale=-2:720 out.mp4` })
}

export async function loadMedia({ source, directory, signal }: { source: string; directory: string; signal: AbortSignal }): Promise<MediaError | Media> {
  const location = isUrl(source) ? new URL(source).pathname : source
  const ext = path.extname(location).toLowerCase()
  const type = MEDIA_TYPES[ext]
  if (!type) return new MediaError({ reason: `Unsupported media type "${ext}". Supported: ${Object.keys(MEDIA_TYPES).join(', ')}` })
  const name = path.basename(location)

  if (isUrl(source)) {
    const res = await fetch(source, { signal }).catch((e) => new MediaError({ reason: `Failed to fetch ${source}`, cause: e }))
    if (res instanceof Error) return res
    if (!res.ok) return new MediaError({ reason: `Failed to fetch ${source}: HTTP ${res.status}` })
    const length = Number(res.headers.get('content-length'))
    const tooLarge = checkMediaSize({ size: length || 0, name })
    if (tooLarge) return tooLarge
    const bytes = await res.arrayBuffer().then(Buffer.from).catch((e) => new MediaError({ reason: `Failed to download ${source}`, cause: e }))
    if (bytes instanceof Error) return bytes
    const downloadedTooLarge = checkMediaSize({ size: bytes.length, name })
    if (downloadedTooLarge) return downloadedTooLarge
    return { bytes, name, ...type }
  }

  const resolved = path.resolve(directory, source)
  const stat = await fs.stat(resolved).catch((e) => new MediaError({ reason: `File not found: ${resolved}`, cause: e }))
  if (stat instanceof Error) return stat
  const tooLarge = checkMediaSize({ size: stat.size, name })
  if (tooLarge) return tooLarge
  const bytes = await fs.readFile(resolved).catch((e) => new MediaError({ reason: `Failed to read ${resolved}`, cause: e }))
  if (bytes instanceof Error) return bytes
  return { bytes, name, ...type }
}
