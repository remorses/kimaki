import { describe, test, expect } from 'vitest'
import goke, { createConsole } from '../index.js'
import type { GokeOutputStream, GokeOptions } from '../index.js'
import { coerceBySchema } from '../coerce.js'
import { z } from 'zod'

const ANSI_RE = /\x1B\[[0-9;]*m/g

const stripAnsi = (text: string) => text.replace(ANSI_RE, '')

/**
 * Helper: creates a GokeOutputStream that captures all written data into a string array.
 * Access `output.lines` for raw writes, or `output.text` for the joined result.
 */
function createTestOutputStream(): GokeOutputStream & { lines: string[]; readonly text: string } {
  const lines: string[] = []
  return {
    lines,
    get text() { return stripAnsi(lines.join('')) },
    write(data: string) { lines.push(data) },
  }
}

/**
 * Helper: creates a goke instance with exit overridden to a no-op.
 * This prevents process.exit(1) from killing the test runner while
 * still allowing the original error to propagate (the framework
 * re-throws after calling exit when exit doesn't halt execution).
 *
 * It also defaults stdout/stderr to in-memory streams, so expected
 * error-path tests don't spam Vitest output with stack traces.
 *
 * Tests can still use .toThrow() to assert CLI errors normally.
 */
function gokeTestable(name = '', options?: Partial<GokeOptions>) {
  const stdout = options?.stdout ?? createTestOutputStream()
  const stderr = options?.stderr ?? createTestOutputStream()
  return goke(name, {
    ...options,
    stdout,
    stderr,
    exit: () => {},
  })
}

/**
 * Strip stack trace lines for stable snapshots.
 * Keeps the error message and help hint, removes all "    at ..." lines
 * and the blank line before them, since those contain machine-specific paths.
 */
function stripStackTrace(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.match(/^\s+at /))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

describe('error formatting', () => {
  test('unknown option prints formatted error to stderr', () => {
    const stderr = createTestOutputStream()
    const cli = goke('mycli', { stderr, exit: () => {} })

    cli
      .command('build', 'Build your app')
      .option('--port <port>', 'Port')
      .action(() => {})

    try {
      cli.parse('node bin build --unknown'.split(' '))
    } catch {}

    expect(stripStackTrace(stderr.text)).toMatchInlineSnapshot(`"error: Unknown option \`--unknown\`"`)
  })

  test('missing required option value prints formatted error to stderr', () => {
    const stderr = createTestOutputStream()
    const cli = goke('mycli', { stderr, exit: () => {} })

    cli
      .command('serve', 'Start server')
      .option('--port <port>', 'Port')
      .action(() => {})

    try {
      cli.parse('node bin serve --port'.split(' '))
    } catch {}

    expect(stripStackTrace(stderr.text)).toMatchInlineSnapshot(`"error: option \`--port <port>\` value is missing"`)
  })

  test('schema coercion error prints formatted error to stderr', () => {
    const stderr = createTestOutputStream()
    const cli = goke('mycli', { stderr, exit: () => {} })

    cli.option('--port <port>', z.number().describe('Port'))

    try {
      cli.parse('node bin --port abc'.split(' '))
    } catch {}

    expect(stripStackTrace(stderr.text)).toMatchInlineSnapshot(`"error: Invalid value for --port: expected number, got "abc""`)
  })

  test('error includes help hint when help is enabled', () => {
    const stderr = createTestOutputStream()
    const cli = goke('mycli', { stderr, exit: () => {} })

    cli.help()

    cli
      .command('serve', 'Start server')
      .option('--port <port>', 'Port')
      .action(() => {})

    try {
      cli.parse('node bin serve --port'.split(' '))
    } catch {}

    expect(stripStackTrace(stderr.text)).toMatchInlineSnapshot(`
      "error: option \`--port <port>\` value is missing
      Run "mycli serve --help" for usage information."
    `)
  })

  test('async action error prints formatted error to stderr', async () => {
    const stderr = createTestOutputStream()
    let exitCode: number | undefined
    const cli = goke('mycli', { stderr, exit: (code) => { exitCode = code } })

    cli
      .command('deploy', 'Deploy app')
      .action(async () => {
        throw new Error('connection refused')
      })

    cli.parse('node bin deploy'.split(' '))

    // Wait for the async rejection to be handled
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(exitCode).toBe(1)
    expect(stripStackTrace(stderr.text)).toMatchInlineSnapshot(`"error: connection refused"`)
  })

  test('error output includes stack trace', () => {
    const stderr = createTestOutputStream()
    const cli = goke('mycli', { stderr, exit: () => {} })

    cli
      .command('build', 'Build app')
      .action(() => {})

    try {
      cli.parse('node bin build --unknown'.split(' '))
    } catch {}

    // Verify that stderr contains "error:" prefix and a stack trace with "at" lines
    const text = stderr.text
    expect(text).toContain('error:')
    expect(text).toContain('Unknown option `--unknown`')
    expect(text).toMatch(/at /)
  })
})

test('double dashes', () => {
  const cli = goke()

  const { args, options } = cli.parse([
    'node',
    'bin',
    'foo',
    'bar',
    '--',
    'npm',
    'test',
  ])

  expect(args).toEqual(['foo', 'bar'])
  expect(options['--']).toEqual(['npm', 'test'])
})

test('dot-nested options', () => {
  const cli = goke()

  cli
    .option('--externals <external>', 'Add externals')
    .option('--scale [level]', 'Scaling level')

  const { options: options1 } = cli.parse(
    `node bin --externals.env.prod production --scale`.split(' ')
  )
  expect(options1.externals).toEqual({ env: { prod: 'production' } })
  expect(options1.scale).toEqual(true)
})

describe('schema-based options', () => {
  test('schema coerces string to number', () => {
    const cli = goke()

    cli.option('--port <port>', z.number().describe('Port number'))

    const { options } = cli.parse('node bin --port 3000'.split(' '))
    expect(options.port).toBe(3000)
    expect(typeof options.port).toBe('number')
  })

  test('schema preserves string (no auto-conversion to number)', () => {
    const cli = goke()

    cli.option('--id <id>', z.string().describe('ID'))

    const { options } = cli.parse('node bin --id 00123'.split(' '))
    expect(options.id).toBe('00123')
    expect(typeof options.id).toBe('string')
  })

  test('schema coerces string to integer', () => {
    const cli = goke()

    cli.option('--count <count>', z.int().describe('Count'))

    const { options } = cli.parse('node bin --count 42'.split(' '))
    expect(options.count).toBe(42)
  })

  test('schema parses JSON object', () => {
    const cli = goke()

    cli.option('--config <config>', z.looseObject({}).describe('Config'))

    const { options } = cli.parse(['node', 'bin', '--config', '{"a":1}'])
    expect(options.config).toEqual({ a: 1 })
  })

  test('schema parses JSON array', () => {
    const cli = goke()

    cli.option('--items <items>', z.array(z.unknown()).describe('Items'))

    const { options } = cli.parse(['node', 'bin', '--items', '[1,2,3]'])
    expect(options.items).toEqual([1, 2, 3])
  })

  test('schema throws on invalid number', () => {
    const cli = gokeTestable()

    cli.option('--port <port>', z.number().describe('Port number'))

    expect(() => cli.parse('node bin --port abc'.split(' ')))
      .toThrow('expected number, got "abc"')
  })

  test('schema with union type ["number", "string"]', () => {
    const cli = goke()

    cli.option('--val <val>', z.union([z.number(), z.string()]).describe('Value'))

    const { options: opts1 } = cli.parse('node bin --val 123'.split(' '))
    expect(opts1.val).toBe(123)

    const { options: opts2 } = cli.parse('node bin --val abc'.split(' '))
    expect(opts2.val).toBe('abc')
  })

  test('options without schema keep values as strings', () => {
    const cli = goke()

    cli.option('--port <port>', 'Port number')

    // Without schema, mri no longer auto-converts — value stays as string.
    // Use a schema to get typed values.
    const { options } = cli.parse('node bin --port 3000'.split(' '))
    expect(options.port).toBe('3000')
    expect(typeof options.port).toBe('string')
  })

  test('schema with default value', () => {
    const cli = goke()

    cli.option('--port [port]', z.number().default(8080).describe('Port number'))

    const { options } = cli.parse('node bin'.split(' '))
    expect(options.port).toBe(8080)
  })

  test('schema on subcommand options', () => {
    const cli = goke()
    let result: any = {}

    cli
      .command('serve', 'Start server')
      .option('--port <port>', z.number().describe('Port'))
      .option('--host <host>', z.string().describe('Host'))
      .action((options) => {
        result = options
      })

    cli.parse('node bin serve --port 3000 --host localhost'.split(' '), { run: true })
    expect(result.port).toBe(3000)
    expect(result.host).toBe('localhost')
  })
})

describe('no-schema behavior (mri no longer auto-converts)', () => {
  test('numeric string stays as string without schema', () => {
    const cli = goke()
    cli.option('--port <port>', 'Port')
    const { options } = cli.parse('node bin --port 3000'.split(' '))
    expect(options.port).toBe('3000')
  })

  test('leading zeros preserved without schema', () => {
    const cli = goke()
    cli.option('--id <id>', 'ID')
    const { options } = cli.parse('node bin --id 00123'.split(' '))
    expect(options.id).toBe('00123')
  })

  test('phone number preserved without schema', () => {
    const cli = goke()
    cli.option('--phone <phone>', 'Phone')
    const { options } = cli.parse('node bin --phone +1234567890'.split(' '))
    expect(options.phone).toBe('+1234567890')
  })

  test('boolean flags still work without schema', () => {
    const cli = goke()
    cli.option('--verbose', 'Verbose')
    const { options } = cli.parse('node bin --verbose'.split(' '))
    expect(options.verbose).toBe(true)
  })

  test('optional value flag returns true when no value given', () => {
    const cli = goke()
    cli.option('--format [fmt]', 'Format')
    const { options } = cli.parse('node bin --format'.split(' '))
    expect(options.format).toBe(true)
  })

  test('optional value flag returns string when value given', () => {
    const cli = goke()
    cli.option('--format [fmt]', 'Format')
    const { options } = cli.parse('node bin --format json'.split(' '))
    expect(options.format).toBe('json')
  })

  test('hex string stays as string without schema', () => {
    const cli = goke()
    cli.option('--color <color>', 'Color')
    const { options } = cli.parse('node bin --color 0xff00ff'.split(' '))
    expect(options.color).toBe('0xff00ff')
  })

  test('scientific notation stays as string without schema', () => {
    const cli = goke()
    cli.option('--val <val>', 'Value')
    const { options } = cli.parse('node bin --val 1e10'.split(' '))
    expect(options.val).toBe('1e10')
  })
})

describe('typical CLI usage examples', () => {
  test('web server CLI with typed options', () => {
    const cli = goke('myserver')
    let config: any = {}

    cli
      .command('start', 'Start the web server')
      .option('--port <port>', z.number().default(3000).describe('Port to listen on'))
      .option('--host <host>', z.string().default('localhost').describe('Hostname to bind'))
      .option('--workers <workers>', z.int().describe('Number of worker threads'))
      .option('--cors', 'Enable CORS')
      .option('--log', 'Enable logging')
      .action((options) => { config = options })

    cli.parse('node bin start --port 8080 --host 0.0.0.0 --workers 4 --cors'.split(' '), { run: true })

    expect(config.port).toBe(8080)
    expect(typeof config.port).toBe('number')
    expect(config.host).toBe('0.0.0.0')
    expect(config.workers).toBe(4)
    expect(typeof config.workers).toBe('number')
    expect(config.cors).toBe(true)
  })

  test('web server CLI with defaults (no args)', () => {
    const cli = goke('myserver')
    let config: any = {}

    cli
      .command('start', 'Start the web server')
      .option('--port [port]', z.number().default(3000).describe('Port'))
      .option('--host [host]', z.string().default('localhost').describe('Host'))
      .action((options) => { config = options })

    cli.parse('node bin start'.split(' '), { run: true })

    expect(config.port).toBe(3000)
    expect(config.host).toBe('localhost')
  })

  test('database CLI with JSON config option', () => {
    const cli = goke('dbcli')
    let config: any = {}

    cli
      .command('migrate', 'Run database migrations')
      .option('--connection <conn>', z.object({ host: z.string(), port: z.number() }).describe('Connection config (JSON)'))
      .option('--dry-run', 'Preview without executing')
      .action((options) => { config = options })

    cli.parse(['node', 'bin', 'migrate', '--connection', '{"host":"localhost","port":5432}', '--dry-run'], { run: true })

    expect(config.connection).toEqual({ host: 'localhost', port: 5432 })
    expect(config.dryRun).toBe(true)
  })

  test('file processing CLI with positional args + typed options', () => {
    const cli = goke('fileproc')
    let result: any = {}

    cli
      .command('convert <input> <output>', 'Convert file format')
      .option('--quality <quality>', z.int().describe('Quality (0-100)'))
      .option('--format <format>', z.enum(['png', 'jpg', 'webp']).describe('Output format'))
      .action((input, output, options) => {
        result = { input, output, ...options }
      })

    cli.parse('node bin convert photo.bmp photo.jpg --quality 85 --format jpg'.split(' '), { run: true })

    expect(result.input).toBe('photo.bmp')
    expect(result.output).toBe('photo.jpg')
    expect(result.quality).toBe(85)
    expect(typeof result.quality).toBe('number')
    expect(result.format).toBe('jpg')
  })

  test('API client CLI preserving string IDs', () => {
    const cli = goke('apicli')
    let result: any = {}

    cli
      .command('get-user <userId>', 'Get user by ID')
      .option('--fields <fields>', z.array(z.unknown()).describe('Fields to return (JSON array)'))
      .action((userId, options) => {
        result = { userId, ...options }
      })

    // userId "00123" should NOT be coerced to number 123
    cli.parse(['node', 'bin', 'get-user', '00123', '--fields', '["name","email"]'], { run: true })

    expect(result.userId).toBe('00123')
    expect(result.fields).toEqual(['name', 'email'])
  })

  test('nullable option with union type', () => {
    const cli = goke()
    cli.option('--timeout <timeout>', z.nullable(z.number()).describe('Timeout'))

    const { options: opts1 } = cli.parse('node bin --timeout 5000'.split(' '))
    expect(opts1.timeout).toBe(5000)

    // Empty string coerces to null for null type
    const { options: opts2 } = cli.parse(['node', 'bin', '--timeout', ''])
    expect(opts2.timeout).toBe(null)
  })
})

describe('regression: oracle-found issues', () => {
  test('required option with schema still throws when value missing', () => {
    const cli = gokeTestable()
    let actionCalled = false

    cli
      .command('serve', 'Start server')
      .option('--port <port>', z.number().describe('Port'))
      .action(() => { actionCalled = true })

    // --port without a value should throw "value is missing"
    expect(() => {
      cli.parse('node bin serve --port'.split(' '), { run: true })
    }).toThrow('value is missing')
    expect(actionCalled).toBe(false)
  })

  test('repeated flags with non-array schema throws', () => {
    const cli = gokeTestable()

    cli.option('--tag <tag>', z.string().describe('Tags'))

    expect(() => cli.parse('node bin --tag foo --tag bar'.split(' ')))
      .toThrow('does not accept multiple values')
  })

  test('repeated flags with number schema throws', () => {
    const cli = gokeTestable()

    cli.option('--id <id>', z.number().describe('ID'))

    expect(() => cli.parse('node bin --id 1 --id 2'.split(' ')))
      .toThrow('does not accept multiple values')
  })

  test('repeated flags with array schema collects values', () => {
    const cli = goke()

    cli.option('--tag <tag>', z.array(z.string()).describe('Tags'))

    const { options } = cli.parse('node bin --tag foo --tag bar'.split(' '))
    expect(options.tag).toEqual(['foo', 'bar'])
  })

  test('repeated flags with array+items schema coerces each element', () => {
    const cli = goke()

    cli.option('--id <id>', z.array(z.number()).describe('IDs'))

    const { options } = cli.parse('node bin --id 1 --id 2 --id 3'.split(' '))
    expect(options.id).toEqual([1, 2, 3])
  })

  test('single value with array schema wraps in array', () => {
    const cli = goke()

    cli.option('--tag <tag>', z.array(z.string()).describe('Tags'))

    const { options } = cli.parse('node bin --tag foo'.split(' '))
    expect(options.tag).toEqual(['foo'])
  })

  test('single value with array+number items schema wraps and coerces', () => {
    const cli = goke()

    cli.option('--id <id>', z.array(z.number()).describe('IDs'))

    const { options } = cli.parse('node bin --id 42'.split(' '))
    expect(options.id).toEqual([42])
  })

  test('JSON array string with array schema parses correctly', () => {
    const cli = goke()

    cli.option('--ids <ids>', z.array(z.number()).describe('IDs'))

    const { options } = cli.parse(['node', 'bin', '--ids', '[1,2,3]'])
    expect(options.ids).toEqual([1, 2, 3])
  })

  test('repeated flags without schema still produce array (no schema = no restriction)', () => {
    const cli = goke()

    cli.option('--tag <tag>', 'Tags')

    const { options } = cli.parse('node bin --tag foo --tag bar'.split(' '))
    expect(options.tag).toEqual(['foo', 'bar'])
  })

  test('const null coercion works', () => {
    expect(coerceBySchema('', { const: null }, 'val')).toBe(null)
  })

  test('optional value option with schema returns undefined when no value given', () => {
    const cli = goke()

    cli.option('--count [count]', z.number().describe('Count'))

    // --count without value → schema expects number, none given → undefined
    const { options } = cli.parse('node bin --count'.split(' '))
    expect(options.count).toBe(undefined)
  })

  test('optional value option without schema preserves true sentinel', () => {
    const cli = goke()

    cli.option('--count [count]', 'Count')

    // Without schema, original goke behavior: true means "flag present"
    const { options } = cli.parse('node bin --count'.split(' '))
    expect(options.count).toBe(true)
  })

  test('optional value option with schema coerces when value given', () => {
    const cli = goke()

    cli.option('--count [count]', z.number().describe('Count'))

    const { options } = cli.parse('node bin --count 42'.split(' '))
    expect(options.count).toBe(42)
  })

  test('alias + schema coercion works', () => {
    const cli = goke()

    cli.option('-p, --port <port>', z.number().describe('Port'))

    const { options } = cli.parse('node bin -p 3000'.split(' '))
    expect(options.port).toBe(3000)
    expect(options.p).toBe(3000)
  })

  test('union type ["array", "null"] with repeated flags', () => {
    const cli = goke()

    cli.option('--tags <tags>', z.nullable(z.array(z.string())).describe('Tags'))

    const { options } = cli.parse('node bin --tags foo --tags bar'.split(' '))
    expect(options.tags).toEqual(['foo', 'bar'])
  })
})

describe('edge cases: schema + defaults interaction', () => {
  test('default value from schema is used when option not passed', () => {
    const cli = goke()

    cli.option('--port [port]', z.number().default(8080).describe('Port'))

    const { options } = cli.parse('node bin'.split(' '))
    expect(options.port).toBe(8080)
  })

  test('default value is used when option not passed, schema value when passed', () => {
    const cli = goke()

    cli.option('--port [port]', z.number().default(8080).describe('Port'))

    const { options: opts1 } = cli.parse('node bin'.split(' '))
    expect(opts1.port).toBe(8080)

    const { options: opts2 } = cli.parse('node bin --port 3000'.split(' '))
    expect(opts2.port).toBe(3000)
  })

  test('optional value + default + schema: three-way interaction', () => {
    const cli = goke()

    cli.option('--count [count]', z.number().default(10).describe('Count'))

    // Not passed at all → default
    const { options: opts1 } = cli.parse('node bin'.split(' '))
    expect(opts1.count).toBe(10)

    // Passed with value → coerced
    const { options: opts2 } = cli.parse('node bin --count 42'.split(' '))
    expect(opts2.count).toBe(42)

    // Passed without value → undefined (sentinel replaced)
    const { options: opts3 } = cli.parse('node bin --count'.split(' '))
    expect(opts3.count).toBe(undefined)
  })
})

describe('edge cases: boolean flags + schema', () => {
  test('boolean flag (no brackets) with number schema — mri returns boolean', () => {
    const cli = goke()

    // This is a questionable usage: boolean flag + number schema
    // mri returns true/false for boolean flags, schema tries to coerce boolean→number
    cli.option('--verbose', z.number().describe('Verbose'))

    const { options } = cli.parse('node bin --verbose'.split(' '))
    // Boolean true → coerced to 1 by number schema
    expect(options.verbose).toBe(1)
  })

  test('boolean string value with boolean schema on value option', () => {
    const cli = goke()

    cli.option('--flag <flag>', z.boolean().describe('A flag'))

    const { options: opts1 } = cli.parse('node bin --flag true'.split(' '))
    expect(opts1.flag).toBe(true)

    const { options: opts2 } = cli.parse('node bin --flag false'.split(' '))
    expect(opts2.flag).toBe(false)
  })

  test('invalid boolean string with boolean schema throws', () => {
    const cli = gokeTestable()

    cli.option('--flag <flag>', z.boolean().describe('A flag'))

    expect(() => cli.parse('node bin --flag yes'.split(' ')))
      .toThrow('expected true or false')
  })
})

describe('edge cases: dot-nested options + schema', () => {
  test('dot-nested option with number schema coerces value', () => {
    const cli = goke()

    cli.option('--config.port <port>', z.number().describe('Port'))

    const { options } = cli.parse('node bin --config.port 3000'.split(' '))
    expect(options.config).toEqual({ port: 3000 })
  })

  test('dot-nested default uses nested object shape', () => {
    const cli = goke()

    cli.option('--config.port [port]', z.number().default(8080).describe('Port'))

    const { options } = cli.parse('node bin'.split(' '))
    expect(options.config).toEqual({ port: 8080 })
  })
})

describe('edge cases: kebab-case + schema', () => {
  test('kebab-case option coerced via schema and accessible as camelCase', () => {
    const cli = goke()

    cli.option('--max-retries <count>', z.number().describe('Max retries'))

    const { options } = cli.parse('node bin --max-retries 5'.split(' '))
    expect(options.maxRetries).toBe(5)
    expect(typeof options.maxRetries).toBe('number')
  })
})

describe('edge cases: empty string values', () => {
  test('empty string with string schema stays empty string', () => {
    const cli = goke()

    cli.option('--name <name>', z.string().describe('Name'))

    const { options } = cli.parse(['node', 'bin', '--name', ''])
    expect(options.name).toBe('')
  })

  test('empty string with number schema throws', () => {
    const cli = gokeTestable()

    cli.option('--port <port>', z.number().describe('Port'))

    expect(() => cli.parse(['node', 'bin', '--port', '']))
      .toThrow('expected number, got empty string')
  })

  test('empty string with nullable number schema returns null', () => {
    const cli = goke()

    cli.option('--timeout <timeout>', z.nullable(z.number()).describe('Timeout'))

    const { options } = cli.parse(['node', 'bin', '--timeout', ''])
    expect(options.timeout).toBe(null)
  })
})

describe('edge cases: global options with schema in subcommands', () => {
  test('global option schema applies to subcommand parsing', () => {
    const cli = goke()
    let result: any = {}

    cli.option('--port <port>', z.number().describe('Port'))

    cli
      .command('serve', 'Start server')
      .action((options) => { result = options })

    cli.parse('node bin serve --port 3000'.split(' '), { run: true })
    expect(result.port).toBe(3000)
    expect(typeof result.port).toBe('number')
  })
})

describe('edge cases: short alias + schema', () => {
  test('short alias repeated with array schema', () => {
    const cli = goke()

    cli.option('-t, --tag <tag>', z.array(z.string()).describe('Tags'))

    const { options } = cli.parse('node bin -t foo -t bar'.split(' '))
    expect(options.tag).toEqual(['foo', 'bar'])
    expect(options.t).toEqual(['foo', 'bar'])
  })

  test('short alias single value with array schema wraps', () => {
    const cli = goke()

    cli.option('-t, --tag <tag>', z.array(z.string()).describe('Tags'))

    const { options } = cli.parse('node bin -t foo'.split(' '))
    expect(options.tag).toEqual(['foo'])
  })

  test('short alias with number schema coerces', () => {
    const cli = goke()

    cli.option('-p, --port <port>', z.number().describe('Port'))

    const { options } = cli.parse('node bin -p 8080'.split(' '))
    expect(options.port).toBe(8080)
    expect(options.p).toBe(8080)
  })

  test('short alias repeated with non-array schema throws', () => {
    const cli = gokeTestable()

    cli.option('-p, --port <port>', z.number().describe('Port'))

    expect(() => cli.parse('node bin -p 3000 -p 4000'.split(' ')))
      .toThrow('does not accept multiple values')
  })
})

test('throw on unknown options', () => {
  const cli = gokeTestable()

  cli
    .command('build [entry]', 'Build your app')
    .option('--foo-bar', 'foo bar')
    .option('--aB', 'ab')
    .action(() => {})

  expect(() => {
    cli.parse(`node bin build app.js --fooBar --a-b --xx`.split(' '))
  }).toThrowError('Unknown option `--xx`')
})

describe('space-separated subcommands', () => {
  test('basic subcommand matching', () => {
    const cli = goke()
    let matched = ''

    cli.command('mcp login', 'Login to MCP').action(() => {
      matched = 'mcp login'
    })

    cli.parse(['node', 'bin', 'mcp', 'login'], { run: true })
    expect(matched).toBe('mcp login')
    expect(cli.matchedCommandName).toBe('mcp login')
  })

  test('subcommand with positional args', () => {
    const cli = goke()
    let receivedId = ''

    cli.command('mcp getNodeXml <id>', 'Get XML for a node').action((id) => {
      receivedId = id
    })

    cli.parse(['node', 'bin', 'mcp', 'getNodeXml', '123'], { run: true })
    expect(receivedId).toBe('123')
    expect(cli.matchedCommandName).toBe('mcp getNodeXml')
  })

  test('subcommand with options', () => {
    const cli = goke()
    let result: any = {}

    cli
      .command('mcp export <id>', 'Export something')
      .option('--format <format>', 'Output format')
      .action((id, options) => {
        result = { id, format: options.format }
      })

    cli.parse(['node', 'bin', 'mcp', 'export', 'abc', '--format', 'json'], {
      run: true,
    })
    expect(result).toEqual({ id: 'abc', format: 'json' })
  })

  test('greedy matching - longer commands match first', () => {
    const cli = goke()
    let matched = ''

    cli.command('mcp', 'MCP base command').action(() => {
      matched = 'mcp'
    })

    cli.command('mcp login', 'Login to MCP').action(() => {
      matched = 'mcp login'
    })

    cli.parse(['node', 'bin', 'mcp', 'login'], { run: true })
    expect(matched).toBe('mcp login')
  })

  test('three-level subcommand', () => {
    const cli = goke()
    let matched = ''

    cli.command('git remote add', 'Add a remote').action(() => {
      matched = 'git remote add'
    })

    cli.parse(['node', 'bin', 'git', 'remote', 'add'], { run: true })
    expect(matched).toBe('git remote add')
    expect(cli.matchedCommandName).toBe('git remote add')
  })

  test('single-word commands still work (backward compatibility)', () => {
    const cli = goke()
    let matched = ''

    cli.command('build', 'Build the project').action(() => {
      matched = 'build'
    })

    cli.parse(['node', 'bin', 'build'], { run: true })
    expect(matched).toBe('build')
    expect(cli.matchedCommandName).toBe('build')
  })

  test('subcommand does not match when args are insufficient', () => {
    const cli = goke()
    let matched = ''

    cli.command('mcp login', 'Login to MCP').action(() => {
      matched = 'mcp login'
    })

    cli.command('mcp', 'MCP base').action(() => {
      matched = 'mcp base'
    })

    cli.parse(['node', 'bin', 'mcp'], { run: true })
    expect(matched).toBe('mcp base')
  })

  test('default command should not match if args are prefix of another command', () => {
    const cli = goke()
    let matched = ''

    cli.command('mcp login', 'Login to MCP').action(() => {
      matched = 'mcp login'
    })

    cli.command('', 'Default command').action(() => {
      matched = 'default'
    })

    cli.parse(['node', 'bin', 'mcp'], { run: true })
    expect(matched).toBe('')
    expect(cli.matchedCommand).toBeUndefined()
  })

  test('default command should match when args do not prefix any command', () => {
    const cli = goke()
    let matched = ''
    let receivedArg = ''

    cli.command('mcp login', 'Login to MCP').action(() => {
      matched = 'mcp login'
    })

    cli.command('<file>', 'Default command').action((file) => {
      matched = 'default'
      receivedArg = file
    })

    cli.parse(['node', 'bin', 'foo'], { run: true })
    expect(matched).toBe('default')
    expect(receivedArg).toBe('foo')
  })

  test('help output with subcommands', () => {
    let output = ''
    const cli = goke('mycli', {
      stdout: { write(data) { output += data } },
    })

    cli.command('mcp login <url>', 'Login to MCP server')
    cli.command('mcp logout', 'Logout from MCP server')
    cli.command('mcp status', 'Show connection status')
    cli.command('git remote add <name> <url>', 'Add a git remote')
    cli.command('git remote remove <name>', 'Remove a git remote')
    cli.command('build', 'Build the project').option('--watch', 'Watch mode')

    cli.help()
    // parse with --help triggers outputHelp() internally, which writes to our captured stdout
    cli.parse(['node', 'bin', '--help'], { run: false })

    expect(stripAnsi(output)).toMatchInlineSnapshot(`
      "mycli


      Usage:
        $ mycli <command> [options]


      Commands:
        mcp login <url>              Login to MCP server


        mcp logout                   Logout from MCP server


        mcp status                   Show connection status


        git remote add <name> <url>  Add a git remote


        git remote remove <name>     Remove a git remote


        build                        Build the project

          --watch                    Watch mode


      Options:
        -h, --help  Display this message
      "
    `)
  })

  test('unknown subcommand shows filtered help for prefix', () => {
    let output = ''
    const cli = goke('mycli', {
      stdout: { write(data) { output += data } },
    })

    cli.command('mcp login', 'Login to MCP')
    cli.command('mcp logout', 'Logout from MCP')
    cli.command('mcp status', 'Show status')
    cli.command('build', 'Build project')

    cli.help()

    // User types "mcp nonexistent" - should show help for mcp commands
    cli.parse(['node', 'bin', 'mcp', 'nonexistent'], { run: true })

    expect(cli.matchedCommand).toBeUndefined()
    const normalizedOutput = stripAnsi(output)
    expect(normalizedOutput).toContain('Unknown command: mcp nonexistent')
    expect(normalizedOutput).toContain('Available "mcp" commands:')
    expect(normalizedOutput).toContain('mcp login')
    expect(normalizedOutput).toContain('mcp logout')
    expect(normalizedOutput).toContain('mcp status')
    expect(normalizedOutput).not.toContain('build')
  })

  test('unknown command without prefix does not show filtered help', () => {
    let output = ''
    const cli = goke('mycli', {
      stdout: { write(data) { output += data } },
    })

    cli.command('mcp login', 'Login to MCP')
    cli.command('build', 'Build project')

    cli.help()

    // User types "foo" - no commands start with "foo"
    cli.parse(['node', 'bin', 'foo'], { run: true })

    // Should not show filtered help since "foo" is not a prefix of any command
    expect(stripAnsi(output)).not.toContain('Available "foo" commands')
  })

  test('unknown command without prefix outputs root help', () => {
    let output = ''
    const cli = goke('mycli', {
      stdout: { write(data) { output += data } },
    })

    cli.command('mcp login', 'Login to MCP')
    cli.command('build', 'Build project')

    cli.help()

    // User types an unknown command that does not match any prefix group
    cli.parse(['node', 'bin', 'something'], { run: true })

    expect(cli.matchedCommand).toBeUndefined()
    expect(stripAnsi(output)).toContain('Usage:')
    expect(stripAnsi(output)).toContain('$ mycli <command> [options]')
    expect(stripAnsi(output)).toContain('mcp login')
    expect(stripAnsi(output)).toContain('build')
  })

  test('no args without default command outputs root help', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout })

    cli.command('mcp login', 'Login to MCP')
    cli.command('build', 'Build project')
    cli.help()

    cli.parse(['node', 'bin'], { run: true })

    expect(stdout.text).toContain('Usage:')
    expect(stdout.text).toContain('$ mycli <command> [options]')
    expect(stdout.text).toContain('mcp login')
    expect(stdout.text).toContain('build')
  })

  test('prefix --help shows filtered help for matching command group', () => {
    let output = ''
    const cli = goke('mycli', {
      stdout: { write(data) { output += data } },
    })

    cli.command('mcp login', 'Login to MCP')
    cli.command('mcp logout', 'Logout from MCP')
    cli.command('mcp status', 'Show status')
    cli.command('build', 'Build project')

    cli.help()
    cli.parse(['node', 'bin', 'mcp', '--help'], { run: true })

    const normalizedOutput = stripAnsi(output)
    expect(normalizedOutput).toMatchInlineSnapshot(`
      "mycli

      Available \"mcp\" commands:

        mcp login   Login to MCP
        mcp logout  Logout from MCP
        mcp status  Show status

      Run \"mycli <command> --help\" for more information.
      "
    `)
  })
})

