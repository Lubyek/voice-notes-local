// Average the input over each output sample's interval, keeping phase across render blocks.
const TARGET_RATE = 16_000;
const PACKET_SAMPLES = 4_000;

class MicrophoneCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outputSpanLeft = sampleRate;
    this.sum = 0;
    this.length = 0;
    this.buffer = new ArrayBuffer(PACKET_SAMPLES * 2);
    this.view = new DataView(this.buffer);
    this.finished = false;

    this.port.onmessage = ({ data }) => {
      if (data === "flush" && !this.finished) {
        this.finished = true;
        this.sendPacket();
        this.port.postMessage("flushed");
      }
    };
  }

  sendPacket() {
    if (!this.length) return;
    const packet = this.buffer.slice(0, this.length * 2);
    this.port.postMessage(packet, [packet]);
    this.length = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (this.finished || !input) return true;

    for (const sample of input) {
      let inputSpanLeft = TARGET_RATE;
      while (inputSpanLeft) {
        const span = Math.min(inputSpanLeft, this.outputSpanLeft);
        this.sum += sample * span;
        inputSpanLeft -= span;
        this.outputSpanLeft -= span;
        if (this.outputSpanLeft === 0) {
          const normalized = Math.max(-1, Math.min(1, this.sum / sampleRate));
          const pcm = Math.round(normalized * (normalized < 0 ? 32768 : 32767));
          this.view.setInt16(this.length * 2, pcm, true);
          this.length += 1;
          if (this.length === PACKET_SAMPLES) this.sendPacket();
          this.sum = 0;
          this.outputSpanLeft = sampleRate;
        }
      }
    }
    return true;
  }
}

registerProcessor("microphone-capture", MicrophoneCapture);
