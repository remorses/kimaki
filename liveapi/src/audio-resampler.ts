export function downSampleAudioBuffer(
  buffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  if (outputSampleRate >= inputSampleRate) {
    throw new Error('Output sample rate must be less than input sample rate.')
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate
  const newLength = Math.round(buffer.length / sampleRateRatio)
  const result = new Float32Array(newLength)

  let offsetResult = 0
  let offsetBuffer = 0

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio)
    let accum = 0
    let count = 0

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i]
      count++
    }

    result[offsetResult] = accum / count
    offsetResult++
    offsetBuffer = nextOffsetBuffer
  }

  return result
}

export function downSampleInt16Buffer(
  buffer: ArrayBuffer,
  inputSampleRate: number,
  outputSampleRate: number,
): ArrayBuffer {
  if (outputSampleRate >= inputSampleRate) {
    throw new Error('Output sample rate must be less than input sample rate.')
  }

  // Convert Int16Array to Float32Array
  const int16Array = new Int16Array(buffer)
  const float32Array = new Float32Array(int16Array.length)
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0
  }

  // Downsample
  const downsampled = downSampleAudioBuffer(
    float32Array,
    inputSampleRate,
    outputSampleRate,
  )

  // Convert back to Int16Array
  const downsampledInt16 = new Int16Array(downsampled.length)
  for (let i = 0; i < downsampled.length; i++) {
    downsampledInt16[i] = Math.max(
      -32768,
      Math.min(32767, Math.floor(downsampled[i] * 32768)),
    )
  }

  return downsampledInt16.buffer
}
