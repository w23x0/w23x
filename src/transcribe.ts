import type { TranscriptionConfig } from './config.js';
import type { InboundVoice } from './channels/types.js';

export async function transcribe(voice: InboundVoice, config?: TranscriptionConfig): Promise<string> {
  if (!config?.baseUrl || !config?.model) throw new Error('no transcription configured');
  const buf = Buffer.from(voice.data, 'base64');
  const url = String(config.baseUrl).replace(/\/$/, '') + '/audio/transcriptions';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: voice.mimeType }), 'voice');
  form.append('model', config.model);
  const headers: Record<string, string> = {};
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
  const json = await res.json().catch(() => ({}));
  return String((json as any)?.text || (json as any)?.transcript || '').trim();
}

export function createTranscriber(config?: TranscriptionConfig): ((voice: InboundVoice) => Promise<string>) | undefined {
  if (!config?.baseUrl || !config?.model) return undefined;
  return (voice) => transcribe(voice, config);
}