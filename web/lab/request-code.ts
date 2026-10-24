export interface RequestCodeInput {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: string;
  stream?: boolean;
}

export function placeholderize(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body ?? null), (_key, value) =>
    value && typeof value === 'object' && typeof value.$asset === 'string'
      ? `<素材 ${value.$asset} · ${value.as ?? 'dataUrl'}>`
      : value,
  );
}
function bashQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function psQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
function bashWithKey(value: string) {
  return value.split('$API_KEY').map(bashQuote).join('"${API_KEY}"');
}
function psWithKey(value: string, url = false) {
  if (!value.includes('$API_KEY')) return psQuote(value);
  const variable = url ? '[Uri]::EscapeDataString($env:API_KEY)' : '$env:API_KEY';
  return `(${value.split('$API_KEY').map(psQuote).join(` + ${variable} + `)})`;
}

export function toCurl(request: RequestCodeInput): string {
  if (!request.method || !request.url) return '';
  const lines = [`curl${request.stream ? ' -N' : ''} -X ${bashQuote(request.method)} ${bashWithKey(request.url)}`];
  for (const [key, value] of Object.entries(request.headers ?? {}))
    lines.push(`  -H ${bashWithKey(`${key}: ${value}`)}`);
  if (request.bodyType === 'json' && request.body !== undefined)
    lines.push(`  --data-binary ${bashQuote(JSON.stringify(placeholderize(request.body), null, 2))}`);
  if (request.bodyType === 'multipart' && request.body) {
    const body = request.body as any;
    for (const [key, value] of Object.entries(body.fields ?? {}))
      lines.push(`  --form-string ${bashQuote(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)}`);
    for (const key of Object.keys(body.files ?? {})) lines.push(`  -F ${bashQuote(`${key}=@<本地文件>`)}`);
  }
  const command = lines.join(' \\\n');
  return /\$API_KEY/.test(JSON.stringify([request.url, request.headers]))
    ? `# 先在当前终端设置环境变量 API_KEY\n: "\${API_KEY:?请先设置 API_KEY}"\n${command}`
    : command;
}

export function toPowerShell(request: RequestCodeInput): string {
  if (!request.method || !request.url) return '';
  const hasKey = /\$API_KEY/.test(JSON.stringify([request.url, request.headers]));
  const lines: string[] = [];
  if (hasKey) lines.push('# 先设置 $env:API_KEY', "if (-not $env:API_KEY) { throw '请先设置 API_KEY' }");
  if (request.bodyType === 'multipart') lines.push('# Multipart 的 -Form 参数需要 PowerShell 7 或更新版本');
  if (request.stream) lines.push('# Invoke-WebRequest 会缓冲流式响应；实时查看 SSE 可使用 Bash curl 示例');
  lines.push(
    '$request = @{',
    `  Uri = ${psWithKey(request.url, true)}`,
    `  Method = ${psQuote(request.method)}`,
    '  Headers = @{',
  );
  for (const [key, value] of Object.entries(request.headers ?? {}))
    lines.push(`    ${psQuote(key)} = ${psWithKey(value)}`);
  lines.push('  }');
  if (request.bodyType === 'json' && request.body !== undefined)
    lines.push(
      `  Body = [Text.Encoding]::UTF8.GetBytes(${psQuote(JSON.stringify(placeholderize(request.body), null, 2))})`,
    );
  if (request.bodyType === 'multipart' && request.body) {
    const body = request.body as any;
    lines.push('  Form = @{');
    for (const [key, value] of Object.entries(body.fields ?? {}))
      lines.push(`    ${psQuote(key)} = ${psQuote(typeof value === 'string' ? value : JSON.stringify(value))}`);
    for (const key of Object.keys(body.files ?? {}))
      lines.push(`    ${psQuote(key)} = Get-Item -LiteralPath '<本地文件>'`);
    lines.push('  }');
  }
  lines.push('}', 'Invoke-WebRequest @request');
  return lines.join('\n');
}
