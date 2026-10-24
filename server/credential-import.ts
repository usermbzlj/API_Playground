// Local credential documents are parsed as data. Only headings and named fields are recognized.
import { getProvider } from '../shared/catalog.ts';
import { redactSensitive } from '../shared/redact.ts';

export interface ImportCandidate {
  sourceTitle: string;
  sourceStatus: string;
  keyField: string;
  providerId: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  extra: Record<string, string>;
}
export interface ImportPlan {
  sections: number;
  credentials: number;
  candidates: ImportCandidate[];
  warnings: string[];
}

const NATIVE: [RegExp, string][] = [
  [/^DeepSeek(?:\s|$)/i, 'deepseek'],
  [/^阿里云百炼/, 'qwen'],
  [/^Moonshot|^Kimi\s*[/（(]/i, 'kimi'],
  [/^MiniMax(?:\s|$)/i, 'minimax'],
  [/^字节火山引擎/, 'ark'],
  [/^小米 MiMo/, 'mimo'],
];

function safeBase(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('地址必须为不含账号、查询参数或片段的 HTTP(S) URL');
  // A document may contain the complete operation URL. Store its API root instead.
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|v1\/messages|messages)\/?$/, '');
  return url.toString().replace(/\/+$/, '');
}

function modelHint(title: string, keyField: string): string {
  if (/TokenHub/.test(title)) return 'glm-5.3-flash';
  if (/Experiential/.test(title)) return 'deepseek-v4-flash';
  if (/passion8/.test(title)) return 'claude-haiku-4-5-20251001';
  if (/infron/i.test(title)) return 'sao10k/l3.1-70b-hanami-x1';
  if (/InternAI/.test(title)) return 'deepseek-v4.1-flash-1017';
  if (/KuaiAPI/.test(title))
    return (
      ({ key1: 'claude-haiku-4-5', key2: 'gpt-5.6-sol', key3: 'grok-4.5' } as Record<string, string>)[keyField] ?? ''
    );
  if (/小米 MiMo/.test(title)) return 'mimo-v2.6-flash';
  return '';
}

