// Discord voice server: the voice WebSocket (gateway v8) plus the UDP socket
// that carries RTP audio. Implements what @discordjs/voice needs to connect and
// send audio: Hello, Identify, Ready, IP discovery, Select Protocol, Session
// Description, Speaking, heartbeats. Only aead_aes256_gcm_rtpsize and no DAVE
// (E2EE), so the twin can decrypt every packet and record the opus frames.
//
// @discordjs/voice hardcodes `wss://${endpoint}`, so the WebSocket needs TLS.
// start() makes a self-signed certificate with the openssl CLI; tests trust it
// with trustCertificate().

import crypto from 'node:crypto'
import dgram from 'node:dgram'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { promisify } from 'node:util'
import { WebSocketServer, WebSocket } from 'ws'
import { VoiceEncryptionMode, VoiceOpcodes } from 'discord-api-types/voice/v8'
import type { VoiceSendPayload } from 'discord-api-types/voice/v8'

const execFileAsync = promisify(execFile)

const AUTH_TAG_LENGTH = 16
const NONCE_LENGTH = 4
const RTP_HEADER_LENGTH = 12

// Who may open a voice connection: issued with VOICE_SERVER_UPDATE.
type VoiceGrant = {
  token: string
  guildId: string
  channelId: string
  userId: string
  sessionId: string
}

// The audio one voice connection (one ssrc) sent.
export type VoiceStream = {
  guildId: string
  channelId: string
  userId: string
  ssrc: number
  // Decrypted opus frames in arrival order.
  opusPackets: Buffer[]
  // Last Speaking flag from the client.
  speaking: boolean
  lastPacketAt: number
}

type VoiceConnection = {
  ws: WebSocket
  grant: VoiceGrant | null
  ssrc: number
  secretKey: Buffer | null
  sequence: number
  stream: VoiceStream | null
  // UDP address of the client, learned from IP discovery. Audio of other users goes there.
  udp: { address: string; port: number } | null
  // Nonce counter of packets the twin sends to this client.
  sendNonce: number
}

export class DiscordVoiceServer {
  streams: VoiceStream[] = []
  certificate = ''
  private grants = new Map<string, VoiceGrant>()
  private connections = new Set<VoiceConnection>()
  private nextSsrc = 1000
  // userId -> ssrc of simulated users that speak (speak()).
  private userSsrcs = new Map<string, number>()
  private https: https.Server | null = null
  private wss: WebSocketServer | null = null
  private udp: dgram.Socket | null = null
  private wsPort = 0
  private udpPort = 0

  get endpoint(): string {
    return `127.0.0.1:${this.wsPort}`
  }

