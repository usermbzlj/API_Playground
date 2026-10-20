// Turn raw failures into actionable explanations. Vendor-specific codes are added
// as they are observed in real responses or documented by the vendor.

export interface Diagnosis {
  title: string;
  hints: string[];
  vendorCode?: string | number;
  vendorMessage?: string;
}

/**
 * Extract a vendor error code/message from common response shapes.
 * 仅在确切的错误信封形状上判定，避免把成功响应误判为错误
 * （例如 {code:"0", message:"ok"} 这类正常返回）。
 */
export function extractVendorError(body: any): { code?: string | number; message?: string } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  // OpenAI style: { error: { code, message } } 或 { error: "..." }
  if (body.error && typeof body.error === 'object') {
    return { code: body.error.code ?? body.error.type, message: body.error.message ?? JSON.stringify(body.error) };
  }
  if (typeof body.error === 'string') return { message: body.error };
  // MiniMax style: base_resp.status_code !== 0 即失败（HTTP 仍可能是 200）
  if (body.base_resp && typeof body.base_resp.status_code === 'number' && body.base_resp.status_code !== 0) {
    return { code: body.base_resp.status_code, message: body.base_resp.status_msg };
  }
  // Volcengine style
  if (body.ResponseMetadata?.Error) return { code: body.ResponseMetadata.Error.Code, message: body.ResponseMetadata.Error.Message };
  // 数值 code + message 的信封（部分国内厂商 2xx 带错）。字符串 code 形状过于模糊，
  // 交给 HTTP 状态码分支处理，避免把 {code:"0",message:"ok"} 误判为错误。
  if (typeof body.code === 'number' && body.code !== 0 && body.code !== 200 && (body.msg || body.message)) {
    return { code: body.code, message: body.msg ?? body.message };
  }
  return undefined;
}

const VENDOR_CODES: Record<string, Record<string, string>> = {
  minimax: {
    '1000': '未知错误，可稍后重试。',
    '1001': '请求超时。',
    '1002': '触发限流（RPM/TPM），请降低频率。',
    '1004': '鉴权失败：检查 API Key，以及是否选对了国内（minimaxi.com）/ 国际（minimax.io）域名。',
    '1008': '账户余额不足。',
    '1013': '服务内部错误。',
    '1026': '输入内容涉及敏感信息。',
    '1027': '输出内容涉及敏感信息。',
    '1039': '触发 Token 限制。',
    '1042': '非法字符超过 10%。',
    '2013': '参数错误：检查参数取值范围或该模型是否支持此参数。',
    '2049': 'API Key 无效。',
  },
  dashscope: {
    InvalidApiKey: 'API Key 无效：注意北京与新加坡等地域的 Key 不通用，需与 Base URL 地域一致。',
    Arrearage: '账户欠费，需要在阿里云充值。',
    'Model.AccessDenied': '没有该模型的访问权限，可能需要在百炼控制台开通。',
    DataInspectionFailed: '内容安全审核未通过（输入或输出）。',
    'Throttling.RateQuota': '触发限流。',
    'Throttling.AllocationQuota': '触发 Token 配额限制。',
    ModelNotFound: '模型不存在或当前地域不可用。',
  },
  volcengine: {
    ModelNotOpen: '该模型尚未在火山方舟控制台开通，请到「开通管理」中开通后重试。',
    'InvalidEndpointOrModel.NotFound': '模型 ID 或推理接入点不存在，检查拼写或是否需要使用 ep- 接入点。',
    AuthenticationError: 'API Key 无效或已删除。',
    AccountOverdueError: '账户欠费。',
    RateLimitExceeded: '触发限流。',
    'SetLimitExceeded': '达到了你在控制台设置的推理限额（安全体验模式等）。',
    'InputTextSensitiveContentDetected': '输入内容未通过审核。',
    'OutputVideoSensitiveContentDetected': '生成的视频未通过审核。',
  },
};

export function diagnose(input: {
  providerId?: string;
  httpStatus?: number | null;
  body?: any;
  networkError?: string;
}): Diagnosis {
  const { providerId, httpStatus, body, networkError } = input;
  if (networkError) {
    const hints = ['检查网络与代理设置；部分海外服务在国内需要代理，部分国内服务在海外访问较慢。'];
    if (/ENOTFOUND|EAI_AGAIN/.test(networkError)) hints.unshift('域名无法解析：检查 Base URL 是否拼写正确。');
    if (/ETIMEDOUT|timeout|aborted due to timeout/i.test(networkError)) hints.unshift('请求超时：生成类任务可能本身较慢，也可能是网络问题。');
    if (/ECONNREFUSED|ECONNRESET/.test(networkError)) hints.unshift('连接被拒绝或被重置。');
    if (/certificate|SSL|TLS/i.test(networkError)) hints.unshift('TLS 证书问题：检查代理或系统时间。');
    return { title: '网络错误', hints, vendorMessage: networkError };
  }
  const ve = extractVendorError(body);
  const hints: string[] = [];
  let title = httpStatus ? `HTTP ${httpStatus}` : '调用失败';
  const codeStr = ve?.code != null ? String(ve.code) : '';
  const table = providerId ? VENDOR_CODES[providerId] : undefined;
  if (table && codeStr) {
    const hit = table[codeStr] ?? Object.entries(table).find(([k]) => codeStr.startsWith(k))?.[1];
    if (hit) hints.push(hit);
  }
  switch (httpStatus) {
    case 400:
      title = '请求参数有误 (400)';
      hints.push('对照「原生请求」检查字段名与取值；部分参数只对特定模型生效，或与其他参数互斥。');
      break;
    case 401:
      title = '鉴权失败 (401)';
      hints.push('API Key 错误、过期或被删除；确认 Key 与 Base URL 属于同一平台和地域（如国内站 / 国际站）。');
      break;
    case 402:
      title = '余额不足 (402)';
      hints.push('充值或检查账户套餐。');
      break;
    case 403:
      title = '无权限 (403)';
      hints.push('模型可能需要单独开通、白名单或实名认证；也可能是地域限制或内容审核拦截。');
      break;
    case 404:
      title = '资源不存在 (404)';
      hints.push('检查接口路径与模型 ID；模型可能已下线、改名或不在当前地域提供。');
      break;
    case 413:
      title = '请求体过大 (413)';
      hints.push('减少上传素材大小或改用 URL 引用。');
      break;
    case 422:
      title = '参数校验失败 (422)';
      hints.push('字段类型或取值不符合要求。');
      break;
    case 429:
      title = '限流或额度耗尽 (429)';
      hints.push('降低并发与频率；部分平台 429 也表示余额 / 配额不足。');
      break;
    case 500:
    case 502:
    case 503:
    case 504:
      title = `服务端错误 (${httpStatus})`;
      hints.push('厂商服务暂时异常或过载，可稍后重试；长时间无响应也可能是网关超时。');
      break;
  }
  if (!hints.length) hints.push('查看下方原始响应获取厂商给出的详细信息。');
  return { title, hints, vendorCode: ve?.code, vendorMessage: ve?.message };
}
