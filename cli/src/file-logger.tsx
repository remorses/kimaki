import * as fs from 'fs'

const logFilePath = '/Users/morse/Documents/GitHub/kimakivoice/app.log'

// Ensure the log file exists
if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, '')
}

export const logger = {
    log(...args: any[]) {
        const timestamp = new Date().toISOString()
        const message = `[${timestamp}] ${args
            .map((arg) =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg),
            )
            .join(' ')}\n`

        fs.appendFileSync(logFilePath, message)
    },
}
