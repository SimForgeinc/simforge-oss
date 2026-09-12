/**
 * The one piece of the graph that has to generate samples rather than replay
 * them: the noise the wind and tyre-roar layers are filtered out of.
 *
 * A looped noise buffer is the cheap way to do this and it does not survive a
 * low-pass: under a few hundred Hz the loop period becomes a pitch, and the
 * wind layer ends up with a slow pulse in it that no amount of gain shaping
 * hides. An AudioWorklet generates pink noise forever with no period at all,
 * for about the cost of the filter that follows it.
 *
 * The processor is delivered as a blob so the library has no build step and no
 * static asset the embedding host has to serve; contexts that have no worklet
 * support (older WebKit, and the jsdom-ish environments unit tests run in) fall
 * back to a long noise loop, which is worse but never silent.
 */

/**
 * Paul Kellet's pink-noise filter: white noise through a cascade of one-pole
 * sections, which is within a fraction of a dB of -3 dB/octave across the
 * audible range and costs seven multiplies a sample.
 */
const PROCESSOR_SOURCE = `
class DriveNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.b3 = 0; this.b4 = 0; this.b5 = 0; this.b6 = 0;
  }
  process(_inputs, outputs) {
    const channel = outputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const white = Math.random() * 2 - 1;
      this.b0 = 0.99886 * this.b0 + white * 0.0555179;
      this.b1 = 0.99332 * this.b1 + white * 0.0750759;
      this.b2 = 0.96900 * this.b2 + white * 0.1538520;
      this.b3 = 0.86650 * this.b3 + white * 0.3104856;
      this.b4 = 0.55000 * this.b4 + white * 0.5329522;
      this.b5 = -0.7616 * this.b5 - white * 0.0168980;
      channel[i] = (this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362) * 0.11;
      this.b6 = white * 0.115926;
    }
    return true;
  }
}
registerProcessor('drive-noise', DriveNoiseProcessor);
`;

const registered = new WeakSet<BaseAudioContext>();

/** Register the processor with a context once, resolving false if it cannot be. */
async function ensureProcessor(ctx: BaseAudioContext): Promise<boolean> {
  if (registered.has(ctx)) return true;
  if (typeof AudioWorkletNode !== 'function' || !ctx.audioWorklet) return false;
  const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    registered.add(ctx);
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Seconds of noise the fallback loop holds. Long enough to hide the seam. */
const FALLBACK_SECONDS = 6;

function fallbackNoise(ctx: BaseAudioContext): AudioBufferSourceNode {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * FALLBACK_SECONDS), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.11;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start();
  return source;
}

/**
 * A running, never-repeating noise source. Resolves to the worklet node where
 * one can be registered and to a looping buffer source otherwise; both are
 * plain `AudioNode`s the caller connects and disconnects the same way.
 */
export async function createNoiseSource(ctx: BaseAudioContext): Promise<AudioNode> {
  if (await ensureProcessor(ctx)) return new AudioWorkletNode(ctx, 'drive-noise');
  return fallbackNoise(ctx);
}