describe('many commands with root command (empty string)', () => {
  test('root command runs when no subcommand given', () => {
    const cli = goke('deploy')
    let matched = ''

    cli.command('', 'Deploy the current project').action(() => {
      matched = 'root'
    })

    cli.command('init', 'Initialize project').action(() => {
      matched = 'init'
    })

    cli.command('login', 'Authenticate').action(() => {
      matched = 'login'
    })

    cli.parse(['node', 'bin'], { run: true })
    expect(matched).toBe('root')
  })

  test('root command receives options', () => {
    const cli = goke('deploy')
    let result: any = {}

    cli
      .command('', 'Deploy the current project')
      .option('--env <env>', z.string().default('production').describe('Target environment'))
      .option('--dry-run', 'Preview without deploying')
      .action((options) => {
        result = options
      })

    cli.command('init', 'Initialize project').action(() => {})
    cli.command('login', 'Authenticate').action(() => {})

    cli.parse(['node', 'bin', '--env', 'staging', '--dry-run'], { run: true })
    expect(result.env).toBe('staging')
    expect(result.dryRun).toBe(true)
  })

  test('root command uses defaults when no options given', () => {
    const cli = goke('deploy')
    let result: any = {}

    cli
      .command('', 'Deploy the current project')
      .option('--env [env]', z.string().default('production').describe('Target environment'))
      .action((options) => {
        result = options
      })

    cli.command('init', 'Initialize project').action(() => {})

    cli.parse(['node', 'bin'], { run: true })
    expect(result.env).toBe('production')
  })

  test('subcommands take priority over root command', () => {
    const cli = goke('deploy')
    let matched = ''

    cli.command('', 'Deploy the current project').action(() => {
      matched = 'root'
    })

    cli.command('init', 'Initialize project').action(() => {
      matched = 'init'
    })

    cli.command('login', 'Authenticate').action(() => {
      matched = 'login'
    })

    cli.command('status', 'Show status').action(() => {
      matched = 'status'
    })

    cli.parse(['node', 'bin', 'status'], { run: true })
    expect(matched).toBe('status')
  })

  test('subcommand with args works alongside root command', () => {
    const cli = goke('deploy')
    let rootCalled = false
    let logsResult: any = {}

    cli.command('', 'Deploy').action(() => {
      rootCalled = true
    })

    cli
      .command('logs <deploymentId>', 'Stream logs')
      .option('--follow', 'Follow output')
      .option('--lines [n]', z.number().default(100).describe('Number of lines'))
      .action((deploymentId, options) => {
        logsResult = { deploymentId, ...options }
      })

    cli.parse(['node', 'bin', 'logs', 'abc123', '--follow', '--lines', '50'], { run: true })
    expect(rootCalled).toBe(false)
    expect(logsResult.deploymentId).toBe('abc123')
    expect(logsResult.follow).toBe(true)
    expect(logsResult.lines).toBe(50)
  })

  test('help shows root and all subcommands', () => {
    const stdout = createTestOutputStream()
    const cli = goke('deploy', { stdout })

    cli
      .command('', 'Deploy the current project')
      .option('--env <env>', 'Target environment')

    cli.command('init', 'Initialize a new project')
    cli.command('login', 'Authenticate with the server')
    cli.command('logout', 'Clear saved credentials')
    cli.command('status', 'Show deployment status')
    cli.command('logs <deploymentId>', 'Stream logs for a deployment')

    cli.help()
    cli.parse(['node', 'bin', '--help'], { run: false })

    expect(stdout.text).toContain('init')
    expect(stdout.text).toContain('login')
    expect(stdout.text).toContain('logout')
    expect(stdout.text).toContain('status')
    expect(stdout.text).toContain('logs <deploymentId>')
    expect(stdout.text).toContain('Initialize a new project')
    expect(stdout.text).toContain('Stream logs for a deployment')
  })

  test('root help with many commands renders examples section after options', () => {
    const stdout = createTestOutputStream()
    const cli = goke('deploy', { stdout })

    cli
      .command('', 'Deploy the current project')
      .option('--env <env>', 'Target environment')
      .option('--dry-run', 'Preview without deploying')
      .example('# Deploy to staging first')
      .example('deploy --env staging --dry-run')

    cli.command('init', 'Initialize a new project')
    cli.command('login', 'Authenticate with the server')
    cli.command('logout', 'Clear saved credentials')
    cli.command('status', 'Show deployment status')
    cli.command('logs <deploymentId>', 'Stream logs for a deployment')

    cli.help()
    cli.parse(['node', 'bin', '--help'], { run: false })

    expect(stdout.text).toMatchInlineSnapshot(`
      "deploy


      Usage:
        $ deploy [options]


      Commands:
        deploy               Deploy the current project


        init                 Initialize a new project


        login                Authenticate with the server


        logout               Clear saved credentials


        status               Show deployment status


        logs <deploymentId>  Stream logs for a deployment


      Options:
        --env <env>  Target environment
        --dry-run    Preview without deploying
        -h, --help   Display this message


      Examples:
      # Deploy to staging first
      deploy --env staging --dry-run
      "
    `)
  })

  test('subcommand help renders command examples at the end', () => {
    const stdout = createTestOutputStream()
    const cli = goke('deploy', { stdout, columns: 80 })

    cli.command('', 'Deploy the current project')
    cli.command('init', 'Initialize a new project')
    cli.command('login', 'Authenticate with the server')

    cli
      .command('logs <deploymentId>', 'Stream logs for a deployment')
      .option('--follow', 'Follow log output')
      .option('--lines <n>', z.number().default(100).describe('Number of lines'))
      .example('# Stream last 200 lines for a deployment')
      .example('deploy logs dep_123 --lines 200')
      .example('# Keep following new log lines')
      .example('deploy logs dep_123 --follow')

    cli.help()
    cli.parse(['node', 'bin', 'logs', '--help'], { run: false })

    expect(stdout.text).toMatchInlineSnapshot(`
      "deploy


      Usage:
        $ deploy logs <deploymentId>


      Options:
        --follow     Follow log output
        --lines <n>  Number of lines (default: 100)
        -h, --help   Display this message


      Description:
        Stream logs for a deployment


      Examples:
      # Stream last 200 lines for a deployment
      deploy logs dep_123 --lines 200
      # Keep following new log lines
      deploy logs dep_123 --follow
      "
    `)
  })

  test('root help labels default command with cli name and does not duplicate global options', () => {
    const stdout = createTestOutputStream()
    const cli = goke('deploy', { stdout })

    cli.option('--env <env>', 'Target environment')
    cli
      .command('', 'Deploy the current project')
      .option('--env <env>', 'Target environment')
      .option('--dry-run', 'Preview without deploying')

    cli.command('status', 'Show deployment status')

    cli.help()
    cli.parse(['node', 'bin', '--help'], { run: false })

    expect(stdout.text).toMatchInlineSnapshot(`
      "deploy


      Usage:
        $ deploy [options]


      Commands:
        deploy  Deploy the current project


        status  Show deployment status


      Options:
        --env <env>  Target environment
        --dry-run    Preview without deploying
        -h, --help   Display this message
      "
    `)
  })

  test('root help wraps long command descriptions snapshot', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout, columns: 56 })

    cli.command(
      'notion-search',
      'Perform a semantic search over Notion workspace content and connected integrations with advanced filtering options, date filters, and creator filters.',
    )
      .option('--query <query>', 'Natural language query text to search for')
      .option('--limit [limit]', z.number().default(10).describe('Maximum number of results to return'))

    cli.command(
      'notion-fetch',
      'Retrieve a Notion page or database by URL or ID and render the result in enhanced markdown format for terminal output.',
    ).option('--id <id>', 'Notion URL or UUID to fetch')

    cli.help()
    cli.parse(['node', 'bin', '--help'], { run: false })

    expect(stdout.text).toMatchInlineSnapshot(`
      "mycli


      Usage:
        $ mycli <command> [options]


      Commands:
        notion-search      Perform a semantic search over
                           Notion workspace content and
                           connected integrations with
                           advanced filtering options, date
                           filters, and creator filters.

          --query <query>  Natural language query text to
                           search for
          --limit [limit]  Maximum number of results to return
                           (default: 10)


        notion-fetch       Retrieve a Notion page or database
                           by URL or ID and render the result
                           in enhanced markdown format for
                           terminal output.

          --id <id>        Notion URL or UUID to fetch


      Options:
        -h, --help  Display this message
      "
    `)
  })

  test('root help aligns command descriptions with mixed command lengths', () => {
    const stdout = createTestOutputStream()
    const cli = goke('gtui', { stdout, columns: 120 })

    cli.command('auth login', 'Authenticate with Google (opens browser)')
    cli.command('auth logout', 'Remove stored credentials').option('--force', 'Skip confirmation')
    cli.command('mail list', 'List email threads').option('--folder [folder]', 'Folder to list')
    cli.command('attachment get <messageId> <attachmentId>', 'Download an attachment')

    cli.help()
    cli.parse(['node', 'bin', '--help'], { run: false })

    expect(stdout.text).toMatchInlineSnapshot(`
      "gtui


      Usage:
        $ gtui <command> [options]


      Commands:
        auth login                                 Authenticate with Google (opens browser)


        auth logout                                Remove stored credentials

          --force                                  Skip confirmation


        mail list                                  List email threads

          --folder [folder]                        Folder to list


        attachment get <messageId> <attachmentId>  Download an attachment


      Options:
        -h, --help  Display this message
      "
    `)
  })

  test('root help wraps all multi-line description lines', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout, columns: 64 })

    cli.command(
      'notion-create',
      'Create a new page.\n  {"title":"Example"}\n  {"done":true}',
    )
    cli.help()
    cli.parse(['node', 'bin', '--help'], { run: false })

    expect(stdout.text).toContain('{"title":"Example"}')
    expect(stdout.text).toContain('{"done":true}')
  })

  test('root help snapshot when columns is undefined (no wrapping fallback)', () => {
    const stdout = createTestOutputStream()
    const originalColumns = process.stdout.columns

    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: undefined,
    })

    try {
      const cli = goke('mycli', { stdout })

      cli.command(
        'notion-search',
        'Perform a semantic search over Notion workspace content and connected integrations with advanced filtering options, date filters, and creator filters.',
      )
        .option('--query <query>', 'Natural language query text to search for')
        .option('--limit [limit]', z.number().default(10).describe('Maximum number of results to return'))

      cli.help()
      cli.parse(['node', 'bin', '--help'], { run: false })

      expect(stdout.text).toMatchInlineSnapshot(`
        "mycli


        Usage:
          $ mycli <command> [options]


        Commands:
          notion-search      Perform a semantic search over Notion workspace content and connected integrations with advanced filtering options, date filters, and creator filters.

            --query <query>  Natural language query text to search for
            --limit [limit]  Maximum number of results to return (default: 10)


        Options:
          -h, --help  Display this message
        "
      `)
    } finally {
      Object.defineProperty(process.stdout, 'columns', {
        configurable: true,
        value: originalColumns,
      })
    }
  })

  test('many subcommands all resolve correctly', () => {
    const cli = goke('deploy')
    let matched = ''

    cli.command('', 'Root').action(() => { matched = 'root' })
    cli.command('init', 'Init').action(() => { matched = 'init' })
    cli.command('login', 'Login').action(() => { matched = 'login' })
    cli.command('logout', 'Logout').action(() => { matched = 'logout' })
    cli.command('status', 'Status').action(() => { matched = 'status' })
    cli.command('logs <id>', 'Logs').action(() => { matched = 'logs' })
    cli.command('rollback <id>', 'Rollback').action(() => { matched = 'rollback' })
    cli.command('config set <key> <value>', 'Set config').action(() => { matched = 'config set' })

    // Test each command resolves to the right one
    cli.parse(['node', 'bin'], { run: true })
    expect(matched).toBe('root')

    matched = ''
    cli.parse(['node', 'bin', 'init'], { run: true })
    expect(matched).toBe('init')

    matched = ''
    cli.parse(['node', 'bin', 'login'], { run: true })
    expect(matched).toBe('login')

    matched = ''
    cli.parse(['node', 'bin', 'logout'], { run: true })
    expect(matched).toBe('logout')

    matched = ''
    cli.parse(['node', 'bin', 'status'], { run: true })
    expect(matched).toBe('status')

    matched = ''
    cli.parse(['node', 'bin', 'logs', 'dep-123'], { run: true })
    expect(matched).toBe('logs')

    matched = ''
    cli.parse(['node', 'bin', 'rollback', 'dep-456'], { run: true })
    expect(matched).toBe('rollback')

    matched = ''
    cli.parse(['node', 'bin', 'config', 'set', 'region', 'us-east-1'], { run: true })
    expect(matched).toBe('config set')
  })
})

