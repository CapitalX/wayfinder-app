import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

// Speech to text on this machine: a Python worker (faster-whisper) keeps the model loaded and answers one clip at
// a time. Audio is written to a private temp file, transcribed and deleted; it never leaves the host.

const PYTHON = process.env.WAYFINDER_VOICE_PYTHON ?? join(homedir(), '.local', 'share', 'wayfinder-voice', 'bin', 'python');
const WORKER = join(process.cwd(), 'src', 'voice', 'transcribe_worker.py');
const TMP = join(DATA_DIR, 'voice-tmp');

let worker: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
const waiting = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>();

export const voiceAvailable = () => existsSync(PYTHON) && existsSync(WORKER);

function start(): Promise<void> {
  if (ready) return ready;
  mkdirSync(TMP, { recursive: true, mode: 0o700 });
  ready = new Promise((resolve, reject) => {
    const w = spawn(PYTHON, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: homedir() } });
    worker = w;
    let buf = '';
    w.stdout.on('data', (b: Buffer) => {
      buf += b.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) { resolve(); continue; }
        const p = waiting.get(msg.id); if (!p) continue;
        waiting.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(String(msg.text ?? ''));
      }
    });
    w.stderr.on('data', () => { /* model download progress and warnings */ });
    w.on('exit', () => {
      worker = null; ready = null;
      for (const p of waiting.values()) p.reject(new Error('The speech worker stopped; try again.'));
      waiting.clear();
      reject(new Error('The speech worker stopped while starting.'));
    });
  });
  return ready;
}

export async function transcribe(wav: Buffer): Promise<string> {
  if (!voiceAvailable()) throw new Error('Voice is not set up on this host.');
  await start();
  const id = randomUUID();
  const file = join(TMP, `${id}.wav`);
  writeFileSync(file, wav, { mode: 0o600 });
  try {
    return await new Promise<string>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker!.stdin.write(JSON.stringify({ id, path: file }) + '\n');
      setTimeout(() => { if (waiting.delete(id)) reject(new Error('Transcription took too long.')); }, 60_000);
    });
  } finally {
    rmSync(file, { force: true });
  }
}

// Warm the model in the background so the first voice message isn't slow.
export function warmVoice() { if (voiceAvailable()) start().catch(() => {}); }
