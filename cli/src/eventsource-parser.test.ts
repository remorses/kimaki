// Experiment: test if eventsource-parser can extract `data:` lines from noisy process output
import { describe, expect, test } from 'vitest'
import { createParser, type EventSourceMessage } from 'eventsource-parser'

function parseSSEFromChunks(chunks: string[]): EventSourceMessage[] {
	const events: EventSourceMessage[] = []
	const parser = createParser({
		onEvent(event) {
			events.push(event)
		},
	})
	for (const chunk of chunks) {
		parser.feed(chunk)
	}
	return events
}

describe('eventsource-parser with noisy process output', () => {
	test('extracts data: json lines from garbage output', () => {
		const chunks = [
			'Starting server on port 3000...\n',
			'[INFO] Loading configuration\n',
			'WARNING: deprecated API usage detected\n',
			'data: {"type":"start","id":1}\n\n',
			'Compiling 42 modules...\n',
			'✓ Built in 1.2s\n',
			'[DEBUG] cache miss for key abc123\n',
			'data: {"type":"progress","percent":50}\n\n',
			'error: ENOENT /tmp/missing.txt (non-fatal, skipping)\n',
			'  at Object.openSync (node:fs:601:3)\n',
			'  at readFileSync (node:fs:469:35)\n',
			'data: {"type":"result","payload":{"name":"test","value":42}}\n\n',
			'Shutting down gracefully...\n',
			'[METRIC] requests=1024 latency_p99=12ms\n',
			'data: {"type":"end","id":4}\n\n',
		]

		const events = parseSSEFromChunks(chunks)
		const parsed = events.map((e) => {
			return JSON.parse(e.data)
		})
		expect(parsed).toMatchInlineSnapshot(`
			[
			  {
			    "id": 1,
			    "type": "start",
			  },
			  {
			    "percent": 50,
			    "type": "progress",
			  },
			  {
			    "payload": {
			      "name": "test",
			      "value": 42,
			    },
			    "type": "result",
			  },
			  {
			    "id": 4,
			    "type": "end",
			  },
			]
		`)
	})

	test('handles data: lines split across chunks', () => {
		const chunks = [
			'some garbage\n',
			'dat',
			'a: {"split":true}\n\n',
			'more garbage\n',
		]

		const events = parseSSEFromChunks(chunks)
		const parsed = events.map((e) => {
			return JSON.parse(e.data)
		})
		expect(parsed).toMatchInlineSnapshot(`
			[
			  {
			    "split": true,
			  },
			]
		`)
	})

	test('handles multi-line data fields', () => {
		const chunks = [
			'[LOG] something\n',
			'data: {"line":1}\n',
			'data: {"line":2}\n\n',
			'noise\n',
		]

		const events = parseSSEFromChunks(chunks)
		// multi-line data gets joined with newlines per SSE spec
		expect(events.map((e) => {
			return e.data
		})).toMatchInlineSnapshot(`
			[
			  "{"line":1}
			{"line":2}",
			]
		`)
	})

	test('ignores lines that look like data but are not SSE format', () => {
		const chunks = [
			'database: connection established\n',
			'data: {"real":"event"}\n\n',
			'datadir: /var/lib/app\n',
			'data:no-space-after-colon\n\n',
			'  data: indented-data-line\n\n',
		]

		const events = parseSSEFromChunks(chunks)
		expect(events.map((e) => {
			return e.data
		})).toMatchInlineSnapshot(`
			[
			  "{"real":"event"}",
			  "no-space-after-colon",
			]
		`)
	})

	test('data: in middle of a line', () => {
		const chunks = [
			'some prefix data: {"mid":true}\n\n',
			'the output is data: not this\n\n',
			'data: {"real":"event"}\n\n',
			'foo=bar data: {"also":"mid"} more stuff\n\n',
			'[2024-01-01] data: {"log":"entry"}\n\n',
		]

		const events = parseSSEFromChunks(chunks)
		expect(events.map((e) => {
			return e.data
		})).toMatchInlineSnapshot(`
			[
			  "{"real":"event"}",
			]
		`)
	})

	test('raw json without data: prefix', () => {
		const chunks = [
			'{"bare":"json"}\n\n',
			'data: {"real":"event"}\n\n',
			'some text {"embedded":"json"} more text\n\n',
			'{"start":"of line"} trailing\n\n',
			'  {"indented":"json"}\n\n',
			'[{"array":"json"},{"second":"obj"}]\n\n',
			'data: {"second":"real"}\n\n',
		]

		const events = parseSSEFromChunks(chunks)
		expect(events.map((e) => {
			return e.data
		})).toMatchInlineSnapshot(`
			[
			  "{"real":"event"}",
			  "{"second":"real"}",
			]
		`)
	})

	test('other SSE fields from process noise pollute event metadata', () => {
		const chunks = [
			// process outputs that happen to match SSE field names
			'id: proc-12345\n',
			'event: error\n',
			'retry: 5000\n',
			': this is a comment\n',
			'data: {"real":"payload"}\n\n',
		]

		const events = parseSSEFromChunks(chunks)
		// check if the garbage id:/event: lines leaked into the real event
		expect(events.map((e) => {
			return { data: e.data, id: e.id, event: e.event }
		})).toMatchInlineSnapshot(`
			[
			  {
			    "data": "{"real":"payload"}",
			    "event": "error",
			    "id": "proc-12345",
			  },
			]
		`)
	})

	test('event: between two data events only affects the next one', () => {
		const chunks = [
			'data: {"first":"clean"}\n\n',
			'event: contaminated\n',
			'data: {"second":"dirty?"}\n\n',
			'data: {"third":"clean again?"}\n\n',
		]

		const events = parseSSEFromChunks(chunks)
		expect(events.map((e) => {
			return { data: e.data, event: e.event }
		})).toMatchInlineSnapshot(`
			[
			  {
			    "data": "{"first":"clean"}",
			    "event": undefined,
			  },
			  {
			    "data": "{"second":"dirty?"}",
			    "event": "contaminated",
			  },
			  {
			    "data": "{"third":"clean again?"}",
			    "event": undefined,
			  },
			]
		`)
	})

	test('id: from noise persists across events', () => {
		const chunks = [
			'data: {"before":"id"}\n\n',
			'id: noise-id-999\n',
			'data: {"after":"id"}\n\n',
			'data: {"later":"event"}\n\n',
		]

		const events = parseSSEFromChunks(chunks)
		expect(events.map((e) => {
			return { data: e.data, id: e.id }
		})).toMatchInlineSnapshot(`
			[
			  {
			    "data": "{"before":"id"}",
			    "id": undefined,
			  },
			  {
			    "data": "{"after":"id"}",
			    "id": "noise-id-999",
			  },
			  {
			    "data": "{"later":"event"}",
			    "id": undefined,
			  },
			]
		`)
	})

	test('realistic process output with dangerous prefixes', () => {
		const chunks = [
			'event loop blocked for 200ms\n',
			'id: user-abc logged in\n',
			'retry after 3 attempts\n',
			'data: {"safe":"event"}\n\n',
			'identifier: session-xyz\n',
			'eventually consistent\n',
			'retrying connection...\n',
			'data: {"second":"event"}\n\n',
		]

		const events = parseSSEFromChunks(chunks)
		expect(events.map((e) => {
			return { data: e.data, id: e.id, event: e.event }
		})).toMatchInlineSnapshot(`
			[
			  {
			    "data": "{"safe":"event"}",
			    "event": undefined,
			    "id": "user-abc logged in",
			  },
			  {
			    "data": "{"second":"event"}",
			    "event": undefined,
			    "id": undefined,
			  },
			]
		`)
	})

	test('works with rapid interleaved garbage and data', () => {
		const garbage = [
			'0x7fff5fbff8c0',
			'Segfault at 0xDEADBEEF (just kidding)',
			'█████████░░░░ 65%',
			'🔥 hot reload triggered',
			'npm warn deprecated lodash@3.0.0',
		]
		const jsonPayloads = Array.from({ length: 10 }, (_, i) => {
			return { seq: i, ts: 1000 + i }
		})

		const chunks = jsonPayloads.flatMap((payload, i) => {
			return [
				`${garbage[i % garbage.length]}\n`,
				`data: ${JSON.stringify(payload)}\n\n`,
			]
		})

		const events = parseSSEFromChunks(chunks)
		const parsed = events.map((e) => {
			return JSON.parse(e.data)
		})
		expect(parsed).toMatchInlineSnapshot(`
			[
			  {
			    "seq": 0,
			    "ts": 1000,
			  },
			  {
			    "seq": 1,
			    "ts": 1001,
			  },
			  {
			    "seq": 2,
			    "ts": 1002,
			  },
			  {
			    "seq": 3,
			    "ts": 1003,
			  },
			  {
			    "seq": 4,
			    "ts": 1004,
			  },
			  {
			    "seq": 5,
			    "ts": 1005,
			  },
			  {
			    "seq": 6,
			    "ts": 1006,
			  },
			  {
			    "seq": 7,
			    "ts": 1007,
			  },
			  {
			    "seq": 8,
			    "ts": 1008,
			  },
			  {
			    "seq": 9,
			    "ts": 1009,
			  },
			]
		`)
	})
})
