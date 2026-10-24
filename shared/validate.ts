import type { BuildContext, OperationDef } from './types.ts';
import { coerceParam, paramApplies } from './util.ts';

/** Validate before a billable request. The server is authoritative; the UI reuses this. */
export function validateOperationInput(op: OperationDef, ctx: BuildContext): void {
  const input: any = ctx.input ?? {};
  if (!(op.models && op.models.length === 0) && !ctx.model?.trim()) throw new Error('请选择或输入模型 ID');
  if (
    op.workbench === 'chat' &&
    !(input.messages ?? []).some(
      (m: any) =>
        String(m.content ?? '').trim() ||
        m.images?.length ||
        m.videos?.length ||
        m.tool_calls?.length ||
        m.blocks?.length,
    )
  )
    throw new Error('请填写对话消息或添加参考素材');
  if (op.workbench === 'fim' && !String(input.prefix ?? '').trim()) throw new Error('请填写光标之前的代码或文本');
  if (op.workbench === 'tts' && !String(input.text ?? '').trim()) throw new Error('请填写要合成的文字');
  if (op.workbench === 'asr' && !input.audio) throw new Error('请先选择音频素材');
  if (['image', 'video', 'model3d'].includes(op.workbench)) {
    if (!(String(input.prompt ?? '').trim() || input.images?.length || input.firstFrame))
      throw new Error('请填写生成描述或选择参考素材');
    if (op.inputFields?.includes('images') && !op.inputFields.includes('prompt') && !input.images?.length)
      throw new Error('请先添加参考图');
  }
  if (op.id === 'minimax.video-keyframes' && (!input.firstFrame || !input.lastFrame))
    throw new Error('首尾帧视频必须同时选择首帧和尾帧');
  if (op.workbench === 'embedding' && !(input.texts ?? []).some((t: string) => t.trim()))
    throw new Error('请至少填写一条文本');
  if (
    op.workbench === 'rerank' &&
    (!String(input.query ?? '').trim() || !(input.documents ?? []).some((t: string) => t.trim()))
  )
    throw new Error('请填写查询词和候选文档');
  for (const spec of op.params) {
    const st = ctx.params?.[spec.key];
    if (!st?.enabled) continue;
    if (!paramApplies(spec, ctx.model)) throw new Error(`参数 ${spec.key} 不适用于当前模型，取消勾选后再运行`);
    const value = coerceParam(spec, st.value);
    if (value === undefined) throw new Error(`已启用的参数 ${spec.key} 不能为空`);
  }
}
