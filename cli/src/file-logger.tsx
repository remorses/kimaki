import * as fs from 'fs'
import { dump } from 'js-yaml'

const logFilePath = '/Users/morse/Documents/GitHub/kimakivoice/app.log'

// Ensure the log file exists
if (!fs.existsSync(logFilePath)) {
  fs.writeFileSync(logFilePath, '')
}

export const logger = {
  log(...args: any[]) {
    const timestamp = new Date().toISOString()
    const payload = { timestamp, messages: args.map((arg) => (typeof arg === 'object' ? arg : String(arg))) }
    const yaml = dump(payload)
    fs.appendFileSync(logFilePath, `---\n${yaml}\n`)
  },
}
