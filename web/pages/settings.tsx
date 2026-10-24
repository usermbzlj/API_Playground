import { useCallback, useEffect, useState } from 'react';
import { api, type NetworkInfo } from '../api.ts';
import { useApp } from '../app.tsx';
import { ErrorBox, Field, Spinner } from '../ui.tsx';
import { Page } from './common.tsx';

export function SettingsPage() {
  const { toast } = useApp();
  const [tier, setTier] = useState('high');
  const [proxy, setProxy] = useState('');
  const [mode, setMode] = useState<'env' | 'direct' | 'proxy'>('env');
  const [net, setNet] = useState<NetworkInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [proxyEdited, setProxyEdited] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setReady(false);
    try {
      const [settings, network] = await Promise.all([api.settings(), api.network()]);
      setTier(settings.confirmTier ?? 'high');
      setNet(network);
      setProxy(network.proxyUrl ?? '');
      setMode(network.proxyUrl === null ? 'env' : network.proxyUrl === '' ? 'direct' : 'proxy');
      setProxyEdited(false);
      setReady(true);
      setError('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save() {
    if (!ready || busy) return;
    const address = mode === 'env' ? null : mode === 'direct' ? '' : proxy.trim();
    const currentMode = net?.proxyUrl === null ? 'env' : net?.proxyUrl === '' ? 'direct' : 'proxy';
    const networkChanged = mode !== currentMode || (mode === 'proxy' && proxyEdited);
    try {
      if (mode === 'proxy' && networkChanged) {
        const url = new URL(address!);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('代理地址只支持 http:// 或 https://');
      }
    } catch (e: any) {
      toast(`代理配置无效：${e.message}`, 'err');
      return;
    }
    setBusy(true);
    try {
      const result = await api.savePreferences(tier, networkChanged ? { proxyUrl: address } : undefined);
      setNet(result.network);
      setProxy(result.network.proxyUrl ?? '');
      setProxyEdited(false);
      setError('');
      toast('网络与费用确认设置已保存');
    } catch (e: any) {
      setError(`未能保存：${e.message}。请重新载入后再保存。`);
      setReady(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title="设置" description="配置本机调用行为。连接可以独立选择直连或代理；实际费用以服务商账单为准。">
      {error && <ErrorBox error={{ title: '设置未能完成', hints: [error] }} />}
      {loading ? (
        <Spinner />
      ) : ready ? (
        <>
          <section className="card space-y-5 p-5">
            <h2 className="text-lg font-semibold text-zinc-100">调用与成本</h2>
            <Field
              label="运行前的费用确认"
              hint="原始请求与实时会话始终需要明确确认。对比实验会列出调用数量；确认不是自动扣费预算上限。"
            >
              <select className="input max-w-lg" value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="high">高成本操作前确认</option>
                <option value="medium">中、高成本操作前确认</option>
                <option value="all">所有操作都确认</option>
              </select>
            </Field>
          </section>
          <section className="card space-y-5 p-5">
            <h2 className="text-lg font-semibold text-zinc-100">网络</h2>
            <Field label="全局出站方式">
              <select className="input max-w-lg" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="env">跟随服务进程的代理环境变量</option>
                <option value="direct">全部直连（忽略代理环境变量）</option>
                <option value="proxy">使用指定 HTTP(S) 代理</option>
              </select>
            </Field>
            {mode === 'proxy' && (
              <Field
                label="代理地址"
                hint={
                  net?.hasCredentials
                    ? '已保存代理认证。地址未编辑时保留现有凭据；如要替换，请输入完整新地址（可含用户名和密码）。'
                    : '支持 HTTP(S) 代理。认证地址可使用 http://用户名:密码@主机:端口。'
                }
              >
                <input
                  className="input mono max-w-2xl"
                  value={proxy}
                  onChange={(e) => {
                    setProxy(e.target.value);
                    setProxyEdited(true);
                  }}
                  placeholder="http://127.0.0.1:7890"
                  autoComplete="off"
                />
              </Field>
            )}
            {net && (
              <p className="text-xs text-zinc-500">
                当前来源：{net.source === 'settings' ? '应用设置' : net.source === 'env' ? '环境变量' : '未设置代理'} ·{' '}
                {net.effectiveProxy ? '已配置代理' : '直连'}。单个连接可选择独立路由。
              </p>
            )}
          </section>
          <div className="flex gap-3">
            <button className="btn-primary" disabled={busy || !ready} onClick={save}>
              {busy ? <Spinner /> : '保存设置'}
            </button>
            <button className="btn-outline" disabled={busy} onClick={load}>
              重新载入
            </button>
          </div>
          <section className="card space-y-2 p-5 text-xs leading-relaxed text-zinc-500">
            <h2 className="text-sm font-semibold text-zinc-200">数据与隐私</h2>
            <p>
              连接凭证、实验输入、响应、素材和生成产物都保存在本机。导出会过滤已知凭证字段，但不能识别自由文本中的所有个人信息，请在分享前检查。
            </p>
            <p>
              “文档声称”与“本机实测”是两类证据。一次请求成功不代表所有参数生效；没有可靠定价或用量时，费用保持未知。
            </p>
          </section>
        </>
      ) : null}
      {!loading && error && (
        <button className="btn-outline" onClick={load}>
          重试加载设置
        </button>
      )}
    </Page>
  );
}
