import { getOperation } from './catalog.ts';
import type { ConnectionInfo, LabState, RunRecord } from './types.ts';
import type { BenchRecord } from './bench.ts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export interface ComparisonAudit {
  ready: boolean;
  shared: string[];
  differences: { axis: string; lanes: string[] }[];
  notes: string[];
}

function compareAxis(out: ComparisonAudit, name: string, values: unknown[], unknownIsShared = false) {
  if (!unknownIsShared && values.some((value) => value === undefined || value === null)) {
    out.notes.push(`${name}：部分记录未保存，无法确认条件一致。`);
  } else if (values.every((v) => stable(v) === stable(values[0]))) out.shared.push(name);
  else
    out.differences.push({
      axis: name,
      lanes: values.map((v) => (v == null ? '未记录' : typeof v === 'string' ? v : stable(v))),
    });
}

/** Historical evidence must never be rebuilt using today's connection or catalog. */
export function auditRecordedComparison(records: RunRecord[]): ComparisonAudit {
  const out: ComparisonAudit = { ready: false, shared: [], differences: [], notes: [] };
  if (records.length < 2) return out;
  out.ready = records.every((r) => r.request?.url && r.request?.method);
  compareAxis(
    out,
    '实际请求地址',
    records.map((r) => r.request?.url),
  );
  compareAxis(
    out,
    '实际网络路由',
    records.map((r) => r.request?.route),
  );
  compareAxis(
    out,
    '请求方法',
    records.map((r) => r.request?.method),
  );
  compareAxis(
    out,
    '运行时模型',
    records.map((r) => r.model),
  );
  compareAxis(
    out,
    '已发送请求体',
    records.map((r) => r.request?.body),
  );
  compareAxis(
    out,
    '连接快照',
    records.map((r) => r.request?.connectionSnapshot),
  );
  out.notes.push('按运行时保存的请求与路由核对，不受当前连接编辑、删除或目录更新影响。');
  out.notes.push('凭据没有写入报告；相同连接标识或掩码不能证明账户身份相同。缓存、账户限流与上游负载也可能变化。');
  if (records.some((r) => r.lifecycle === 'async-task'))
    out.notes.push('异步任务的提交耗时与最终完成耗时不同，请等产物完成后再比较。');
  return out;
}

