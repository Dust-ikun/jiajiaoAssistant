import { useEffect, useState } from 'react';
import { fetchCommuteDetail } from '../api';
import type { Order, OrderCommuteDetail, OrderStatus } from '../types';
import { STATUS_LABEL, UNIT_LABEL } from '../types';
import { cn } from '../cn';
import { commuteBadge, distanceText, isStale, minutesText, relTime, salaryTierText, verdictTone } from '../format';

const BAR: Record<OrderStatus, string> = {
  new: 'bg-indigo-500',
  seen: 'bg-slate-300',
  contacted: 'bg-emerald-500',
  discarded: 'bg-slate-200',
};

const STATUS_STYLE: Record<OrderStatus, string> = {
  new: 'bg-indigo-50 text-indigo-600',
  seen: 'bg-slate-100 text-slate-500',
  contacted: 'bg-emerald-50 text-emerald-600',
  discarded: 'bg-slate-100 text-slate-400',
};

/** 通勤 / 判定共用的一套配色：绿=好、琥珀=要留意、玫瑰=不行、灰=还没数据 */
const TONE: Record<'ok' | 'warn' | 'bad' | 'muted', string> = {
  ok: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  bad: 'bg-rose-50 text-rose-600',
  muted: 'bg-slate-100 text-slate-400',
};

function Star({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={on ? '取消收藏' : '收藏'}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md transition-colors',
        on ? 'text-amber-400 hover:bg-amber-50' : 'text-slate-300 hover:bg-slate-100 hover:text-slate-400',
      )}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

interface Props {
  order: Order;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Pick<Order, 'status' | 'starred'>>) => void;
}