  async start(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-voice-'))
    const keyPath = path.join(dir, 'key.pem')
    const certPath = path.join(dir, 'cert.pem')
    await execFileAsync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
      ],
      { timeout: 10_000 },
    )
    const key = fs.readFileSync(keyPath, 'utf8')
    this.certificate = fs.readFileSync(certPath, 'utf8')
    fs.rmSync(dir, { recursive: true, force: true })

    this.https = https.createServer({ key, cert: this.certificate })
    this.wss = new WebSocketServer({ server: this.https })
    this.wss.on('connection', (ws) => this.handleConnection(ws))
    this.udp = dgram.createSocket('udp4')
    this.udp.on('message', (message, remote) => this.handleUdp(message, remote))

    const httpsServer = this.https
    const udp = this.udp
    await Promise.all([
      new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve)),
    ])
    const address = httpsServer.address()
    this.wsPort = address && typeof address === 'object' ? address.port : 0
    this.udpPort = udp.address().port
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.ws.terminate()
    this.connections.clear()
    this.wss?.close()
    this.udp?.close()
    const httpsServer = this.https
    if (httpsServer) await new Promise<void>((resolve) => httpsServer.close(() => resolve()))
  }

  // Lets this process connect to the self-signed voice WebSocket.
  trustCertificate(): void {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), this.certificate])
  }

  // Called by the gateway on a voice join. The token goes into VOICE_SERVER_UPDATE.
  grant({ guildId, channelId, userId, sessionId }: Omit<VoiceGrant, 'token'>): string {
    this.revoke({ guildId, userId })
    const token = crypto.randomBytes(8).toString('hex')
    this.grants.set(token, { token, guildId, channelId, userId, sessionId })
    return token
  }

  // Called on a voice leave: the token stops working and open connections close
  // with 4014 (disconnected), like Discord does when a bot leaves or is kicked.
  revoke({ guildId, userId }: { guildId: string; userId: string }): void {
    for (const [token, grant] of this.grants) {
      if (grant.guildId === guildId && grant.userId === userId) this.grants.delete(token)
    }
    for (const connection of this.connections) {
      if (connection.grant?.guildId === guildId && connection.grant.userId === userId) {
        connection.ws.close(4014, 'Disconnected')
      }
    }
  }

  private send(connection: VoiceConnection, op: VoiceOpcodes, d: unknown): void {
    if (connection.ws.readyState !== WebSocket.OPEN) return
    connection.sequence++
    connection.ws.send(JSON.stringify({ op, d, seq: connection.sequence }))
  }

  private handleConnection(ws: WebSocket): void {
    const connection: VoiceConnection = { ws, grant: null, ssrc: 0, secretKey: null, sequence: 0, stream: null, udp: null, sendNonce: 0 }
    this.connections.add(connection)
    this.send(connection, VoiceOpcodes.Hello, { v: 8, heartbeat_interval: 13_750 })
    ws.on('message', (raw, isBinary) => {
      // Binary frames are DAVE messages, never sent because DAVE is off.
      if (isBinary) return
      // JSON.parse returns unknown; VoiceSendPayload is what clients send.
      this.handleMessage(connection, JSON.parse(raw.toString()) as VoiceSendPayload)
    })
    ws.on('close', () => {
      this.connections.delete(connection)
      if (connection.stream) connection.stream.speaking = false
    })
  }

  private handleMessage(connection: VoiceConnection, payload: VoiceSendPayload): void {
    switch (payload.op) {
      case VoiceOpcodes.Identify: {
        const { server_id, user_id, session_id, token } = payload.d
        const grant = this.grants.get(token)
        // Discord checks that the token belongs to this exact guild, user and gateway session.
        if (!grant || grant.guildId !== server_id || grant.userId !== user_id || grant.sessionId !== session_id) {
          connection.ws.close(4004, 'Authentication failed')
          return
        }
        connection.grant = grant
        connection.ssrc = this.nextSsrc++
        this.send(connection, VoiceOpcodes.Ready, {
          ssrc: connection.ssrc,
          ip: '127.0.0.1',
          port: this.udpPort,
          modes: [VoiceEncryptionMode.AeadAes256GcmRtpSize],
          heartbeat_interval: 13_750,
        })
        return
      }
      case VoiceOpcodes.SelectProtocol: {
        if (!connection.grant) return
        if (payload.d.data.mode !== VoiceEncryptionMode.AeadAes256GcmRtpSize) {
          connection.ws.close(4016, 'Unknown encryption mode')
          return
        }
        connection.secretKey = crypto.randomBytes(32)
        this.send(connection, VoiceOpcodes.SessionDescription, {
          mode: VoiceEncryptionMode.AeadAes256GcmRtpSize,
          secret_key: [...connection.secretKey],
          dave_protocol_version: 0,
        })
        return
      }
      case VoiceOpcodes.Heartbeat: {
        this.send(connection, VoiceOpcodes.HeartbeatAck, { t: payload.d.t })
        return
      }
      case VoiceOpcodes.Speaking: {
        if (!connection.grant) return
        // Flags are a bitfield; 0 (no flag set) means the client stopped speaking.
        const stream = this.currentStream(connection)
        if (stream) stream.speaking = Number(payload.d.speaking) !== 0
        return
      }
    }
  }

  // UDP audio can arrive before the Speaking message, so either one opens the stream.
  // UDP can also arrive after Speaking off, so a stream lasts as long as the connection.
  private currentStream(connection: VoiceConnection): VoiceStream | null {
    const grant = connection.grant
    if (!grant) return null
    if (!connection.stream) {
      connection.stream = {
        guildId: grant.guildId,
        channelId: grant.channelId,
        userId: grant.userId,
        ssrc: connection.ssrc,
        opusPackets: [],
        speaking: false,
        lastPacketAt: 0,
      }
      this.streams.push(connection.stream)
    }
    return connection.stream
  }

  // A user speaks in a voice channel: every other client connected to that
  // channel gets Speaking (user_id -> ssrc) and then the opus frames as
  // encrypted RTP, like Discord forwards audio. `intervalMs` paces the frames
  // (20ms is real time); @discordjs/voice ends a receive stream after silence.
  async speak({
    guildId,
    channelId,
    userId,
    opusPackets,
    intervalMs = 20,
  }: {
    guildId: string
    channelId: string
    userId: string
    opusPackets: readonly Buffer[]
    intervalMs?: number
  }): Promise<void> {
    const listeners = [...this.connections].filter((connection) => {
      const grant = connection.grant
      return grant?.guildId === guildId && grant.channelId === channelId && grant.userId !== userId && connection.secretKey && connection.udp
    })
    if (listeners.length === 0) throw new Error(`No voice client listens in channel ${channelId}`)
    const ssrc = this.userSsrcs.get(userId) ?? this.nextSsrc++
    this.userSsrcs.set(userId, ssrc)
    for (const connection of listeners) {
      this.send(connection, VoiceOpcodes.Speaking, { user_id: userId, ssrc, speaking: 1 })
    }
    const start = { sequence: crypto.randomInt(0, 0xffff), timestamp: crypto.randomInt(0, 0xffffffff) }
    for (const [index, opus] of opusPackets.entries()) {
      for (const connection of listeners) {
        const { secretKey, udp } = connection
        if (!secretKey || !udp) continue
        connection.sendNonce = (connection.sendNonce + 1) >>> 0
        const packet = encryptRtpSize({
          opus,
          secretKey,
          nonce: connection.sendNonce,
          ssrc,
          sequence: (start.sequence + index) & 0xffff,
          timestamp: (start.timestamp + index * 960) >>> 0,
        })
        this.udp?.send(packet, udp.port, udp.address)
      }
      if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  private handleUdp(message: Buffer, remote: dgram.RemoteInfo): void {
    // IP discovery request: type 1, length 70, ssrc, 64 byte address, port.
    if (message.length === 74 && message.readUInt16BE(0) === 1) {
      const discovering = [...this.connections].find((candidate) => candidate.ssrc === message.readUInt32BE(4))
      if (discovering) discovering.udp = { address: remote.address, port: remote.port }
      const reply = Buffer.alloc(74)
      reply.writeUInt16BE(2, 0)
      reply.writeUInt16BE(70, 2)
      reply.writeUInt32BE(message.readUInt32BE(4), 4)
      reply.write(remote.address, 8, 'utf8')
      reply.writeUInt16BE(remote.port, 72)
      this.udp?.send(reply, remote.port, remote.address)
      return
    }
    // Keep-alive datagrams are 8 bytes. Audio is RTP version 2.
    if (message.length < RTP_HEADER_LENGTH + AUTH_TAG_LENGTH + NONCE_LENGTH || (message[0] ?? 0) >> 6 !== 2) return
    const ssrc = message.readUInt32BE(8)
    const connection = [...this.connections].find((candidate) => candidate.ssrc === ssrc)
    if (!connection?.secretKey) return
    const opus = decryptRtpSize({ packet: message, secretKey: connection.secretKey })
    const stream = this.currentStream(connection)
    if (!opus || !stream) return
    stream.opusPackets.push(opus)
    stream.lastPacketAt = Date.now()
  }
}

// RTP version 2, payload type 120 (opus), no extension. The header is the
// additional data; the 32 bit nonce counter goes after the auth tag.
function encryptRtpSize({
  opus,
  secretKey,
  nonce,
  ssrc,
  sequence,
  timestamp,
}: {
  opus: Buffer
  secretKey: Buffer
  nonce: number
  ssrc: number
  sequence: number
  timestamp: number
}): Buffer {
  const header = Buffer.alloc(RTP_HEADER_LENGTH)
  header[0] = 0x80
  header[1] = 0x78
  header.writeUInt16BE(sequence, 2)
  header.writeUInt32BE(timestamp, 4)
  header.writeUInt32BE(ssrc, 8)
  const nonceSuffix = Buffer.alloc(NONCE_LENGTH)
  nonceSuffix.writeUInt32BE(nonce, 0)
  const iv = Buffer.alloc(12)
  nonceSuffix.copy(iv, 0)
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv)
  cipher.setAAD(header)
  const encrypted = Buffer.concat([cipher.update(opus), cipher.final()])
  return Buffer.concat([header, encrypted, cipher.getAuthTag(), nonceSuffix])
}

