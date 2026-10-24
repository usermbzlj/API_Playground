// Request signers for vendors that do not accept a static bearer key.
// Secrets never leave the server; the UI only sees the redacted result.
import { createHmac } from 'node:crypto';

export interface SignInput {
  /** the connection's main secret */
  key: string;
  /** connection extras (secret ones included) */
  extra: Record<string, string>;
  url: string;
  method: string;
  body?: string;
}

export interface SignOutput {
  headers: Record<string, string>;
  url?: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** HS256 JWT with the AccessKey as issuer (Kling-style AK/SK auth). */
function jwtAkSk(input: SignInput): SignOutput {
  const accessKey = input.extra.AccessKey?.trim();
  const secretKey = input.key.trim();
  if (!accessKey) throw new Error('缺少 AccessKey：请在连接中填写 AccessKey（Secret Key 填在 API Key 位置）');
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: nowSec + 1800, nbf: nowSec - 5 }));
  const sig = b64url(createHmac('sha256', secretKey).update(`${header}.${payload}`).digest());
  return { headers: { Authorization: `Bearer ${header}.${payload}.${sig}` } };
}

const SIGNERS: Record<string, (input: SignInput) => SignOutput> = {
  'jwt-ak-sk': jwtAkSk,
};

export function sign(name: string, input: SignInput): SignOutput {
  const fn = SIGNERS[name];
  if (!fn) throw new Error(`未实现的签名方式：${name}`);
  return fn(input);
}
