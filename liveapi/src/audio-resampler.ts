
export function downSampleAudioBuffer(
    buffer: Float32Array,
    inputSampleRate: number,
    outputSampleRate: number,
): Float32Array {
    if (outputSampleRate >= inputSampleRate) {
        throw new Error(
            'Output sample rate must be less than input sample rate.',
        )
    }

    const sampleRateRatio = inputSampleRate / outputSampleRate
    const newLength = Math.round(buffer.length / sampleRateRatio)
    const result = new Float32Array(newLength)

    let offsetResult = 0
    let offsetBuffer = 0

    while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round(
            (offsetResult + 1) * sampleRateRatio,
        )
        let accum = 0
        let count = 0

        for (
            let i = offsetBuffer;
            i < nextOffsetBuffer && i < buffer.length;
            i++
        ) {
            accum += buffer[i]
            count++
        }

        result[offsetResult] = accum / count
        offsetResult++
        offsetBuffer = nextOffsetBuffer
    }

    return result
}
