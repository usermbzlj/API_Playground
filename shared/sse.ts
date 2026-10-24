export interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
}

/** Incremental SSE framing, including CRLF split across reads and a final EOF frame. */
export class SSEDecoder {
  private buffer = '';
  private lines: string[] = [];
  private readonly emit: (message: SSEMessage) => void;
  constructor(emit: (message: SSEMessage) => void) {
    this.emit = emit;
  }

  feed(text: string, eof = false) {
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      if (ch === '\r' && i === this.buffer.length - 1 && !eof) break;
      const line = this.buffer.slice(start, i);
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
      this.accept(line);
    }
    this.buffer = this.buffer.slice(start);
    if (eof) {
      if (this.buffer) this.accept(this.buffer);
      this.buffer = '';
      this.accept('');
    }
  }

  private accept(line: string) {
    if (line) {
      this.lines.push(line);
      return;
    }
    const data: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    for (const entry of this.lines.splice(0)) {
      const at = entry.indexOf(':');
      const field = at < 0 ? entry : entry.slice(0, at);
      const value = at < 0 ? '' : entry.slice(at + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      if (field === 'event') event = value;
      if (field === 'id' && !value.includes('\0')) id = value;
    }
    if (data.length) this.emit({ data: data.join('\n'), event, id });
  }
}
