import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeRequest } from '../../shared/types.ts';
import { redactSensitive, omitRedactedHeaders } from '../../shared/redact.ts';
import { joinApiUrl } from '../../shared/util.ts';
import { listOperations } from '../../shared/catalog.ts';
import { initialParamState } from '../../shared/util.ts';
import { api, type UserPreset } from '../api.ts';
import { useApp } from '../app.tsx';
import { useRoute } from '../router.ts';
import { useRunner } from '../lab/useRunner.ts';
import { RequestPreview } from '../lab/preview.tsx';
import { EventList, MetricsPanel } from '../lab/inspector.tsx';
import { CodeInput, EmptyHint, ErrorBox, Field, JsonBlock, Modal, Spinner, StatusBadge, Tabs } from '../ui.tsx';
import { Page, ArtifactGallery, downloadJson } from './common.tsx';
import { renderRequestTemplate } from '../../shared/request-template.ts';
import { readDraft, usePersistentDraft } from '../workspace-state.ts';

interface PendingRaw {
  connectionId: string;
  label: string;
  request: NativeRequest;
  parentId: string | null;
}

const EXAMPLES: { title: string; request: NativeRequest }[] = [
  {
    title: 'OpenAI Chat Completions',
    request: {
      method: 'POST',
      path: '/chat/completions',
      body: {
        model: '填写模型ID',
        messages: [{ role: 'user', content: '你好，请介绍你支持的能力。' }],
        max_tokens: 256,
        stream: true,
      },
      stream: true,
    },
  },
  {
    title: 'Anthropic Messages',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' },
      body: { model: '填写模型ID', max_tokens: 256, messages: [{ role: 'user', content: '你好' }] },
      stream: false,
    },
  },
  { title: '查询模型列表', request: { method: 'GET', path: '/models', stream: false } },
  {
    title: '变量化 Chat 模板',
    request: {
      method: 'POST',
      path: '/chat/completions',
      body: { model: '{{MODEL}}', messages: [{ role: 'user', content: '{{PROMPT}}' }], max_tokens: 128 },
      stream: false,
    },
  },
  { title: 'JSON 自定义端点', request: { method: 'POST', path: '/填写端点', headers: {}, body: {}, stream: false } },
];