describe('stdout/stderr/argv injection', () => {
  test('stdout captures help output', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout })

    cli.command('serve', 'Start server')
    cli.help()
    cli.parse(['node', 'bin', '--help'], { run: false })
    cli.outputHelp()

    expect(stdout.text).toContain('mycli')
    expect(stdout.text).toContain('serve')
    expect(stdout.text).toContain('Start server')
  })

  test('stdout captures version output', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout })

    cli.version('1.2.3')
    cli.parse(['node', 'bin', '--version'], { run: false })
    cli.outputVersion()

    expect(stdout.text).toContain('mycli/1.2.3')
  })

  test('stdout captures prefix help for unknown subcommands', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout })

    cli.command('mcp login', 'Login to MCP')
    cli.command('mcp logout', 'Logout from MCP')
    cli.help()

    cli.parse(['node', 'bin', 'mcp', 'nonexistent'], { run: true })

    expect(stdout.text).toContain('Unknown command: mcp nonexistent')
    expect(stdout.text).toContain('mcp login')
    expect(stdout.text).toContain('mcp logout')
  })

  test('stderr is separate from stdout', () => {
    const stdout = createTestOutputStream()
    const stderr = createTestOutputStream()
    const cli = goke('mycli', { stdout, stderr })

    cli.console.log('hello stdout')
    cli.console.error('hello stderr')

    expect(stdout.text).toBe('hello stdout\n')
    expect(stderr.text).toBe('hello stderr\n')
  })

  test('argv option is used as default in parse()', () => {
    const cli = goke('mycli', {
      argv: ['node', 'bin', 'serve', '--port', '3000'],
    })

    let result: any = {}
    cli
      .command('serve', 'Start server')
      .option('--port <port>', z.number().describe('Port'))
      .action((options) => { result = options })

    // parse() without args uses the injected argv
    cli.parse()

    expect(result.port).toBe(3000)
  })

  test('parse(customArgv) overrides injected argv', () => {
    const cli = goke('mycli', {
      argv: ['node', 'bin', 'serve', '--port', '3000'],
    })

    let result: any = {}
    cli
      .command('serve', 'Start server')
      .option('--port <port>', z.number().describe('Port'))
      .action((options) => { result = options })

    // Explicit argv overrides the default
    cli.parse(['node', 'bin', 'serve', '--port', '8080'])

    expect(result.port).toBe(8080)
  })

  test('default behavior without options uses process.stdout', () => {
    const cli = goke('mycli')

    // stdout/stderr should be process.stdout/process.stderr by default
    expect(cli.stdout).toBe(process.stdout)
    expect(cli.stderr).toBe(process.stderr)
  })

  test('createConsole routes log to stdout and error to stderr', () => {
    const stdout = createTestOutputStream()
    const stderr = createTestOutputStream()
    const con = createConsole(stdout, stderr)

    con.log('msg1', 'msg2')
    con.error('err1', 'err2')

    expect(stdout.text).toBe('msg1 msg2\n')
    expect(stderr.text).toBe('err1 err2\n')
  })

  test('createConsole log with no args writes empty line', () => {
    const stdout = createTestOutputStream()
    const stderr = createTestOutputStream()
    const con = createConsole(stdout, stderr)

    con.log()

    expect(stdout.text).toBe('\n')
  })
})

