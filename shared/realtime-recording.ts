import type { TraceEvent } from './types.ts';

export interface RecordedTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  audio: string[];
  interrupted?: boolean;
}

/** Interpret only recorded native messages. Never invent a transcript for audio-only turns. */
export function recordedTurns(events: TraceEvent[]): RecordedTurn[] {
  const turns: RecordedTurn[] = [];
  let current: RecordedTurn | undefined;
  const response = (id?: string) => {
    const found = id ? turns.find((t) => t.id === id) : current;
    if (found?.role === 'assistant') return found;
    const turn: RecordedTurn = { id: id || `response-${turns.length}`, role: 'assistant', text: '', audio: [] };
    turns.push(turn);
    current = turn;
    return turn;
  };
  for (const event of events) {
    if (!['ws-send', 'ws-recv'].includes(event.type)) continue;
    let message = event.data;
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch {
        continue;
      }
    }
    if (!message || typeof message !== 'object') continue;
    if (event.type === 'ws-send') {
      if (message.type === 'conversation.item.create' && message.item?.role === 'user') {
        const text = (message.item.content ?? [])
          .filter((p: any) => p.type === 'input_text')
          .map((p: any) => p.text)
          .join('');
        if (text) turns.push({ id: message.item.id ?? `user-${turns.length}`, role: 'user', text, audio: [] });
      }
      if (message.type === 'response.cancel' && current) current.interrupted = true;
      continue;
    }
    const type = message.type;
    if (type === 'response.created') current = response(message.response?.id);
    if (type === 'conversation.item.input_audio_transcription.completed')
      turns.push({
        id: message.item_id ?? `user-${turns.length}`,
        role: 'user',
        text: message.transcript ?? '',
        audio: [],
      });
    if (['response.audio.delta', 'response.output_audio.delta'].includes(type) && typeof message.delta === 'string')
      response(message.response_id).audio.push(message.delta);
    if (
      [
        'response.audio_transcript.delta',
        'response.output_audio_transcript.delta',
        'response.text.delta',
        'response.output_text.delta',
      ].includes(type)
    )
      response(message.response_id).text += message.delta ?? '';
    if (
      ['response.audio_transcript.done', 'response.output_audio_transcript.done'].includes(type) &&
      typeof message.transcript === 'string'
    )
      response(message.response_id).text = message.transcript;
    if (type === 'input_audio_buffer.speech_started' && current?.audio.length) current.interrupted = true;
  }
  return turns;
}

/** Package native mono PCM16 as a playable WAV without changing the recorded samples. */
export function pcm16Wave(chunks: Uint8Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || size > 0xffffffff - 44 || size % 2)
    throw new Error('PCM 音频长度或采样率无效');
  const result = new Uint8Array(44 + size);
  const view = new DataView(result.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) result[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + size, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, size, true);
  let offset = 44;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
