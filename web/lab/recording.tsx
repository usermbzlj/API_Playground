import { useEffect, useMemo, useState } from 'react';
import type { TraceEvent } from '../../shared/types.ts';
import { pcm16Wave, recordedTurns } from '../../shared/realtime-recording.ts';
import { EmptyHint } from '../ui.tsx';

function RecordedAudio({ chunks, rate }: { chunks: string[]; rate: number }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let local: string | undefined;
    try {
      const bytes = chunks.map((chunk) => Uint8Array.from(atob(chunk), (char) => char.charCodeAt(0)));
      local = URL.createObjectURL(new Blob([pcm16Wave(bytes, rate)], { type: 'audio/wav' }));
      setUrl(local);
      setError('');
    } catch {
      setError('这段记录缺少完整音频字节，无法回放。');
    }
    return () => {
      if (local) URL.revokeObjectURL(local);
    };
  }, [chunks, rate]);
  return error ? (
    <p className="text-xs text-amber-300">{error}</p>
  ) : url ? (
    <audio controls preload="none" className="mt-2 w-full" src={url} />
  ) : null;
}

export function RealtimeRecording({ events, outputRate }: { events: TraceEvent[]; outputRate: number }) {
  const turns = useMemo(() => recordedTurns(events), [events]);
  if (!turns.length) return <EmptyHint>没有录到可展示的转写或回复音频。原始双向消息仍可在事件流中查看。</EmptyHint>;
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-zinc-400">
        从本机保存的原生消息还原。回复音频包含厂商返回的片段，被打断后未播放的部分也可能保留；没有厂商转写的语音不会生成虚构字幕。
      </p>
      {turns.map((turn) => (
        <div
          key={turn.id}
          className={`rounded-lg border border-zinc-800 p-3 ${turn.role === 'user' ? 'bg-violet-950/20' : 'bg-emerald-950/15'}`}
        >
          <div className="mb-2 flex gap-3 text-xs text-zinc-400">
            {turn.role}
            {turn.interrupted && <span className="text-amber-300">曾被打断</span>}
          </div>
          <p className="whitespace-pre-wrap text-sm text-zinc-200">{turn.text || '（此回合没有返回文字转写）'}</p>
          {!!turn.audio.length && <RecordedAudio chunks={turn.audio} rate={outputRate} />}
        </div>
      ))}
    </div>
  );
}
