/** Replace string values after JSON parsing, so quotes/newlines cannot change its structure. */
export function renderRequestTemplate<T>(value: T, variables: Record<string, string>): T {
  if (typeof value === 'string')
    return value.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (literal, key) => {
      if (!Object.hasOwn(variables, key)) throw new Error(`未定义模板变量 ${literal}`);
      return variables[key];
    }) as T;
  if (Array.isArray(value)) return value.map((item) => renderRequestTemplate(item, variables)) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('模板不能包含原型保留字段');
    out[key] = renderRequestTemplate(item, variables);
  }
  return out as T;
}
