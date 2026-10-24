import type { Verification } from '../types.ts';

/** A documentation check is deliberately not a successful account-level call. */
export function documented(
  source: string,
  note = '2026-10-22 核对官方文档；未使用真实 Key 验证，账户、地域和模型权限待确认',
): Verification {
  return { status: 'documented', date: '2026-10-22', source, note };
}

export const enumOptions = (values: (string | number)[]) => values.map((value) => ({ value }));
