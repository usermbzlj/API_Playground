async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`/api/bench${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : `评测服务返回 HTTP ${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  if (!data || typeof data !== 'object') throw new Error('评测服务返回了无效数据，请刷新记录核对运行状态');
  return data;
}
export const benchApi = {
  runtime: () => request('/runtime'),
  list: (offset = 0) => request(`?limit=50&offset=${offset}`),
  get: (id: string) => request(`/${encodeURIComponent(id)}`),
  start: (config: unknown) => request('/start', config),
  cancel: (id: string) => request(`/${encodeURIComponent(id)}/cancel`, {}),
  import: (report: unknown) => request('/import', report),
  remove: async (id: string) => {
    const response = await fetch(`/api/bench/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? '删除评测记录失败');
    return data;
  },
};