export function OrderCard({ order, expanded, onToggle, onPatch }: Props) {
  const [copied, setCopied] = useState(false);
  const [detail, setDetail] = useState<OrderCommuteDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const o = order;

  /**
   * 换乘方案只在展开时才取：列表里 30 条单子每条都算 4 套方案，纯属浪费请求。
   * `commuteCheckedAt` 进依赖 —— 后台重算完这一单会刷新它，展开着的卡片要跟着更新。
   */
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    setDetailError(null);
    fetchCommuteDetail(o.id)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        if (alive) setDetailError('取换乘方案失败');
      });
    return () => {
      alive = false;
    };
  }, [expanded, o.id, o.commuteCheckedAt]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(o.rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  const place = [o.district, o.area].filter(Boolean).join(' · ') || '区域未识别';
  const unit = o.salaryUnit ? UNIT_LABEL[o.salaryUnit] : '';
  const commute = commuteBadge(o);
  const tiers = salaryTierText(o.salaryTiers);
  const stale = isStale(o.sentAt);
  const reasons = o.match.reasons;

  return (
    <article
      className={cn(
        'relative overflow-hidden rounded-xl border bg-white transition-shadow',
        expanded ? 'border-slate-300 shadow-sm' : 'border-slate-200 hover:border-slate-300 hover:shadow-sm',
        o.status === 'discarded' && 'opacity-60',
      )}
    >
      <div className={cn('absolute left-0 top-0 h-full w-[3px]', BAR[o.status])} />

      <div className="flex cursor-pointer items-start gap-4 py-3 pl-4 pr-3" onClick={onToggle}>
        {/* 时薪区：换算后的可比数字，默认排序之外都靠它 */}
        <div className="w-[76px] shrink-0 pt-0.5">
          <div
            className={cn(
              'text-[19px] font-semibold leading-none tabular-nums',
              o.salaryHourly === null ? 'text-slate-300' : 'text-slate-900',
            )}
          >
            {o.salaryHourly ?? '—'}
          </div>
          <div className="mt-1 text-[10px] text-slate-400">元/小时</div>
          <div className="mt-1.5 truncate text-[11px] text-slate-500" title={o.salaryRaw ?? ''}>
            {o.salaryRaw ?? '未识别'}
            {o.salaryUnit && !o.salaryHourly ? ` ${unit}` : ''}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-medium text-slate-900">{place}</span>
            {o.stage && <span className="chip bg-sky-50 text-sky-700">{o.stage}</span>}
            {o.subjects.map((s) => (
              <span key={s} className="chip bg-slate-100 text-slate-700">
                {s}
              </span>
            ))}
            {o.subjectTags.slice(0, 2).map((t) => (
              <span key={t} className="chip bg-violet-50 text-violet-600">
                {t}
              </span>
            ))}
            {o.statusTag && <span className="chip bg-indigo-50 text-indigo-600">{o.statusTag}</span>}
            {o.occurrences > 1 && (
              <span className="chip bg-orange-50 text-orange-600">转发 {o.occurrences}</span>
            )}
            {o.confidence !== 'high' && (
              <span className="chip bg-amber-50 text-amber-600" title={o.warnings.join('\n')}>
                {o.confidence === 'low' ? '识别存疑' : '信息不全'}
              </span>
            )}
          </div>

          <div className="mt-1 truncate text-[12.5px] text-slate-500">{o.address ?? '地址未识别'}</div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px] text-slate-500">
            {o.gradeText && <span className="text-slate-600">{o.gradeText}</span>}
            {o.mode && <span>{o.mode}</span>}
            {o.freqPerWeek ? <span>每周 {o.freqPerWeek} 次</span> : null}
            {o.hoursPerSession ? <span>每次 {o.hoursPerSession}h</span> : null}
            {o.orderNo && <span className="font-mono text-[11px] text-slate-400">#{o.orderNo}</span>}
            {/* 时效只用发送时间；超过一天变色，因为这种单基本已经被接掉了 */}
            <span className={cn('text-[11.5px]', stale ? 'text-rose-500' : 'text-slate-400')} title={o.sentAt ?? ''}>
              {relTime(o.sentAt)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className={cn('chip font-semibold', TONE[verdictTone(o.match.verdict)])}
              title={reasons.length ? reasons.map((r) => `${r.dimension}：${r.detail}`).join('\n') : '硬条件全过'}
            >
              {o.match.verdict}
              {reasons.length > 0 && <span className="tabular-nums opacity-70">{reasons.length}</span>}
            </span>
            <span className={cn('chip', STATUS_STYLE[o.status])}>{STATUS_LABEL[o.status]}</span>
            <Star on={o.starred} onClick={() => onPatch({ starred: !o.starred })} />
          </div>
          <span className={cn('chip tabular-nums', TONE[commute.tone])} title={commute.title}>
            {commute.text}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3">
          {/* 一、换乘方案：决策 6 要能看多种方案，最快那套不一定最省事 */}
          <section className="mb-3">
            <h4 className="mb-1.5 text-[11px] font-semibold tracking-wider text-slate-400">
              通勤方案{detail?.departAt ? `（${detail.departAt.replace('T', ' ')} 出发）` : ''}
            </h4>
            {detailError ? (
              <p className="text-[12px] text-rose-500">{detailError}</p>
            ) : !detail ? (
              <p className="text-[12px] text-slate-400">读取方案…</p>
            ) : detail.options.length === 0 ? (
              <p className="text-[12px] text-slate-400">
                {o.commuteStatus === 'failed'
                  ? `没算出来：${detail.error ?? o.commuteError ?? '原因未知'}`
                  : '还没有方案。列表刷新后后台会算这一单。'}
              </p>
            ) : (
              <ul className="space-y-1">
                {detail.options.map((opt, i) => (
                  <li
                    key={`${opt.minutes}-${i}`}
                    className={cn(
                      'flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border bg-white px-2.5 py-1.5 text-[12px]',
                      i === 0 ? 'border-emerald-200' : 'border-slate-200',
                    )}
                  >
                    <span className={cn('tabular-nums font-semibold', i === 0 ? 'text-emerald-700' : 'text-slate-700')}>
                      {minutesText(opt.minutes)}
                    </span>
                    <span className="text-slate-500">
                      {opt.transfers === 0 ? '直达' : `换 ${opt.transfers} 次`}
                    </span>
                    <span className="text-slate-500">步行 {distanceText(opt.walking)}</span>
                    {opt.fare !== null && <span className="text-slate-500">{opt.fare} 元</span>}
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-400" title={opt.lines.join(' → ')}>
                      {opt.lines.join(' → ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 二、为什么不通过：只列没过的维度，不列通过的 */}
          {reasons.length > 0 && (
            <section className="mb-3">
              <h4 className="mb-1.5 text-[11px] font-semibold tracking-wider text-slate-400">判定依据</h4>
              <ul className="flex flex-wrap gap-1.5">
                {reasons.map((r) => (
                  <li key={`${r.dimension}-${r.detail}`} className={cn('chip', TONE[r.verdict === '不可接' ? 'bad' : 'warn'])}>
                    {r.dimension}：{r.detail}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {(['new', 'seen', 'contacted', 'discarded'] as OrderStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => onPatch({ status: s })}
                className={cn(
                  'rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                  o.status === s
                    ? 'border-slate-800 bg-slate-800 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                )}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
            <div className="flex-1" />
            <button onClick={copy} className="btn-ghost !px-2 !py-1 !text-[11.5px]">
              {copied ? '已复制' : '复制原文'}
            </button>
          </div>

          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-white p-3 font-mono text-[12px] leading-relaxed text-slate-700">
            {o.rawText}
          </pre>

          {o.warnings.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {o.warnings.map((w) => (
                <li key={w} className="chip bg-amber-50 text-amber-700">
                  {w}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <span>发布 {o.sentAt ? new Date(o.sentAt).toLocaleString('zh-CN') : '时间未知'}</span>
            <span>首次收录 {new Date(o.firstSeen).toLocaleString('zh-CN')}</span>
            <span>最近出现 {new Date(o.lastSeen).toLocaleString('zh-CN')}</span>
            {o.commuteCheckedAt && <span>通勤计算于 {new Date(o.commuteCheckedAt).toLocaleString('zh-CN')}</span>}
            {tiers && <span className="text-slate-500">分档：{tiers}</span>}
            {o.teacherReq && <span className="text-slate-500">要求：{o.teacherReq}</span>}
          </div>
        </div>
      )}
    </article>
  );
}
