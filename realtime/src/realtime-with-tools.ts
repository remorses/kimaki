import { createRealtimeClient } from './openai-realtime'

const weatherData = {
  'San Francisco': { temperature: 65, condition: 'Partly Cloudy' },
  'New York': { temperature: 72, condition: 'Sunny' },
  London: { temperature: 58, condition: 'Rainy' },
  Tokyo: { temperature: 78, condition: 'Clear' },
  Paris: { temperature: 62, condition: 'Cloudy' },
}

function getWeather(location: string): string {
  const weather = weatherData[location as keyof typeof weatherData]
  if (weather) {
    return JSON.stringify({
      location,
      temperature: weather.temperature,
      condition: weather.condition,
      unit: 'fahrenheit',
    })
  }
  return JSON.stringify({
    error: `Weather data not available for ${location}`,
  })
}

async function main() {
  const client = createRealtimeClient({
    apiKey: process.env.OPENAI_API_KEY,
  })

  const functionCalls = new Map<string, { name: string; arguments: string }>()

  client.on('error', (error) => {
    console.error('Error:', error)
  })

  client.on('session.created', (session) => {
    console.log('Session created:', session.id)
  })

  client.on('response.text.delta', (delta) => {
    process.stdout.write(delta)
  })

  client.on('response.text.done', (text) => {
    console.log('\nText response complete')
  })

  client.on('response.function_call_arguments.delta', (delta) => {
    process.stdout.write(`Function call delta: ${delta}`)
  })

  client.on('response.function_call_arguments.done', (args) => {
    console.log('\nFunction call arguments complete:', args)
  })

  client.on('response.output_item.done', (item) => {
    if (item.type === 'function_call') {
      const callId = item.id
      functionCalls.set(callId, {
        name: item.name,
        arguments: item.arguments,
      })

      console.log(`\nExecuting function: ${item.name}`)
      console.log(`Arguments: ${item.arguments}`)

      let result = ''
      try {
        const args = JSON.parse(item.arguments)

        switch (item.name) {
          case 'get_weather':
            result = getWeather(args.location)
            break
          default:
            result = JSON.stringify({ error: `Unknown function: ${item.name}` })
        }
      } catch (error) {
        result = JSON.stringify({
          error: `Failed to execute function: ${error}`,
        })
      }

      console.log(`Function result: ${result}`)

      client.submitToolOutput(callId, result)
      client.createResponse()
    }
  })

  client.on('response.done', (response) => {
    console.log('\n--- Response complete ---')
    if (response.usage) {
      console.log('Usage:', response.usage)
    }
  })

  await client.connect()

  client.updateSession({
    instructions:
      'You are a helpful weather assistant. Use the get_weather function to provide weather information for cities.',
    voice: 'alloy',
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get current weather for a specific location',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description:
                'City name (e.g., San Francisco, New York, London, Tokyo, Paris)',
            },
          },
          required: ['location'],
        },
      },
    ],
    tool_choice: 'auto',
    temperature: 0.7,
  })

  await client.waitForSessionCreated()

  const readline = require('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  console.log('\nWeather Assistant Ready!')
  console.log('Available cities: San Francisco, New York, London, Tokyo, Paris')
  console.log('Example: "What\'s the weather in Tokyo?"')
  console.log('Type "exit" to quit\n')

  rl.on('line', (input: string) => {
    if (input.toLowerCase() === 'exit') {
      client.disconnect()
      process.exit(0)
    }

    client.sendUserMessageContent([{ type: 'input_text', text: input }])
    client.createResponse()
  })

  rl.question('Ask about weather: ', () => {})
}

main().catch(console.error)
