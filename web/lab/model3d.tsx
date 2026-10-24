import { createElement, useEffect, useRef, useState } from 'react';

// Load the renderer only when a 3D artifact is actually displayed.
export function ModelPreview({ src, name }: { src: string; name: string }) {
  const ref = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    let active = true;
    import('@google/model-viewer')
      .then(({ ModelViewerElement }) => {
        ModelViewerElement.dracoDecoderLocation = '/vendor/draco/';
        ModelViewerElement.ktx2TranscoderLocation = '/vendor/basis/';
        ModelViewerElement.meshoptDecoderLocation = '/vendor/meshopt_decoder.js';
        if (active) setReady(true);
      })
      .catch(() => {
        if (active) setError('3D 预览器加载失败，可以下载模型到本地查看。');
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fail = () => setError('无法显示这个模型。请检查 GLB/glTF 格式与 WebGL 支持，或下载模型查看。');
    const update = (event: Event) => setProgress((event as CustomEvent).detail.totalProgress);
    el.addEventListener('error', fail);
    el.addEventListener('progress', update);
    return () => {
      el.removeEventListener('error', fail);
      el.removeEventListener('progress', update);
    };
  }, [ready, src]);
  return (
    <div className="relative overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950">
      {error ? (
        <p className="p-5 text-xs text-amber-200">{error}</p>
      ) : ready ? (
        createElement('model-viewer', {
          ref,
          src,
          alt: name,
          'camera-controls': true,
          'touch-action': 'pan-y',
          'auto-rotate': true,
          'shadow-intensity': '0.7',
          exposure: '1',
          style: { width: '100%', height: '360px' },
        })
      ) : (
        <p className="p-8 text-sm text-zinc-400">正在加载 3D 预览器…</p>
      )}
      {!error && ready && progress < 1 && (
        <progress
          aria-label="模型加载进度"
          value={progress}
          max="1"
          className="absolute inset-x-3 bottom-3 w-[calc(100%-1.5rem)]"
        />
      )}
      <p className="border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">
        拖动旋转 · 滚轮 / 双指缩放 · Shift 拖动平移
      </p>
    </div>
  );
}
