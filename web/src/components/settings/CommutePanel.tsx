import { useCallback, useEffect, useState } from 'react';
import { fetchCommuteStatus } from '../../api';
import type { CommuteStatus } from '../../types';
import { cn } from '../../cn';
import { SectionTitle } from './bits';

interface Props {
  /** 抽屉每开一次就重读一次，避免看到打开抽屉那一刻的旧状态 */
  onOpenOrigins: () => void;
}

/**
 * 通勤状态面板。
 *
 * 【为什么值得单独一栏】「通勤一列空白」有四种原因：没 key、没出发点、配额用完、正在算。
 * 前两种用户自己能修，第三种只能等，第四种什么都别做 —— 不把原因摊开，
 * 用户唯一能做的动作就是反复刷新然后怀疑程序坏了。
 */
export function CommutePanel({ onOpenOrigins }: Props) {
  const [s, setS] = useState<CommuteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchCommuteStatus()
      .then(setS)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '读取失败'));
  }, []);

  useEffect(() => {
    load();
    // 算通勤是后台串行的，打开着就顺手刷两轮，省得用户盯着一个「已算 3 单」看不出变化
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  if (!s) {
    return <div className="px-4 py-6 text-[12px] text-slate-400">{error ?? '读取通勤状态…'}</div>;
  }

  const quotaPct = s.quota.limit > 0 ? Math.min(100, Math.round((s.quota.used / s.quota.limit) * 100)) : 0;

  const blockerText =
    s.blockedBy === 'no_key'
      ? '没读到 AMAP_KEY —— 在仓库根目录 .env 里填上后重启服务'
      : s.blockedBy === 'no_origin'
        ? '还没有出发点 —— 通勤不会自己开始算'
        : s.blockedBy === 'quota'
          ? '今日配额已用完，明天 0 点恢复'
          : null;

  return (
    <div className="space-y-5 px-4 py-4">
      {blockerText && (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-[11.5px] leading-relaxed',
            s.blockedBy === 'no_origin' ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700',
          )}
        >
          <p>{blockerText}</p>
          {s.blockedBy === 'no_origin' && (
            <button onClick={onOpenOrigins} className="mt-1.5 font-medium text-indigo-600 hover:text-indigo-700">
              去添加出发点 →
            </button>
          )}
        </div>
      )}

      <div>
        <SectionTitle>地图服务</SectionTitle>
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px]">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'chip',
                s.provider.configured ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500',
              )}
            >
              {s.provider.configured ? '已配置' : '未配置'}
            </span>
            <span className="text-slate-700">{s.provider.name ?? '高德公交路径规划'}</span>
          </div>
          {s.provider.reason && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{s.provider.reason}</p>}
          <p className="mt-1 text-[10.5px] leading-relaxed text-slate-400">
            走公交（地铁公交）规划，一次返回多套换乘方案；出发时刻固定为「下一个工作日 08:00」，
            否则每天算出来的数不可比
          </p>
        </div>
      </div>

      <div>
        <SectionTitle>起点</SectionTitle>
        {s.origin ? (
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <div className="text-[12px] font-medium text-slate-800">{s.origin.name}</div>
            <div className="mt-0.5 break-all text-[11.5px] leading-relaxed text-slate-500">{s.origin.address}</div>
            <div className="mt-1 text-[10.5px] text-slate-400">
              {s.origin.lng !== null && s.origin.lat !== null
                ? `坐标 ${s.origin.lng.toFixed(4)}, ${s.origin.lat.toFixed(4)}`
                : '尚未定位，下次算通勤时会向高德定位一次'}
            </div>
          </div>
        ) : (
          <button onClick={onOpenOrigins} className="text-[12px] text-indigo-600 hover:text-indigo-700">
            还没有出发点，去添加 →
          </button>
        )}
      </div>

      <div>
        <SectionTitle>今日配额</SectionTitle>
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          <div className="flex items-baseline justify-between text-[12px]">
            <span className="tabular-nums text-slate-800">
              {s.quota.used} <span className="text-slate-400">/ {s.quota.limit} 次</span>
            </span>
            <span className={cn('text-[11px]', s.quota.exhausted ? 'text-rose-600' : 'text-slate-400')}>
              剩 {s.quota.remaining}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn('h-full rounded-full', quotaPct >= 90 ? 'bg-rose-500' : quotaPct >= 60 ? 'bg-amber-400' : 'bg-emerald-500')}
              style={{ width: `${quotaPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-400">
            单位是调用不是单子：一单最多两次（定位 + 规划）。命中缓存不扣。上限可用 .env 的 AMAP_DAILY_LIMIT 调
          </p>
        </div>
      </div>

      <div>
        <SectionTitle>队列</SectionTitle>
        <div className="grid grid-cols-1 gap-1.5 text-[12px] text-slate-700">
          <Row label="已算完" value={`${s.ready} 单`} />
          <Row label="还没算" value={`${s.pending} 单`} tone={s.pending > 0 ? 'warn' : undefined} />
          <Row
            label="正在算 / 排队"
            value={s.busy || s.queued > 0 ? `${s.queued} 单${s.busy ? '（进行中）' : ''}` : '空闲'}
            tone={s.busy || s.queued > 0 ? 'info' : undefined}
          />
        </div>
      </div>

      {s.lastError && (
        <div>
          <SectionTitle>最近一次错误</SectionTitle>
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-700">{s.lastError}</p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-slate-400">
            失败的会记 6 小时冷却，冷却期内不再重排 —— 否则每刷一次界面就撞一次同样的错、烧一次配额
          </p>
        </div>
      )}

      <button onClick={load} className="btn-ghost">
        刷新状态
      </button>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'info' }) {
  return (
    <div className="flex items-baseline justify-between border-b border-slate-100 pb-1">
      <span className="text-[11.5px] text-slate-500">{label}</span>
      <span className={cn('tabular-nums', tone === 'warn' && 'text-amber-600', tone === 'info' && 'text-indigo-600')}>
        {value}
      </span>
    </div>
  );
}