// aead_aes256_gcm_rtpsize: the RTP header (and the 4 byte extension header, if
// any) is the additional data; the 32 bit nonce counter is appended at the end.
function decryptRtpSize({ packet, secretKey }: { packet: Buffer; secretKey: Buffer }): Buffer | null {
  const first = packet[0] ?? 0
  const csrcCount = first & 0x0f
  const hasExtension = (first & 0x10) !== 0
  let headerLength = RTP_HEADER_LENGTH + csrcCount * 4
  const extensionWords = hasExtension ? packet.readUInt16BE(headerLength + 2) : 0
  if (hasExtension) headerLength += 4
  const nonce = Buffer.alloc(12)
  packet.copy(nonce, 0, packet.length - NONCE_LENGTH)
  const ciphertextEnd = packet.length - NONCE_LENGTH - AUTH_TAG_LENGTH
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, nonce)
    decipher.setAAD(packet.subarray(0, headerLength))
    decipher.setAuthTag(packet.subarray(ciphertextEnd, ciphertextEnd + AUTH_TAG_LENGTH))
    const plain = Buffer.concat([decipher.update(packet.subarray(headerLength, ciphertextEnd)), decipher.final()])
    // The extension body is encrypted together with the payload.
    return plain.subarray(extensionWords * 4)
  } catch {
    return null
  }
}
