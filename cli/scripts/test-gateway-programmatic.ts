// Test script: start kimaki in --gateway mode programmatically, parse SSE events from stdout.
// Validates the non-TTY event flow: install_url → authorized → ready.
// Run with: npx tsx scripts/test-gateway-programmatic.ts

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createParser } from 'eventsource-parser'
import pc from 'picocolors'
import type { ProgrammaticEvent } from '../src/cli.js'

const eventColors: Record<ProgrammaticEvent['type'], (s: string) => string> = {
	install_url: pc.cyan,
	authorized: pc.green,
	ready: (s) => { return pc.bgGreen(pc.white(s)) },
	error: pc.red,
}

const eventLabels: Record<ProgrammaticEvent['type'], string> = {
	install_url: 'INSTALL URL',
	authorized: 'AUTHORIZED',
	ready: 'READY',
	error: 'ERROR',
}

function logEvent(event: ProgrammaticEvent): void {
	const color = eventColors[event.type]
	const label = eventLabels[event.type]
	const separator = pc.dim('─'.repeat(60))

	console.log(separator)
	console.log(color(pc.bold(` ${label} `)))
	console.log()

	switch (event.type) {
		case 'install_url': {
			console.log(`  ${pc.bold('Send this URL to the user:')}`)
			console.log(`  ${pc.cyan(event.url)}`)
			break
		}
		case 'authorized': {
			console.log(`  ${pc.bold('Guild ID:')} ${event.guild_id}`)
			break
		}
		case 'ready': {
			console.log(`  ${pc.bold('App ID:')}    ${event.app_id}`)
			console.log(`  ${pc.bold('Guild IDs:')} ${JSON.stringify(event.guild_ids)}`)
			break
		}
		case 'error': {
			console.log(`  ${pc.red(pc.bold(event.message))}`)
			if (event.install_url) {
				console.log(`  ${pc.dim('install_url:')} ${event.install_url}`)
			}
			break
		}
	}
	console.log(separator)
	console.log()
}

const tmpDir = path.join(
	process.cwd(),
	'tmp',
	`kimaki-gateway-test-${crypto.randomBytes(4).toString('hex')}`,
)
fs.mkdirSync(tmpDir, { recursive: true })

// Use a unique lock port to avoid conflicting with a running kimaki instance
const lockPort = 31100 + Math.floor(Math.random() * 900)

console.log(`${pc.dim('[test]')} data dir: ${pc.dim(tmpDir)}`)
console.log(`${pc.dim('[test]')} lock port: ${lockPort}`)
console.log(`${pc.dim('[test]')} spawning kimaki --gateway --data-dir <tmpDir>`)
console.log(`${pc.dim('[test]')} callback url: ${pc.cyan('https://example.com/kimaki-callback')}`)
console.log()

const child = spawn(
	'kimaki',
	[
		'--gateway',
		'--restart-onboarding',
		'--data-dir',
		tmpDir,
		'--gateway-callback-url',
		'https://example.com/kimaki-callback',
	],
	{
		env: {
			...process.env,
			KIMAKI_LOCK_PORT: String(lockPort),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	},
)

// Collect all parsed events for summary at the end
const receivedEvents: ProgrammaticEvent[] = []

const parser = createParser({
	onEvent(sseEvent) {
		try {
			const event = JSON.parse(sseEvent.data) as ProgrammaticEvent
			receivedEvents.push(event)
			logEvent(event)

			if (event.type === 'ready') {
				console.log(pc.bold(pc.green('EVENT SUMMARY')))
				console.log()
				for (const e of receivedEvents) {
					const color = eventColors[e.type]
					console.log(`  ${color(eventLabels[e.type].padEnd(12))} ${pc.dim(JSON.stringify(e))}`)
				}
				console.log()
				console.log(`${pc.dim('[test]')} killing child process, test complete`)
				child.kill('SIGTERM')
			}
		} catch {
			console.log(pc.red(`[sse] failed to parse event data: ${sseEvent.data}`))
		}
	},
})

child.stdout.on('data', (chunk: Buffer) => {
	const text = chunk.toString()
	// Feed raw stdout to the SSE parser — it extracts data: lines, ignores everything else
	parser.feed(text)

	// Also print raw stdout so we can see logs/noise interleaved
	for (const line of text.split('\n')) {
		if (line.trim()) {
			console.log(`${pc.dim('[stdout]')} ${pc.dim(line)}`)
		}
	}
})

child.stderr.on('data', (chunk: Buffer) => {
	const text = chunk.toString()
	for (const line of text.split('\n')) {
		if (line.trim()) {
			console.log(`${pc.yellow('[stderr]')} ${pc.dim(line)}`)
		}
	}
})

child.on('exit', (code, signal) => {
	console.log()
	console.log(`${pc.dim('[test]')} process exited with code=${code} signal=${signal}`)
	console.log(`${pc.dim('[test]')} total SSE events received: ${pc.bold(String(receivedEvents.length))}`)
	process.exit(0)
})

// Safety timeout: kill after 5 minutes
setTimeout(() => {
	console.log(pc.yellow('[test] timeout reached, killing process'))
	child.kill('SIGTERM')
}, 5 * 60 * 1000)
