import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import type { CodeInputProps } from '../ui.tsx';

export default function CodeEditor({ value, onChange, placeholder, minHeight = 120, lang = 'json' }: CodeInputProps) {
  const extensions = useMemo(
    () =>
      lang === 'json'
        ? [json()]
        : lang === 'js'
          ? [javascript({ typescript: true })]
          : lang === 'python'
            ? [python()]
            : [],
    [lang],
  );
  return (
    <div className="overflow-hidden rounded-md border border-zinc-700 bg-zinc-950">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        placeholder={placeholder}
        minHeight={`${minHeight}px`}
        maxHeight="520px"
        theme="dark"
        aria-label={`${lang} 编辑器`}
        basicSetup={{ lineNumbers: lang !== 'json', highlightActiveLine: false, foldGutter: false }}
      />
    </div>
  );
}
