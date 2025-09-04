import webrtc from '@roamhq/wrtc'

interface RealtimeEvent {
  type: string
  response?: {
    modalities: string[]
    instructions: string
  }
}

export async function startRealtimeSession() {
  const pc = new webrtc.RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })

  pc.ontrack = (e) => {
    console.log('Remote track:', e.track.kind)
  }

  // Add a dummy audio track since the API might expect audio capability
  const audioSource = new webrtc.nonstandard.RTCAudioSource()
  const audioTrack = audioSource.createTrack()
  pc.addTrack(audioTrack)

  const dc = pc.createDataChannel('oai-events')

  dc.onopen = () => {
    console.log('✅ Data channel open')
    console.log('📤 Sending initial message...\n')

    const event: RealtimeEvent = {
      type: 'response.create',
      response: {
        modalities: ['text'],
        instructions: 'Say hello from a Node wrtc client.',
      },
    }

    dc.send(JSON.stringify(event))

    // Allow sending more messages
    setTimeout(() => {
      console.log('\n💡 You can send another message:')
      const followUp: RealtimeEvent = {
        type: 'response.create',
        response: {
          modalities: ['text'],
          instructions: 'Tell me a fun fact about WebRTC in one sentence.',
        },
      }
      dc.send(JSON.stringify(followUp))
    }, 5000)
  }

  dc.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data)

      switch (event.type) {
        case 'session.created':
          console.log('✅ Session created:', event.session.id)
          console.log('   Model:', event.session.model)
          console.log('   Modalities:', event.session.modalities.join(', '))
          break

        case 'response.text.delta':
          process.stdout.write(event.delta)
          break

        case 'response.text.done':
          console.log('\n📝 Complete text:', event.text)
          break

        case 'response.done':
          console.log('✅ Response completed')
          console.log(
            '   Tokens used:',
            event.response.usage?.total_tokens || 0,
          )
          break

        case 'error':
          console.error('❌ Error:', event.error)
          break

        default:
          if (process.env.DEBUG) {
            console.log(
              `[${event.type}]`,
              JSON.stringify(event).substring(0, 200),
            )
          }
      }
    } catch (err) {
      console.error('Failed to parse event:', e.data)
    }
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  const model = 'gpt-4o-realtime-preview-2024-12-17'
  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required')
  }

  const url = `https://api.openai.com/v1/realtime?model=${model}`
  console.log('🔌 Connecting to OpenAI Realtime API...')
  console.log('   Model:', model)

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/sdp',
    },
    body: offer.sdp,
  })

  if (!resp.ok) {
    const errorText = await resp.text()
    console.error('Error response:', errorText)
    throw new Error(`OpenAI API error: ${resp.status} ${resp.statusText}`)
  }

  const answerSdp = await resp.text()
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

  console.log('🎯 WebRTC connection established\n')

  setTimeout(() => {
    console.log('\n👋 Closing connection...')
    pc.close()
    process.exit(0)
  }, 30000)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRealtimeSession().catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
}