export function RawPage() {
  const { connections, toast, refreshEvidence } = useApp();
  const route = useRoute();
  const runId = route.query.get('run');
  const workspaceKey = `raw:${route.query.toString()}`;
  const existingDraft = useRef(readDraft(workspaceKey) !== undefined);
  const runner = useRunner(() => {
    void refreshEvidence();
  }, workspaceKey);
  const [restoring, setRestoring] = useState(!!runId && !runner.runId);
  const [draft, setDraft, draftActions] = usePersistentDraft(
    workspaceKey,
    () => ({
      connectionId: route.query.get('connection') ?? '',
      method: 'POST' as NativeRequest['method'],
      path: '/chat/completions',
      headers: '{}',
      body: JSON.stringify(EXAMPLES[0].request.body, null, 2),
      stream: true,
      bodyType: 'json' as 'json' | 'multipart' | 'none',
      variablesEnabled: false,
      templatePrompt: '请用一句话介绍你的原生能力。',
      templateModel: '',
    }),
    { title: '原始请求调试', href: window.location.hash },
  );
  const {
    connectionId,
    method,
    path,
    headers,
    body,
    stream,
    bodyType,
    variablesEnabled,
    templatePrompt,
    templateModel,
  } = draft;
  const update = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const setConnectionId = (value: string) => update('connectionId', value);
  const setMethod = (value: NativeRequest['method']) => update('method', value);
  const setPath = (value: string) => update('path', value);
  const setHeaders = (value: string) => update('headers', value);
  const setBody = (value: string) => update('body', value);
  const setStream = (value: boolean) => update('stream', value);
  const setBodyType = (value: typeof bodyType) => update('bodyType', value);
  const setVariablesEnabled = (value: boolean) => update('variablesEnabled', value);
  const setTemplatePrompt = (value: string) => update('templatePrompt', value);
  const setTemplateModel = (value: string) => update('templateModel', value);
  const [templates, setTemplates] = useState<UserPreset[]>([]);
  const [confirming, setConfirming] = useState<PendingRaw | null>(null);
  const pending = useRef<PendingRaw | null>(null);
  const launching = useRef(false);
  const [tab, setTab] = useState('response');
  const [templateTitle, setTemplateTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const savingLock = useRef(false);
  const [restored, setRestored] = useState('');
  const conn = connections.find((c) => c.id === connectionId);
  const seeded = useRef(false);
  useEffect(() => {
    if (route.query.get('from') !== 'bench' || existingDraft.current || runner.running) return;
    try {
      const raw = sessionStorage.getItem('raw-bench-seed');
      if (!raw) return;
      sessionStorage.removeItem('raw-bench-seed');
      const seed = JSON.parse(raw);
      if (!seed?.request || typeof seed.connectionId !== 'string') throw new Error('样本格式不完整');
      apply(seed.request);
      setConnectionId(seed.connectionId);
      setRestored('已载入评测样本的实际请求体。此操作没有重新调用 API；发送前请核对当前账户、原生字段与费用。');
    } catch (e: any) {
      toast(`无法载入评测样本：${e.message}`, 'err');
    }
  }, []);
  useEffect(() => {
    if (!connectionId && connections.length) setConnectionId(connections[0].id);
  }, [connections, connectionId]);
  useEffect(() => {
    api
      .presets()
      .then((p) => setTemplates(p.filter((x) => x.operationId === 'raw')))
      .catch((e) => toast(e.message, 'err'));
  }, [toast]);
  function apply(r: NativeRequest) {
    setVariablesEnabled(JSON.stringify(r.body ?? {}).includes('{{'));
    setMethod(r.method);
    setPath(r.path);
    setHeaders(JSON.stringify(omitRedactedHeaders(r.headers ?? {}), null, 2));
    setBody(r.body === undefined ? '' : JSON.stringify(r.body, null, 2));
    setStream(!!r.stream);
    setBodyType(r.bodyType ?? (r.body === undefined ? 'none' : 'json'));
  }
  useEffect(() => {
    if (seeded.current || existingDraft.current || runId || !conn || !route.query.has('connection')) return;
    seeded.current = true;
    const op = listOperations(conn.providerId).find((o) => o.workbench === 'chat');
    if (op)
      apply(
        op.build({
          model: conn.extra.defaultModel || op.defaultModel || '填写模型ID',
          input: { messages: [{ role: 'user', content: '你好' }], stream: true },
          params: initialParamState(op.params),
          extra: conn.extra,
        }),
      );
  }, [conn, runId]);
  useEffect(() => {
    if (!runId || runner.running || runner.runId) return;
    let cancelled = false;
    api
      .run(runId)
      .then((r) => {
        if (cancelled) return;
        const req = r.input?.request;
        if (req) {
          if (!existingDraft.current) {
            apply(req);
            setConnectionId(r.connectionId);
          }
          setRestored(
            existingDraft.current
              ? '保留编辑草稿，结果区展示原实验的已发送请求与响应。'
              : '已载入历史请求。历史凭证已脱敏，请通过连接管理鉴权，必要时重新填写自定义敏感字段。',
          );
        } else toast('该记录没有可复用的原始请求定义', 'err');
        runner.load({
          events: r.events ?? [],
          request: r.request,
          response: r.response,
          metrics: r.metrics ?? null,
          error: r.error,
          artifacts: r.artifacts ?? [],
          runId: r.id,
          status: r.status,
          inputSnapshot: { connectionId: r.connectionId, request: req, parentId: runId },
        });
      })
      .catch((e) => toast(e.message, 'err'))
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);
  function request(): NativeRequest | null {
    try {
      const h = JSON.parse(headers || '{}');
      if (!h || Array.isArray(h) || typeof h !== 'object' || Object.values(h).some((v) => typeof v !== 'string'))
        throw Error('Headers 必须是字符串值的 JSON 对象');
      if (Object.values(h).some((v) => /[\r\n]/.test(String(v)))) throw Error('Headers 不能包含换行');
      if (!path.trim()) throw Error('请填写请求路径');
      const parsed = bodyType === 'none' || !body.trim() ? undefined : JSON.parse(body);
      const b = variablesEnabled
        ? renderRequestTemplate(parsed, { PROMPT: templatePrompt, MODEL: templateModel })
        : parsed;
      if (variablesEnabled && JSON.stringify(parsed)?.includes('{{MODEL}}') && !templateModel.trim())
        throw new Error('请填写模板模型 ID');
      return { method, path: path.trim(), headers: omitRedactedHeaders(h), body: b, bodyType, stream };
    } catch (e: any) {
      toast(`请求配置无效：${e.message}`, 'err');
      return null;
    }
  }
  function closeConfirmation() {
    pending.current = null;
    setConfirming(null);
  }
  function prepareRun() {
    if (restoring || runner.running || launching.current || pending.current) return;
    if (!conn) {
      toast('请选择当前有效连接', 'err');
      return;
    }
    const r = request();
    if (!r) return;
    const p = { connectionId: conn.id, label: conn.label, request: structuredClone(r), parentId: runId };
    pending.current = p;
    setConfirming(p);
  }
  function launchRun() {
    const p = pending.current;
    if (!p || launching.current) return;
    pending.current = null;
    launching.current = true;
    setConfirming(null);
    setTab('response');
    void runner
      .start({
        connectionId: p.connectionId,
        request: p.request,
        title: `RAW ${p.request.method} ${p.request.path}`,
        confirmCost: true,
        parentId: p.parentId,
      })
      .finally(() => {
        launching.current = false;
      });
  }
  const preview = useMemo(() => {
    try {
      const h = JSON.parse(headers || '{}');
      return redactSensitive({
        method,
        url: conn ? joinApiUrl(conn.baseUrl, path) : path,
        headers: h,
        body:
          bodyType === 'none' || !body.trim()
            ? undefined
            : variablesEnabled
              ? renderRequestTemplate(JSON.parse(body), { PROMPT: templatePrompt, MODEL: templateModel })
              : JSON.parse(body),
        bodyType,
      });
    } catch (e: any) {
      return { error: `JSON 或地址尚未完整：${e.message}` };
    }
  }, [method, path, conn, headers, body, bodyType, variablesEnabled, templatePrompt, templateModel]);
  async function saveTemplate() {
    if (savingLock.current) return;
    const r = request();
    if (!r || !templateTitle.trim()) return;
    savingLock.current = true;
    setSaving(true);
    try {
      const template = variablesEnabled && bodyType !== 'none' ? { ...r, body: JSON.parse(body) } : r;
      await api.savePreset({
        operationId: 'raw',
        title: templateTitle.trim(),
        input: { request: redactSensitive(template) },
      });
      setTemplates((await api.presets()).filter((p) => p.operationId === 'raw'));
      setTemplateTitle('');
      toast('模板已保存；敏感字段已过滤');
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }
  return (
    <Page
      title="原始请求调试台"
      description="直接向连接的可信端点发送原生 HTTP / SSE 请求，用于尝试未适配参数和新接口。连接凭证由本机服务注入；所有运行都保存为实验记录。"
    >
      {connectionId && !conn && (
        <ErrorBox
          error={{ title: '历史连接已失效', hints: ['原连接已删除，请选择有效连接。复用操作不会自动换用其他账户。'] }}
        />
      )}
      {restored && <p className="text-sm text-amber-200">{restored}</p>}
      {restoring && (
        <p role="status" className="text-xs text-zinc-400">
          正在载入历史请求与结果…
        </p>
      )}
      {draftActions.restored && (
        <p className="text-xs text-violet-300" role="status">
          已恢复当前标签页的草稿。敏感请求头不会保存到浏览器存储。
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <span>编辑会自动保留；切换页面后可从首页继续。</span>
        <a
          href={`#/connections?returnTo=${encodeURIComponent(window.location.hash)}`}
          className="text-violet-300 hover:underline"
        >
          管理连接并返回
        </a>
        <a href="#/assets" className="text-violet-300 hover:underline">
          查找素材 ID →
        </a>
      </div>
      {!connections.length && (
        <EmptyHint>
          先到
          <a className="text-violet-300" href={`#/connections?returnTo=${encodeURIComponent(window.location.hash)}`}>
            连接与 Key
          </a>
          添加 API 连接。
        </EmptyHint>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <fieldset disabled={restoring} aria-label="请求配置" className="card min-w-0 space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input min-w-48 flex-1"
              aria-label="请求连接"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              <option value="">选择连接</option>
              {connectionId && !conn && <option value={connectionId}>历史连接已失效，请重新选择</option>}
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              className="input w-28"
              value={method}
              onChange={(e) => setMethod(e.target.value as NativeRequest['method'])}
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <Field label="路径或受允许的完整 URL" hint={conn?.baseUrl ?? '先选择连接'}>
            <input
              className="input mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/chat/completions"
            />
          </Field>
          <Field label="Headers JSON" hint="通常不必填写 Authorization，鉴权由连接提供。请勿在模板中保存真实密钥。">
            <CodeInput value={headers} onChange={setHeaders} minHeight={70} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <select
              className="input w-48"
              value={bodyType}
              onChange={(e) => setBodyType(e.target.value as typeof bodyType)}
            >
              <option value="json">JSON 请求体</option>
              <option value="multipart">Multipart 素材引用</option>
              <option value="none">不发送请求体</option>
            </select>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
              SSE 流式响应
            </label>
          </div>
          {bodyType !== 'none' && (
            <Field
              label="原生请求体"
              hint={
                bodyType === 'multipart'
                  ? '格式：{"fields":{"model":"..."},"files":{"file":{"$asset":"素材ID"}}}。可在实验台上传素材并复用其 ID。'
                  : undefined
              }
            >
              <CodeInput value={body} onChange={setBody} minHeight={240} />
            </Field>
          )}
          {bodyType === 'json' && (
            <div className="space-y-3 rounded-lg border border-zinc-800 p-3">
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={variablesEnabled}
                  onChange={(e) => setVariablesEnabled(e.target.checked)}
                />
                启用请求体变量
              </label>
              {variablesEnabled && (
                <>
                  <Field label="MODEL · 模型 ID">
                    <input
                      className="input mono"
                      value={templateModel}
                      onChange={(e) => setTemplateModel(e.target.value)}
                    />
                  </Field>
                  <Field label="PROMPT · 测试输入">
                    <textarea
                      className="input"
                      value={templatePrompt}
                      onChange={(e) => setTemplatePrompt(e.target.value)}
                    />
                  </Field>
                  <p className="text-xs text-zinc-400">
                    在 JSON 字符串值中使用 {'{{MODEL}}'} 和 {'{{PROMPT}}'}
                    。右侧实时预览替换结果；模板校验本身不会发送请求。
                  </p>
                </>
              )}
            </div>
          )}
          <div className="workspace-actionbar flex flex-wrap items-center gap-3">
            <button className="btn-primary" disabled={runner.running || !conn} onClick={prepareRun}>
              {runner.running ? <Spinner /> : '发送真实请求 →'}
            </button>
            {runner.running && (
              <button className="btn-outline" onClick={runner.abort}>
                中止
              </button>
            )}
            {runner.runId && (
              <a className="text-xs text-violet-300" href={`#/runs/${runner.runId}`}>
                查看已保存记录
              </a>
            )}
            <a
              href="#raw-output"
              className="btn-ghost text-xs"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById('raw-output')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              查看结果 ↓
            </a>
          </div>
        </fieldset>
        <aside className="space-y-4">
          <section className="card space-y-3 p-5">
            <h2 className="font-semibold text-zinc-100">请求预览 · 已隐藏已知凭证</h2>
            <RequestPreview preview={preview} />
          </section>
          <section className="card space-y-3 p-5">
            <h2 className="font-semibold text-zinc-100">请求模板</h2>
            <select
              className="input"
              disabled={restoring || runner.running}
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith('builtin:')) apply(EXAMPLES[Number(v.split(':')[1])].request);
                else {
                  const t = templates.find((t) => t.id === v);
                  if (t?.input?.request) apply(t.input.request);
                }
                e.target.value = '';
              }}
            >
              <option value="">选择示例 / 我的模板…</option>
              <optgroup label="起步示例（模型 ID 需填写）">
                {EXAMPLES.map((x, i) => (
                  <option key={i} value={`builtin:${i}`}>
                    {x.title}
                  </option>
                ))}
              </optgroup>
              <optgroup label="我的模板">
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </optgroup>
            </select>
            <div className="flex gap-2">
              <input
                className="input min-w-0 flex-1"
                value={templateTitle}
                onChange={(e) => setTemplateTitle(e.target.value)}
                placeholder="给当前请求模板命名"
              />
              <button className="btn-outline" disabled={saving || !templateTitle.trim()} onClick={saveTemplate}>
                保存
              </button>
            </div>
            {templates.map((t) => (
              <div className="flex items-center gap-2 text-xs text-zinc-400" key={t.id}>
                <span className="flex-1">{t.title}</span>
                <button
                  className="btn-ghost"
                  onClick={async () => {
                    try {
                      await api.deletePreset(t.id);
                      setTemplates((p) => p.filter((x) => x.id !== t.id));
                    } catch (e: any) {
                      toast(e.message, 'err');
                    }
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </section>
        </aside>
      </div>
      {(runner.running || runner.error || runner.events.length > 0 || runner.status || runner.response) && (
        <section id="raw-output" className="card scroll-mt-20 space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold text-zinc-100">调用结果</h2>
            {runner.status && <StatusBadge status={runner.status} />}
            <button
              className="btn-ghost"
              onClick={() =>
                downloadJson(
                  {
                    request: runner.request,
                    response: runner.response,
                    events: runner.events,
                    metrics: runner.metrics,
                  },
                  `raw-${runner.runId ?? Date.now()}.json`,
                )
              }
            >
              导出脱敏结果
            </button>
          </div>
          {runner.inputSnapshot && (
            <p className="text-xs text-zinc-400">结果对应实际发送的请求。编辑器中的后续修改只影响下一次运行。</p>
          )}
          <ErrorBox error={runner.error} />
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              ['response', '响应'],
              ['request', '实际请求'],
              ['events', `事件 (${runner.events.length})`],
              ['metrics', '指标'],
            ]}
          />
          {tab === 'response' && (
            <>
              <JsonBlock value={runner.response ?? '流式结果请查看事件列表'} />
              <ArtifactGallery assets={runner.artifacts} />
            </>
          )}{' '}
          {tab === 'request' && <JsonBlock value={runner.request} />}{' '}
          {tab === 'events' && <EventList events={runner.events} />}{' '}
          {tab === 'metrics' && <MetricsPanel metrics={runner.metrics} />}
        </section>
      )}
      {confirming && (
        <Modal title="确认发送原始请求" onClose={closeConfirmation}>
          <div className="space-y-4 text-sm text-zinc-400">
            <p>
              将使用「{confirming.label}」向其端点发送{' '}
              <b className="text-zinc-100">
                {confirming.request.method} {confirming.request.path}
              </b>{' '}
              请求。
            </p>
            <p>此请求的费用、资源消耗及外部副作用无法自动估计。请确认目标端点、模型、请求体和服务商定价。</p>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={closeConfirmation}>
                返回编辑
              </button>
              <button className="btn-primary" onClick={launchRun}>
                确认并发送 1 次请求
              </button>
            </div>
          </div>
        </Modal>
      )}
      <div className="mobile-runbar md:hidden" aria-label="原始请求操作">
        <button className="btn-primary flex-1" disabled={restoring || runner.running || !conn} onClick={prepareRun}>
          {runner.running ? '请求运行中…' : '发送请求'}
        </button>
        {runner.running && (
          <button className="btn-outline" onClick={runner.abort}>
            停止
          </button>
        )}
        <button
          className="btn-outline"
          disabled={!runner.runId && !runner.error}
          onClick={() => document.getElementById('raw-output')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          结果 ↓
        </button>
      </div>
    </Page>
  );
}
