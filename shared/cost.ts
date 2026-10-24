// Cost estimates are always labelled as estimates and only produced when the catalog has a
// sourced price for the model. Vendor-reported costs (e.g. OpenRouter usage.cost) win.
import type { CostEstimate, ModelDef, OperationDef } from './types.ts';
import { cacheHitTokens, promptTokens } from './protocols.ts';

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function estimateTokenCost(model: ModelDef | undefined, usage: any): CostEstimate | undefined {
  if (!usage) return undefined;
  if (usage.cost !== undefined && Number.isFinite(Number(usage.cost))) {
    const currency = usage.cost_currency ?? usage.currency;
    if (currency === 'USD' || currency === 'CNY')
      return { amount: Number(usage.cost), currency, basis: '厂商在 usage.cost 中返回的费用与币种' };
  }
  const p = model?.pricing;
  if (!p || (p.input === undefined && p.output === undefined)) return undefined;
  const prompt = promptTokens(usage);
  if (prompt === undefined || prompt < 0) return undefined;
  const hit = cacheHitTokens(usage) ?? 0;
  const out = n(usage.completion_tokens ?? usage.output_tokens);
  if (hit > prompt || out < 0 || (prompt > hit && p.input === undefined) || (out > 0 && p.output === undefined))
    return undefined;
  const inCost = ((prompt - hit) * (p.input ?? 0) + hit * (p.cacheHit ?? p.input ?? 0)) / 1e6;
  const outCost = (out * (p.output ?? 0)) / 1e6;
  const sym = p.currency === 'CNY' ? '¥' : '$';
  return {
    amount: inCost + outCost,
    currency: p.currency,
    basis: `按目录定价估算：输入 ${sym}${p.input ?? '?'}/百万${p.cacheHit !== undefined ? `（缓存命中 ${sym}${p.cacheHit}）` : ''}、输出 ${sym}${p.output ?? '?'}/百万 tokens${p.date ? `，定价日期 ${p.date}` : ''}`,
  };
}

export function estimateRunCost(
  op: OperationDef | undefined,
  model: ModelDef | undefined,
  ctx: { usage?: any; input: any; request?: any },
): CostEstimate | undefined {
  if (op?.estimateCost) {
    const e = op.estimateCost({ model: model?.id ?? '', usage: ctx.usage, input: ctx.input, request: ctx.request });
    if (e) return e;
  }
  return estimateTokenCost(model, ctx.usage);
}

export function formatCost(c: CostEstimate | undefined): string {
  if (!c) return '—';
  const sym = c.currency === 'CNY' ? '¥' : '$';
  return c.amount < 0.01 ? `${sym}${c.amount.toFixed(5)}` : `${sym}${c.amount.toFixed(4)}`;
}
