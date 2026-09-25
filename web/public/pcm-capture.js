// AudioWorklet: capture mic audio, resample to 24 kHz mono PCM16, post ~50 ms chunks.
// Runs at the context's native rate (Safari/Firefox-safe) and resamples here.
class PcmCapture extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const { inputSampleRate, targetSampleRate } = options.processorOptions;
		this.ratio = inputSampleRate / targetSampleRate;
		this.size = Math.round(targetSampleRate * 0.05);
		this.chunk = new Int16Array(this.size);
		this.filled = 0;
		this.pos = 0; // fractional read position carried across render quanta
		this.level = 0;
	}

	process(inputs) {
		const input = inputs[0]?.[0];
		if (!input) return true;
		let peak = 0;
		for (; this.pos < input.length; this.pos += this.ratio) {
			const s = input[Math.floor(this.pos)] ?? 0;
			const a = s < 0 ? -s : s;
			if (a > peak) peak = a;
			this.chunk[this.filled++] = Math.max(
				-32768,
				Math.min(32767, Math.round(s * 32767)),
			);
			if (this.filled === this.size) {
				const out = this.chunk;
				this.port.postMessage({ pcm: out.buffer, level: this.level }, [
					out.buffer,
				]);
				// out.buffer is transferred (detached, length 0) — size from the constant.
				this.chunk = new Int16Array(this.size);
				this.filled = 0;
			}
		}
		this.pos -= input.length;
		this.level = Math.max(peak, this.level * 0.85);
		return true;
	}
}

registerProcessor("pcm-capture", PcmCapture);
