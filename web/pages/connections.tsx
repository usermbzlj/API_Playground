import { useEffect, useRef, useState } from 'react';
import { PROVIDERS, getProvider, listOperations } from '../../shared/catalog.ts';
import type { ConnectionInfo, ConnectionImportResult, NetworkMode } from '../../shared/types.ts';
import type { RemoteModel } from '../../shared/models.ts';
import { api, type EnvKeyInfo } from '../api.ts';
import { useApp } from '../app.tsx';
import { useRoute, providerHref, labHref, navigate } from '../router.ts';
import { Chip, EmptyHint, Field, JsonBlock, Modal, Spinner, fmtTime } from '../ui.tsx';
import { Page } from './common.tsx';

export function ConnectionsPage() {
  const { connections, refreshConnections, toast } = useApp();
  const route = useRoute();
  const requestedReturn = route.query.get('returnTo') ?? '';
  const returnTo = /^#\/(?:lab\/[^?#\s]+|raw|compare)(?:\?[^#\r\n]*)?$/.test(requestedReturn) ? requestedReturn : null;
  const [editing, setEditing] = useState<ConnectionInfo | 'new' | null>(route.query.has('provider') ? 'new' : null);
  const [env, setEnv] = useState<EnvKeyInfo[]>([]);
  const [busy, setBusy] = useState('');
  const actionLock = useRef(false);
  const [models, setModels] = useState<{ label: string; models: RemoteModel[] } | null>(null);
  const [balance, setBalance] = useState<unknown>(null);
  const [query, setQuery] = useState(route.query.get('q') ?? '');
  const [importing, setImporting] = useState<{ text: string; result: ConnectionImportResult } | null>(null);
  const visible = connections.filter((c) =>
    `${c.label} ${c.baseUrl} ${c.extra.sourceTitle ?? ''} ${c.extra.protocol ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  useEffect(() => {
    api
      .envKeys()
      .then(setEnv)
      .catch((e) => toast(e.message, 'err'));
  }, [toast]);
  async function action(id: string, fn: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(id);
    try {
      await fn();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
      actionLock.current = false;
    }
  }
  return (
    <Page
      title="连接与 Key"
      description="每个连接对应一个服务入口、账户凭证和网络路由。原生厂商与通用协议分别管理，密钥保存在本机服务端。"
      actions={
        <div className="flex flex-wrap gap-2">
          {returnTo && (
            <a className="btn-outline" href={returnTo}>
              返回实验草稿
            </a>
          )}
          <label className="btn-outline cursor-pointer">
            导入凭证文件
            <input
              className="sr-only"
              type="file"
              accept=".md,.txt,text/plain,text/markdown"
              disabled={!!busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > 512 * 1024) {
                  toast('文件不能超过 512 KB', 'err');
                  return;
                }
                void action('import-preview', async () => {
                  const text = await file.text();
                  setImporting({ text, result: await api.importConnections(text) });
                });
              }}
            />
          </label>
          <button className="btn-primary" onClick={() => setEditing('new')}>
            ＋ 添加连接
          </button>
        </div>
      }
    >
      {!!env.length && (
        <section className="card space-y-3 p-5">
          <h2 className="font-semibold text-zinc-100">检测到的环境凭证</h2>
          <p className="text-xs text-zinc-500">导入会在本机创建连接；不会自动向厂商发送请求。</p>
          {env.map((k) => (
            <div
              className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3"
              key={`${k.providerId}:${k.envName}`}
            >
              <span className="flex-1 text-sm text-zinc-200">
                {k.providerName}{' '}
                <span className="mono text-xs text-zinc-500">
                  {k.envName} · {k.preview} · {k.source}
                </span>
              </span>
              {k.imported ? (
                <Chip tone="green">已导入</Chip>
              ) : (
                <button
                  className="btn-outline"
                  disabled={!!busy}
                  onClick={() =>
                    action(k.envName, async () => {
                      await api.importEnvKey({ envName: k.envName, providerId: k.providerId });
                      await refreshConnections();
                      setEnv(await api.envKeys());
                      toast('连接已导入');
                    })
                  }
                >
                  导入连接
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {!connections.length && <EmptyHint>还没有 API 连接。添加厂商 Key 后即可进入实验台。</EmptyHint>}
      {!!connections.length && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="input min-w-0 flex-1"
            aria-label="搜索连接"
            placeholder="搜索服务、账号、协议或域名"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="text-xs text-zinc-500">
            {visible.length} / {connections.length} 个连接
          </span>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {visible.map((c) => {
          const p = getProvider(c.providerId);
          const op = listOperations(c.providerId).find((o) => o.workbench === 'chat');
          return (
            <article className="card space-y-4 p-5" key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">{c.label}</h2>
                  <a className="text-xs text-violet-300" href={providerHref(c.providerId)}>
                    {p?.name ?? c.providerId}
                  </a>
                </div>
                <Chip>{c.network === 'auto' ? '自动网络' : c.network === 'proxy' ? '强制代理' : '直连'}</Chip>
              </div>
              <p className="mono break-all text-xs text-zinc-400">{c.baseUrl}</p>
              <p className="text-xs text-zinc-500">
                Key {c.keyPreview || '未配置'} · {fmtTime(c.createdAt)}
              </p>
              {c.extra.sourceStatus && (
                <p className="text-xs text-amber-200">资料记载：{c.extra.sourceStatus} · 导入不代表本次实测通过</p>
              )}
              {(c.extra.sourceNotes || c.extra.sourceModelNotes || c.extra.sourceBalanceNotes) && (
                <details className="text-xs leading-relaxed text-zinc-400">
                  <summary className="cursor-pointer text-zinc-300">来源备注与限制</summary>
                  {c.extra.sourceNotes && <p className="mt-2 whitespace-pre-wrap break-words">{c.extra.sourceNotes}</p>}
                  {c.extra.sourceModelNotes && (
                    <p className="mt-2 whitespace-pre-wrap break-words">模型资料：{c.extra.sourceModelNotes}</p>
                  )}
                  {c.extra.sourceBalanceNotes && (
                    <p className="mt-2 whitespace-pre-wrap break-words">余额资料：{c.extra.sourceBalanceNotes}</p>
                  )}
                </details>
              )}
              {c.lastTest ? (
                <div
                  className={`text-xs ${c.lastTest.ok === null || c.lastTest.verified === false ? 'text-amber-200' : c.lastTest.ok ? 'text-emerald-300' : 'text-rose-300'}`}
                >
                  {c.lastTest.ok === null || c.lastTest.verified === false ? '○' : c.lastTest.ok ? '✓' : '✗'}{' '}
                  {c.lastTest.message} · {fmtTime(c.lastTest.at)}
                </div>
              ) : (
                <p className="text-xs text-zinc-500">尚未验证 · 保存凭证不会自动调用服务</p>
              )}
              <div className="flex flex-wrap gap-2">
                {op && (
                  <a
                    className="btn-primary"
                    href={labHref(op.id, { connection: c.id, model: c.extra.defaultModel || undefined })}
                  >
                    进入实验
                  </a>
                )}
                <a className="btn-ghost" href={`#/raw?connection=${encodeURIComponent(c.id)}`}>
                  原始请求
                </a>
                <button
                  className="btn-outline"
                  disabled={!!busy}
                  onClick={() =>
                    action(c.id, async () => {
                      const r = await api.testConnection(c.id);
                      toast(r.message, r.ok === false ? 'err' : 'ok');
                      await refreshConnections();
                    })
                  }
                >
                  {busy === c.id ? <Spinner /> : '测试连接'}
                </button>
                {p?.modelsPath && (
                  <button
                    className="btn-outline"
                    disabled={!!busy}
                    onClick={() =>
                      action(`${c.id}:models`, async () => {
                        const r = await api.remoteModels(c.id, { refresh: true });
                        setModels({ label: c.label, models: r.models });
                      })
                    }
                  >
                    查询账号模型
                  </button>
                )}
                {p?.balance && (
                  <button
                    className="btn-outline"
                    disabled={!!busy}
                    onClick={() =>
                      action(`${c.id}:balance`, async () => {
                        const r = await api.balance(c.id);
                        setBalance(r);
                      })
                    }
                  >
                    查询余额
                  </button>
                )}
                <button className="btn-ghost" onClick={() => setEditing(c)}>
                  编辑
                </button>
                <button
                  className="btn-ghost text-rose-300"
                  disabled={!!busy}
                  onClick={() => {
                    if (confirm(`删除连接「${c.label}」及其本地凭证？历史记录会保留。`))
                      action(`${c.id}:delete`, async () => {
                        await api.deleteConnection(c.id);
                        await refreshConnections();
                      });
                  }}
                >
                  删除
                </button>
              </div>
              <p className="text-[11px] text-zinc-600">
                连接测试仅代表鉴权 / 查询端点可用，不等于所有模型和能力已实测。测试与查询会请求所配置服务。
              </p>
            </article>
          );
        })}
      </div>
      {importing && (
        <Modal
          wide
          title="导入本机 API 凭证"
          onClose={() => {
            if (!busy) setImporting(null);
          }}
        >
          <p className="mb-3 text-sm text-zinc-300">
            识别 {importing.result.sections} 个服务条目、{importing.result.credentials} 把 Key、
            {importing.result.entries.length} 个账户 / 协议入口。
          </p>
          <p className="mb-4 text-xs text-zinc-500">
            只保存到本机，不会自动调用模型。同服务、地址和 Key
            的已有连接会复用，独立账号和不同协议分别保留。文件中的状态与备注仅供参考。
          </p>
          <div className="max-h-[50vh] space-y-2 overflow-auto">
            {importing.result.entries.map((entry, i) => (
              <div className="rounded-lg border border-zinc-800 p-3 text-xs" key={i}>
                <p className="text-zinc-100">
                  {entry.label} · {entry.existing ? '复用已有连接' : '新增连接'}
                </p>
                <p className="mono mt-1 break-all text-zinc-400">
                  {entry.baseUrl} · {entry.keyPreview}
                </p>
                <p className="mt-1 text-zinc-500">
                  资料记载：{entry.sourceStatus} · {entry.protocol}
                </p>
              </div>
            ))}
            {importing.result.warnings.map((w, i) => (
              <p className="text-xs text-amber-200" key={i}>
                {w}
              </p>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-ghost" disabled={!!busy} onClick={() => setImporting(null)}>
              取消
            </button>
            <button
              className="btn-primary"
              disabled={!!busy || !importing.result.entries.length}
              onClick={() =>
                action('import-apply', async () => {
                  const r = await api.importConnections(importing.text, true);
                  await refreshConnections();
                  setEnv(await api.envKeys());
                  setImporting(null);
                  toast(`已新增 ${r.created} 个连接，复用 ${r.reused} 个已有连接`);
                })
              }
            >
              {busy === 'import-apply' ? <Spinner /> : '导入全部连接'}
            </button>
          </div>
        </Modal>
      )}
      {editing && (
        <ConnectionEditor
          key={editing === 'new' ? 'new' : editing.id}
          current={editing === 'new' ? undefined : editing}
          providerId={route.query.get('provider') ?? undefined}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            if (returnTo) navigate(returnTo);
          }}
        />
      )}
      {models && (
        <Modal wide title={`${models.label} · 账号模型（${models.models.length}）`} onClose={() => setModels(null)}>
          <p className="mb-3 text-xs text-zinc-500">账号可见不代表对应操作支持该模型的全部能力。</p>
          <JsonBlock value={models.models} max={150000} />
        </Modal>
      )}
      {balance !== null && (
        <Modal title="服务商余额响应" onClose={() => setBalance(null)}>
          <JsonBlock value={balance} />
        </Modal>
      )}
    </Page>
  );
}

