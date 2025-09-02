import { cac } from 'cac'
import pc from 'picocolors'



export const cli = cac('kimaki')

cli.help()

// Check if running in TTY environment
const isTTY = process.stdout.isTTY && process.stdin.isTTY

cli.command('', '')

    .action(async (options) => {
        try {
        } catch (error) {
            console.error(pc.red('\nError initializing project:'))
            console.error(pc.red(error))
            process.exit(1)
        }
    })
