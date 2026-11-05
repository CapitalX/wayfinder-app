import { useRef, useState } from 'react';

// Records the microphone as 16 kHz mono 16-bit WAV in the browser (no codecs needed on the server) and sends it to
// /api/transcribe, which runs speech-to-text on the app's own host.
export function useVoice(onText: (text: string) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const parts = useRef<{ ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; chunks: Float32Array[]; timer: number; started: number } | null>(null);

  const start = async () => {
    if (state !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        let peak = 0; for (let i = 0; i < data.length; i += 64) peak = Math.max(peak, Math.abs(data[i]));
        setLevel(peak);
      };
      src.connect(node); node.connect(ctx.destination);
      const started = Date.now();
      const timer = window.setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        setSeconds(s);
        if (s >= 240) stop();
      }, 250);
      parts.current = { ctx, stream, node, chunks, timer, started };
      setSeconds(0);
      setState('recording');
    } catch {
      onError('The microphone is blocked. Allow it for this site in the browser, then try again.');
    }
  };

  const release = () => {
    const p = parts.current; if (!p) return null;
    window.clearInterval(p.timer);
    p.node.disconnect(); p.stream.getTracks().forEach((t) => t.stop());
    const rate = p.ctx.sampleRate;
    p.ctx.close();
    parts.current = null;
    return { chunks: p.chunks, rate };
  };

  const stop = async () => {
    const got = release();
    if (!got) return;
    setLevel(0);
    const samples = merge(got.chunks);
    if (samples.length < got.rate * 0.4) { setState('idle'); return; } // too short to be speech
    setState('transcribing');
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: toWav(downsample(samples, got.rate, 16000), 16000), credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      if (json.text?.trim()) onText(json.text.trim());
    } catch (e) {
      onError(`Couldn't transcribe that: ${(e as Error).message}`);
    }
    setState('idle');
  };

  const cancel = () => { release(); setLevel(0); setState('idle'); };

  return { state, level, seconds, start, stop, cancel };
}

function merge(chunks: Float32Array[]) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function downsample(input: Float32Array, from: number, to: number) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function toWav(samples: Float32Array, rate: number) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

// A sentence that trails off ("check the loan table and…") waits for the rest instead of sending.
export const soundsUnfinished = (t: string) =>
  /(,|\b(and|or|but|so|because|if|then|with|to|the|a|an|of|for|that|which|when|where|also|like|maybe|um|uh|i))\s*[.…]*$/i.test(t.trim());
