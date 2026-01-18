// sample-hold-processor.js - AudioWorklet for precise sample-and-hold timing
class SampleHoldProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.phase = 0
    this.sampleValue = 0
    this.port.onmessage = (e) => {
      if (e.data.freq !== undefined) {
        this.freq = e.data.freq
      }
    }
    this.freq = 1 // default 1 Hz
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]
    const sampleRate = this.sampleRate

    for (let ch = 0; ch < output.length; ch++) {
      const outCh = output[ch]
      for (let i = 0; i < outCh.length; i++) {
        // advance phase
        this.phase += this.freq / sampleRate
        if (this.phase >= 1) {
          this.phase -= 1
          // sample new random value on phase wrap
          this.sampleValue = Math.random() * 2 - 1
        }
        outCh[i] = this.sampleValue
      }
    }
    return true
  }
}

registerProcessor('sample-hold', SampleHoldProcessor)
