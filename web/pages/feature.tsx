import { getFeature, operationsForFeature, presetsFor } from '../../shared/catalog.ts';
import { compareHref, labHref } from '../router.ts';
import { EmptyHint } from '../ui.tsx';
import { OperationCard, Page } from './common.tsx';
import { ArrowRight, Check, FlaskConical, GitCompareArrows } from 'lucide-react';
export function FeaturePage({ id }: { id: string }) {
  const f = getFeature(id);
  if (!f)
    return (
      <Page title="能力不存在">
        <a href="#/explore">返回探索</a>
      </Page>
    );
  const ops = operationsForFeature(id);
  return (
    <Page
      title={f.name}
      description={f.summary}
      actions={
        ops.filter((o) => o.lifecycle !== 'ws').length > 1 ? (
          <a
            className="btn-outline"
            href={compareHref({
              ops: ops
                .filter((o) => o.lifecycle !== 'ws')
                .slice(0, 4)
                .map((o) => o.id),
            })}
          >
            并排对比实现
          </a>
        ) : undefined
      }
    >
      <a href="#/explore" className="inline-flex text-xs text-zinc-400 hover:text-violet-300">
        ← 返回能力图谱
      </a>
      <div className="grid gap-3 md:grid-cols-3">
        {[
          {
            icon: FlaskConical,
            title: '01 / 选一个实验入口',
            description: `${ops.length} 个已实现操作。按服务商选择原生端点，再配置自己的连接。`,
          },
          {
            icon: Check,
            title: '02 / 检查真实返回',
            description: '运行后检查请求、事件、用量与产物。目录说明和本机实测分别标记。',
          },
          {
            icon: GitCompareArrows,
            title: '03 / 固定变量再对照',
            description: '沿用相同输入，对比不同端点、模型或参数；性能评测可重复测量。',
          },
        ].map((item) => (
          <div className="card flex items-start gap-3 p-4" key={item.title}>
            <item.icon size={18} className="mt-0.5 shrink-0 text-violet-300" />
            <div>
              <h2 className="text-xs font-medium text-zinc-200">{item.title}</h2>
              <p className="mt-2 text-xs leading-5 text-zinc-400">{item.description}</p>
            </div>
          </div>
        ))}
      </div>
      <section className="card space-y-3 p-5">
        <h2 className="font-semibold text-zinc-100">可以拿它做什么</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-zinc-400">
          {f.useCases.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        {f.tips?.map((x) => (
          <p className="text-sm leading-relaxed text-amber-200/90" key={x}>
            {x}
          </p>
        ))}
      </section>
      {f.compareNotes && (
        <p className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-4 text-sm leading-relaxed text-amber-200/90">
          对比注意：{f.compareNotes}
        </p>
      )}
      {ops.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ops.map((o) => (
            <OperationCard op={o} key={o.id} />
          ))}
        </div>
      ) : (
        <EmptyHint>
          {f.id === 'raw' || f.id === 'model-discovery'
            ? '此能力由独立入口提供，不挂载在实验操作上：原始请求台可直接发送原生请求，连接页可刷新厂商模型列表。'
            : '此能力目前仅作为研究线索，尚无专属适配。' + '可查看服务商文档后在'}
          {f.id !== 'raw' && f.id !== 'model-discovery' && (
            <a className="text-violet-300" href="#/raw">
              原始请求台
            </a>
          )}
          {f.id !== 'raw' && f.id !== 'model-discovery' && '尝试，不代表本项目已经支持。'}
        </EmptyHint>
      )}
      {ops.flatMap((o) => presetsFor(o.id)).length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-zinc-100">从一个实验开始</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {ops
              .flatMap((o) => presetsFor(o.id))
              .map((p) => (
                <a
                  className="card space-y-2 p-4 hover:border-violet-500"
                  key={p.id}
                  href={labHref(p.operationId, { preset: p.id })}
                >
                  <h3 className="text-sm font-semibold text-zinc-100">{p.title} →</h3>
                  <p className="text-xs text-zinc-400">{p.description}</p>
                  <p className="flex items-center gap-1 text-xs text-violet-300">
                    载入输入与原生参数 <ArrowRight size={12} />
                  </p>
                </a>
              ))}
          </div>
        </section>
      )}
    </Page>
  );
}
