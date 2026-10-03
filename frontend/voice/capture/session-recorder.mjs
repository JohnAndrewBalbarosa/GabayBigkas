export async function createSessionRecorder({ stream, onChunk, chunkDurationMs = 1_000 }) {
  if (!(stream instanceof MediaStream) || stream.getAudioTracks().length !== 1) {
    throw new Error('One shared microphone audio track is required.');
  }
  const context = new AudioContext();
  const moduleUrl = URL.createObjectURL(new Blob([workletSource()], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, 'session-pcm-recorder', {
    processorOptions: { chunkFrames: Math.round(context.sampleRate * chunkDurationMs / 1_000) },
  });
  const silence = context.createGain();
  silence.gain.value = 0;
  let sequence = 0;
  let uploadChain = Promise.resolve();
  recorder.port.onmessage = ({ data }) => {
    const current = sequence++;
    uploadChain = uploadChain.then(() => onChunk({
      sequence: current,
      sampleRate: context.sampleRate,
      channels: 1,
      pcm: data,
    }));
  };
  source.connect(recorder).connect(silence).connect(context.destination);
  return {
    sampleRate: context.sampleRate,
    async stop() {
      recorder.port.postMessage({ type: 'flush' });
      await new Promise(resolve => setTimeout(resolve, 30));
      recorder.disconnect();
      source.disconnect();
      silence.disconnect();
      await uploadChain;
      await context.close();
    },
  };
}

function workletSource() {
  return `
class SessionPcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkFrames = options.processorOptions.chunkFrames;
    this.samples = [];
    this.port.onmessage = event => { if (event.data.type === 'flush') this.flush(); };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      const bounded = Math.max(-1, Math.min(1, sample));
      this.samples.push(bounded < 0 ? Math.round(bounded * 32768) : Math.round(bounded * 32767));
    }
    if (this.samples.length >= this.chunkFrames) this.flush();
    return true;
  }
  flush() {
    if (!this.samples.length) return;
    const pcm = Int16Array.from(this.samples);
    this.samples = [];
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
}
registerProcessor('session-pcm-recorder', SessionPcmRecorder);`;
}