describe('schema description and default extraction', () => {
  test('description is extracted from schema and shown in help', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout })

    cli
      .command('serve', 'Start server')
      .option('--port <port>', z.number().describe('Port to listen on'))

    cli.help()
    cli.parse(['node', 'bin', 'serve', '--help'], { run: false })

    expect(stdout.text).toContain('Port to listen on')
  })

  test('default is extracted from schema and shown in help', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout })

    cli
      .command('serve', 'Start server')
      .option('--port [port]', z.number().default(3000).describe('Port'))

    cli.help()
    cli.parse(['node', 'bin', 'serve', '--help'], { run: false })

    expect(stdout.text).toContain('(default: 3000)')
  })

  test('deprecated options are hidden from help output', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout })

    cli
      .command('serve', 'Start server')
      .option('--old <value>', z.string().meta({ deprecated: true, description: 'Old option' }))
      .option('--new <value>', z.string().describe('Normal option'))

    cli.help()
    cli.parse(['node', 'bin', 'serve', '--help'], { run: false })

    // Normal option should be visible
    expect(stdout.text).toContain('--new')
    expect(stdout.text).toContain('Normal option')
    // Deprecated option should be hidden
    expect(stdout.text).not.toContain('--old')
    expect(stdout.text).not.toContain('Old option')
  })

  test('deprecated option still works for parsing (just hidden from help)', () => {
    const cli = gokeTestable('mycli')

    let result: any = {}
    cli
      .command('serve', 'Start server')
      .option('--old <value>', z.string().meta({ deprecated: true, description: 'Old option' }))
      .action((options) => { result = options })

    cli.parse(['node', 'bin', 'serve', '--old', 'legacy-value'])

    // Deprecated option should still be parsed and usable
    expect(result.old).toBe('legacy-value')
  })

  test('deprecated options hidden from global help', () => {
    const stdout = createTestOutputStream()
    const cli = goke('mycli', { stdout })

    cli.option('--legacy [value]', z.string().meta({ deprecated: true, description: 'Deprecated global' }))
    cli.option('--current [value]', z.string().describe('Current option'))

    cli.help()
    cli.parse(['node', 'bin', '--help'], { run: false })

    expect(stdout.text).toContain('--current')
    expect(stdout.text).toContain('Current option')
    expect(stdout.text).not.toContain('--legacy')
    expect(stdout.text).not.toContain('Deprecated global')
  })
})