export function parseCredentialDocument(text: string): ImportPlan {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 512 * 1024)
    throw new Error('凭证文件上限为 512 KB');
  const secrets = [...text.matchAll(/^\s*key\d*:\s*(\S+)\s*$/gim)].map((m) => m[1]);
  const safeText = (value: string) => {
    let result = value;
    for (const key of secrets) if (key.length >= 8) result = result.replaceAll(key, '***已隐藏***');
    return String(redactSensitive(result));
  };
  const plan: ImportPlan = { sections: 0, credentials: 0, candidates: [], warnings: [] };
  const unique = new Set<string>();
  for (const section of text
    .replace(/^\uFEFF/, '')
    .split(/^##\s+/m)
    .slice(1)) {
    const [heading, ...lines] = section.split(/\r?\n/);
    const [titleRaw, statusRaw = '未标注'] = heading.split('|').map((s) => s.trim());
    const title = safeText(titleRaw);
    plan.sections++;
    const fields = new Map<string, string>();
    for (const line of lines) {
      const m = line.match(/^\s*(url|key\d*|model|balance|note):\s*(.*?)\s*$/i);
      if (m) fields.set(m[1].toLowerCase(), m[2]);
    }
    const keys = [...fields].filter(([name]) => /^key\d*$/.test(name));
    const urlField = fields.get('url') ?? '';
    const urls = [...urlField.matchAll(/https?:\/\/[^\s，；;（）()<>"'`]+/g)];
    if (!keys.length || !urls.length) {
      plan.warnings.push(`${title}：缺少 Key 或 URL，未导入`);
      continue;
    }
    for (const [keyField, apiKey] of keys) {
      if (!/^[\x21-\x7e]{8,8192}$/.test(apiKey) || /^(?:待填|REDACTED|YOUR_|<)/i.test(apiKey)) {
        plan.warnings.push(`${title} · ${keyField}：凭证格式无效，未导入`);
        continue;
      }
      plan.credentials++;
      for (let i = 0; i < urls.length; i++) {
        const match = urls[i];
        let base: string;
        try {
          base = safeBase(match[0]);
        } catch {
          plan.warnings.push(`${title}：地址格式不安全，未导入该入口`);
          continue;
        }
        const context = urlField.slice(i ? urls[i - 1].index! + urls[i - 1][0].length : 0, match.index);
        const afterUrl = urlField.slice(match.index! + match[0].length);
        const anthropic =
          /\/(?:anthropic(?:\/|$)|v1\/messages\/?$)/i.test(new URL(match[0]).pathname) ||
          /(?:Anthropic|SystemOne)(?:\s*(?:base|兼容|协议|格式|API|接口))*\s*[:：]?\s*$/i.test(context) ||
          /^\s*[（(][^）)]*(?:Anthropic|SystemOne)[^）)]*[）)]/i.test(afterUrl) ||
          (/Kimi Code|CodeMirror/i.test(title) && urls.length === 1);
        if (anthropic) base = base.replace(/\/v1$/, '');
        let providerId = anthropic ? 'custom-anthropic' : 'custom-openai';
        if (!anthropic) {
          const native = NATIVE.find(([re]) => re.test(title));
          const provider = native && getProvider(native[1]);
          // Native operation paths are rooted at the vendor host, not an OpenAI compatibility suffix.
          if (provider?.baseUrls.some((b) => new URL(b.url).hostname === new URL(base).hostname)) {
            providerId = provider.id;
            base = new URL(base).origin;
          }
        }
        const identity = `${providerId}\n${base}\n${apiKey}`;
        if (unique.has(identity)) continue;
        unique.add(identity);
        const group = /KuaiAPI/i.test(title)
          ? ({ key1: 'Claude 组', key2: 'OpenAI 组', key3: 'Grok 组' } as Record<string, string>)[keyField]
          : '';
        const account = keys.length > 1 ? ` · ${group || `账户 ${keyField.replace('key', '') || '1'}`}` : '';
        const protocol = anthropic ? 'Anthropic' : providerId === 'custom-openai' ? 'OpenAI' : '原生';
        const extra: Record<string, string> = {
          sourceTitle: title,
          sourceStatus: safeText(statusRaw),
          sourceKeyField: keyField,
          sourceNotes: safeText(fields.get('note') ?? ''),
          sourceModelNotes: safeText(fields.get('model') ?? ''),
          sourceBalanceNotes: safeText(fields.get('balance') ?? ''),
          protocol,
        };
        const hint = modelHint(title, keyField);
        if (hint && `${fields.get('model') ?? ''}\n${fields.get('note') ?? ''}`.includes(hint))
          extra.defaultModel = hint;
        if (anthropic && /小米 MiMo/.test(title)) {
          extra.authHeader = 'api-key';
          extra.authPrefix = 'none';
        }
        plan.candidates.push({
          sourceTitle: title,
          sourceStatus: extra.sourceStatus,
          keyField,
          providerId,
          label: `${title}${account}${urls.length > 1 || providerId.startsWith('custom-') ? ` · ${protocol}` : ''}`,
          baseUrl: base,
          apiKey,
          extra,
        });
      }
    }
  }
  if (!plan.sections) throw new Error('未找到 ## 服务名 标题及 url/key 字段');
  return plan;
}

export async function importCredentialDocument(text: string, apply: boolean) {
  const plan = parseCredentialDocument(text);
  const { listConnections, createConnection, updateConnection } = await import('./connections.ts');
  const { getSecret, maskKey } = await import('./secrets.ts');
  const existing = listConnections();
  let created = 0;
  let reused = 0;
  const entries = plan.candidates.map((c) => {
    let connection = existing.find(
      (e) => e.providerId === c.providerId && e.baseUrl === c.baseUrl && getSecret(e.id)?.key === c.apiKey,
    );
    const found = !!connection;
    if (apply) {
      if (connection) {
        connection = updateConnection(connection.id, { extra: { ...connection.extra, ...c.extra } });
        reused++;
      } else {
        connection = createConnection(c);
        existing.push(connection);
        created++;
      }
    }
    return {
      sourceTitle: c.sourceTitle,
      sourceStatus: c.sourceStatus,
      keyField: c.keyField,
      label: connection?.label ?? c.label,
      providerId: c.providerId,
      baseUrl: c.baseUrl,
      keyPreview: maskKey(c.apiKey),
      existing: found,
      connectionId: connection?.id,
      protocol: c.extra.protocol,
      modelHint: c.extra.defaultModel ?? '',
      notes: c.extra.sourceNotes,
    };
  });
  return {
    applied: apply,
    sections: plan.sections,
    credentials: plan.credentials,
    entries,
    warnings: plan.warnings,
    created,
    reused,
  };
}