/** Each selected stage is compared explicitly, rather than silently using its last concurrency. */
export function auditBenchmarkComparison(entries: { record: BenchRecord; stageIndex: number }[]): ComparisonAudit {
  const out: ComparisonAudit = { ready: entries.length >= 2, shared: [], differences: [], notes: [] };
  if (!out.ready) return out;
  const records = entries.map((e) => e.record);
  compareAxis(
    out,
    '运行时地址与路由',
    records.map((r) => r.connectionSnapshot),
  );
  compareAxis(
    out,
    '协议',
    records.map((r) => r.config.endpoint),
  );
  compareAxis(
    out,
    '模式',
    records.map((r) => r.config.mode),
  );
  compareAxis(
    out,
    '所选档位并发',
    entries.map(({ record, stageIndex }) => record.stages[stageIndex]?.concurrency),
  );
  for (const [key, label] of [
    ['model', '模型'],
    ['prompts', '提示词集合'],
    ['promptStrategy', '提示词轮换'],
    ['promptWeights', '提示词权重'],
    ['customBody', '完整请求体'],
    ['extraBody', '附加请求体'],
    ['maxTokens', '输出上限'],
    ['temperature', '表单温度'],
    ['stream', '流式'],
    ['http2', 'HTTP/2'],
    ['warmup', '预热'],
    ['retries429', '429 重试'],
    ['retriesNetwork', '网络重试'],
    ['retries5xx', '5xx 重试'],
    ['timeoutSeconds', '超时秒数'],
    ['totalRequests', '每档目标请求数'],
    ['durationSeconds', '配置持续秒数'],
    ['targetRps', '目标 RPS'],
  ] as const)
    compareAxis(
      out,
      label,
      records.map((r) => r.config[key]),
      true,
    );
  compareAxis(
    out,
    '样本实际请求体',
    entries.map(
      ({ record, stageIndex }) => record.stages[stageIndex]?.results.find((r) => r.request_body)?.request_body,
    ),
  );
  if (records.some((r) => r.status === 'imported'))
    out.notes.push('包含导入报告：来源和配置由文件提供，不能作为本机真实调用的证明。');
  if (records.some((r) => r.status !== 'completed' && r.status !== 'imported'))
    out.notes.push('包含停止、失败或中断的记录；所选档位可能只有部分请求，尾延迟和吞吐不能直接视为完整一轮结果。');
  out.notes.push('相同配置仍不能保证账户、缓存、地域、Token 计数或上游负载相同；少量请求不足以形成排名。');
  return out;
}
/** Audit actual built requests; disabled or model-inapplicable parameters do not count. */
export function auditComparison(states: Partial<LabState>[], connections: ConnectionInfo[]): ComparisonAudit {
  const out: ComparisonAudit = { ready: false, shared: [], differences: [], notes: [] };
  if (states.length < 2) return out;
  const lanes = states.map((s) => {
    const op = getOperation(s.operationId);
    const conn = connections.find((c) => c.id === s.connectionId);
    if (!op) return null;
    try {
      const req = op.build({
        model: s.model ?? '',
        input: s.input ?? {},
        params: s.params ?? {},
        extra: conn?.extra ?? {},
      });
      return { s, op, conn, req };
    } catch {
      return null;
    }
  });
  if (lanes.some((x) => !x)) {
    out.notes.push('部分通道暂时无法构建请求，请先修正输入或原生参数。');
    return out;
  }
  const valid = lanes.filter((x) => x !== null);
  out.ready = valid.every((x) => x.conn && x.s.model);
  const axis = (name: string, values: unknown[], labels?: string[]) => {
    if (values.every((v) => stable(v) === stable(values[0]))) out.shared.push(name);
    else
      out.differences.push({ axis: name, lanes: labels ?? values.map((v) => (typeof v === 'string' ? v : stable(v))) });
  };
  axis(
    '工作台与生命周期',
    valid.map((x) => `${x.op.workbench} / ${x.op.lifecycle}`),
  );
  axis(
    'API 协议',
    valid.map((x) => x.op.protocol ?? 'json'),
  );
  axis(
    '服务、账户与路由',
    valid.map((x) => `${x.conn?.providerId}/${x.conn?.id}/${x.conn?.baseUrl}/${x.conn?.network}`),
    valid.map((x) => (x.conn ? `${x.conn.label} · ${x.conn.baseUrl} · ${x.conn.network}` : '未选连接')),
  );
  axis(
    '模型快照',
    valid.map((x) => x.s.model),
  );
  axis(
    '输入与系统指令',
    valid.map((x) => x.s.input),
    valid.map((x) => stable(x.s.input)),
  );
  axis(
    '原生端点',
    valid.map((x) => `${x.req.method} ${x.req.path}`),
  );
  const bodies = valid.map((x) =>
    x.req.body && typeof x.req.body === 'object' ? (x.req.body as Record<string, unknown>) : {},
  );
  const nativeKeys = new Set(
    bodies
      .flatMap((b) => Object.keys(b))
      .filter(
        (k) =>
          ![
            'model',
            'messages',
            'contents',
            'systemInstruction',
            'system',
            'prompt',
            'suffix',
            'input',
            'text',
          ].includes(k),
      ),
  );
  for (const k of nativeKeys)
    axis(
      `发送字段 ${k}`,
      bodies.map((b) => b[k]),
      bodies.map((b) => (b[k] === undefined ? '未发送' : stable(b[k]))),
    );
  if (!out.ready) out.notes.push('先为全部通道选择有效连接和模型，再判断路由与账户条件。');
  if (valid.some((x) => x.op.protocol !== valid[0].op.protocol))
    out.notes.push('协议间的思考预算、Token 计数和温度数值可能含义不同，不按同名参数推定等价。');
  if (valid.some((x) => x.op.lifecycle === 'async-task'))
    out.notes.push('任务提交耗时与最终生成耗时不同，请等待产物完成后再比较。');
  out.notes.push('缓存、地域、账户限流与上游负载仍可能变化；本报告只核对已知配置，不给出虚构的公平度分数。');
  return out;
}
