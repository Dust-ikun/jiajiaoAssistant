import type { ImportResult, OrderDiagnostic } from '../types';
import { ANCHOR_LABEL } from '../types';
import { cn } from '../cn';

interface Props {
  result: ImportResult;
  /** 再粘一段（应对「一次只能复制一小块」的分次复制） */
  onAgain: () => void;
  onDone: () => void;
}

/**
 * 导入体检面板。
 *
 * 【为什么不只是一个「导入成功，新增 3 单」的 toast】解析的失败面几乎全是**静默**的：
 * 编号行没粘上 → 整段变成一个单子（字段互相覆盖）；粘的是公告块 → 0 单；
 * 地址被截图裁掉 → 通勤永远是「无地址」。这些都不报错，只是结果悄悄变差。
 * 把「切块依据、缺了哪些字段、置信度」当场摊开，用户才知道该补哪一段原文。
 */
export function ImportDiagnostics({ result, onAgain, onDone }: Props) {
  const d = result.diagnostics;
  const orders = d.orders;

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="shrink-0 border-b border-slate-100 px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[14px] font-semibold text-slate-900">
            {d.nonOrder ? '没识别出单子' : `切出 ${orders.length} 单`}
          </span>
          {!d.nonOrder && (
            <span className="text-[11.5px] text-slate-500">
              新增 {result.inserted} · 合并到已有 {result.duplicated}
            </span>
          )}
          <span className="text-[11px] text-slate-400">{d.lines} 行</span>
        </div>

        {/* 锚点分布：这是「为什么切成了这么多块」的唯一解释 */}
        {d.anchors.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] text-slate-400">切块依据</span>
            {d.anchors.map((a) => (
              <span
                key={a.kind}
                className={cn(
                  'chip border',
                  a.kind === 'none'
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-slate-200 bg-white text-slate-600',
                )}
                title={ANCHOR_LABEL[a.kind] ?? a.kind}
              >
                {ANCHOR_LABEL[a.kind] ?? a.kind}
                <span className="tabular-nums opacity-60">×{a.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {d.nonOrder ? (
          <div className="space-y-2 text-[12px] leading-relaxed text-slate-600">
            <p>这段文本里没有匹配到任何「单子开头」，所以一条都没入库。常见原因：</p>
            <ul className="list-disc space-y-1 pl-5 text-[11.5px] text-slate-500">
              <li>复制时丢了编号那一行（例如 `#1138`、`110512号家教`、`家教编号: xxx`）—— 这是切块的唯一依据</li>
              <li>复制的只是群公告、寒暄，或一张截图的说明文字</li>
              <li>复制被微信截断，只剩半截字段</li>
            </ul>
            <p className="text-[11.5px] text-slate-500">
              试试在微信里往上多选一点，把编号行一起带上再粘一次。
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {orders.map((o, i) => (
              <DiagnosticRow key={`${o.orderNo ?? 'x'}-${i}`} o={o} />
            ))}
          </ul>
        )}

        {!d.nonOrder && orders.some((o) => o.missingFields.length) && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
            缺字段不代表解析失败：原文里本来就没写。等你拿到更完整的那段原文再粘一次即可 ——
            同一条单子会按编号合并，<b>只补空着的字段</b>：已填的不会被覆盖，状态与收藏也不会变。
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-slate-100 px-5 py-3">
        <span className="text-[11px] text-slate-400">
          {d.nonOrder ? '这次没有数据写入' : '已写入本地库'}
        </span>
        <div className="flex gap-2">
          <button onClick={onAgain} className="btn-ghost">
            再粘一段
          </button>
          <button onClick={onDone} className="btn-primary">
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function DiagnosticRow({ o }: { o: OrderDiagnostic }) {
  const low = o.confidence === 'low';
  const mid = o.confidence === 'medium';
  return (
    <li className={cn('rounded-lg border bg-white px-2.5 py-1.5', low ? 'border-rose-200' : mid ? 'border-amber-200' : 'border-slate-200')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[11.5px] text-slate-700">{o.orderNo ? `#${o.orderNo}` : '（无编号）'}</span>
        {o.anchorKind ? (
          <span className="chip bg-slate-100 text-slate-500">{ANCHOR_LABEL[o.anchorKind] ?? o.anchorKind}</span>
        ) : (
          <span className="chip bg-amber-50 text-amber-700">未命中锚点</span>
        )}
        <span
          className={cn(
            'chip',
            low ? 'bg-rose-50 text-rose-600' : mid ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700',
          )}
        >
          {low ? '识别存疑' : mid ? '信息不全' : '解析完整'}
        </span>
        <span className={cn('text-[10.5px]', o.sentAt ? 'text-slate-400' : 'text-rose-500')}>
          {o.sentAt ? new Date(o.sentAt).toLocaleString('zh-CN') : '缺发送时间'}
        </span>
      </div>

      {(o.missingFields.length > 0 || o.warnings.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {o.missingFields.map((f) => (
            <span key={f} className="chip bg-amber-50 text-amber-700">
              缺{f}
            </span>
          ))}
          {o.warnings.map((w) => (
            <span key={w} className="chip bg-slate-100 text-slate-500">
              {w}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