function ConnectionEditor({
  current,
  providerId,
  close,
  saved,
}: {
  current?: ConnectionInfo;
  providerId?: string;
  close: () => void;
  saved: () => void;
}) {
  const { toast, refreshConnections } = useApp();
  const [pid, setPid] = useState(current?.providerId ?? getProvider(providerId)?.id ?? PROVIDERS[0]?.id ?? '');
  const p = getProvider(pid)!;
  const [label, setLabel] = useState(current?.label ?? '');
  const [base, setBase] = useState(current?.baseUrl ?? p.baseUrls[0]?.url ?? '');
  const [key, setKey] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>(current?.extra ?? {});
  const [network, setNetwork] = useState<NetworkMode>(current?.network ?? 'auto');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function save() {
    if (saving.current) return;
    if (!base.trim()) {
      toast('请填写 Base URL', 'err');
      return;
    }
    try {
      const u = new URL(base);
      if (!['http:', 'https:'].includes(u.protocol)) throw Error();
    } catch {
      toast('Base URL 必须是有效的 HTTP(S) URL', 'err');
      return;
    }
    if (!current && !key.trim()) {
      toast('请填写 API Key', 'err');
      return;
    }
    for (const f of p.auth.extraFields ?? [])
      if (f.required && !extra[f.key]?.trim() && !(current && f.secret)) {
        toast(`请填写 ${f.label}`, 'err');
        return;
      }
    saving.current = true;
    setBusy(true);
    try {
      const b = {
        providerId: pid,
        label: label.trim() || p.name,
        baseUrl: base.trim(),
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        extra,
        network,
      };
      if (current) await api.updateConnection(current.id, b);
      else await api.createConnection(b);
      await refreshConnections();
      toast('连接已保存');
      saved();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
      saving.current = false;
    }
  }
  return (
    <Modal title={current ? '编辑连接' : '添加 API 连接'} onClose={close}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="API 服务提供方">
          <select
            className="input"
            value={pid}
            disabled={!!current}
            onChange={(e) => {
              const next = getProvider(e.target.value)!;
              setPid(next.id);
              setBase(next.baseUrls[0]?.url ?? '');
              setExtra({});
            }}
          >
            {PROVIDERS.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="连接名称" hint="例如：个人账户 · 国内区 / 备用 Key">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={p.name} />
        </Field>
        {p.baseUrls.length > 1 && (
          <Field label="官方端点预设">
            <select
              className="input"
              value={p.baseUrls.find((b) => b.url === base)?.id ?? ''}
              onChange={(e) => {
                const b = p.baseUrls.find((x) => x.id === e.target.value);
                if (b) setBase(b.url);
              }}
            >
              <option value="">自定义地址</option>
              {p.baseUrls.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                  {b.note ? ` · ${b.note}` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Base URL" hint="路径会追加在此地址后。确认服务域名可信，再保存凭证。">
          <input
            className="input mono"
            required
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <Field
          label={p.auth.keyLabel ?? 'API Key'}
          hint={
            current ? '留空保留现有密钥。保存后无法从浏览器读回完整密钥。' : '只发送到本机服务，由服务注入上游请求。'
          }
        >
          <input
            className="input mono"
            type="password"
            autoComplete="new-password"
            required={!current}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        {p.auth.extraFields?.map((f) => (
          <Field
            key={f.key}
            label={`${f.label}${f.required ? ' *' : ''}`}
            hint={current && f.secret ? '留空保留已保存的密钥字段' : undefined}
          >
            <input
              className="input"
              type={f.secret ? 'password' : 'text'}
              value={extra[f.key] ?? ''}
              onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              autoComplete="off"
            />
          </Field>
        ))}
        <Field label="网络路由">
          <select className="input" value={network} onChange={(e) => setNetwork(e.target.value as NetworkMode)}>
            <option value="auto">自动：按全局设置 / 系统环境</option>
            <option value="direct">直连</option>
            <option value="proxy">强制代理：需先在设置页配置</option>
          </select>
        </Field>
        <Field label="连接默认模型（可选）" hint="通用协议切换到这个连接时使用；模型 ID 仍需以账号权限为准。">
          <input
            className="input mono"
            value={extra.defaultModel ?? ''}
            onChange={(e) => setExtra({ ...extra, defaultModel: e.target.value })}
            placeholder="例如 deepseek-flash"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={close}>
            取消
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy ? <Spinner /> : '保存连接'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
