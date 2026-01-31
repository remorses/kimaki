#!/usr/bin/env node
import { cac } from '@xmorse/cac'
import { CLI_NAME, runTunnel, parseCommandFromArgv } from './run-tunnel.js'

const { command, argv } = parseCommandFromArgv(process.argv)

const cli = cac(CLI_NAME)

cli
  .command('', 'Expose a local port via tunnel')
  .option('-p, --port <port>', 'Local port to expose (required)')
  .option('-t, --tunnel-id [id]', 'Tunnel ID (random if omitted)')
  .option('-h, --host [host]', 'Local host (default: localhost)')
  .option('-d, --domain [domain]', 'Base domain (default: kimaki.xyz)')
  .option('-s, --server [url]', 'Tunnel server URL (overrides domain)')
  .example(`${CLI_NAME} -p 3000`)
  .example(`${CLI_NAME} -p 3000 -- next start`)
  .example(`${CLI_NAME} -p 3000 -- pnpm dev`)
  .example(`${CLI_NAME} -p 5173 -t my-app -- vite`)
  .example(`${CLI_NAME} -p 3000 -d traforo.dev -- pnpm dev`)
  .action(
    async (options: {
      port?: string
      tunnelId?: string
      host?: string
      domain?: string
      server?: string
    }) => {
      if (!options.port) {
        console.error('Error: --port is required')
        console.error(`\nUsage: ${CLI_NAME} -p <port> [-- command]`)
        process.exit(1)
      }

      const port = parseInt(options.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Error: Invalid port number: ${options.port}`)
        process.exit(1)
      }

      await runTunnel({
        port,
        tunnelId: options.tunnelId,
        localHost: options.host,
        baseDomain: options.domain,
        serverUrl: options.server,
        command: command.length > 0 ? command : undefined,
      })
    }
  )

cli.help()
cli.version('0.0.1')

// Parse the modified argv (without the command after --)
cli.parse(argv)
