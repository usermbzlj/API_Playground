// 本机访问守卫：Host / Origin / 远端地址三重校验。
// 威胁模型：浏览器里任意 localhost 端口的页面（另一个本地应用、被劫持的 dev server）
// 都可以 fetch 到本服务，从而冒用用户已配置的 API Key。仅靠「Origin 是 localhost」不够，
// 必须限定到本应用自己的端口；非浏览器本地进程不发送 Origin，但它们本就能读 secrets.json，
// 不在防护范围内。

const LOOPBACKS = new Set(['127.0.0.1', '::1']);

/** 默认只放行本 UI 的端口；部署在其它端口时用 PLAYGROUND_ORIGINS 覆盖（逗号分隔）。 */
function originAllowlist(): string[] {
  const env = process.env.PLAYGROUND_ORIGINS?.trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const ports = [process.env.PORT || '8787', process.env.WEB_PORT || '5173'];
  const out: string[] = [];
  for (const host of ['localhost', '127.0.0.1']) {
    for (const p of ports) out.push(`http://${host}:${p}`);
  }
  return out;
}

export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return true; // 取不到地址时不阻断（unix socket / 测试环境）
  const addr = remoteAddress.replace(/^::ffff:/, '');
  return LOOPBACKS.has(remoteAddress) || LOOPBACKS.has(addr) || addr.startsWith('127.');
}

/** Host 头校验：容忍 IPv6 [::1]:8787 写法。 */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return false;
    host = host.slice(0, end + 1); // 保留 [::1]
  } else {
    host = host.split(':')[0];
  }
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

/** Origin 校验：仅在确实发送了 Origin 时拦截（curl / 同源导航不带 Origin）。 */
export function originAllowed(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  return originAllowlist().includes(originHeader);
}

export function allowedOrigins(): string[] {
  return originAllowlist();
}
