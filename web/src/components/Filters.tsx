import type { Facet, Filters as F, Meta } from '../types';
import { VERDICTS } from '../types';
import { cn } from '../cn';

interface Props {
  meta: Meta | null;
  filters: F;
  onChange: (patch: Partial<F>) => void;
  onReset: () => void;
}

function FacetGroup({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: Facet[] | undefined;
  selected: string[];
  onToggle: (v: string) => void;
}) {
  if (!items?.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400">{title}</h3>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => {
          const active = selected.includes(it.value);
          return (
            <button
              key={it.value}
              onClick={() => onToggle(it.value)}
              className={cn(
                'chip border transition-colors',
                active
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
              )}
            >
              {it.value}
              <span className={cn('tabular-nums', active ? 'text-indigo-400' : 'text-slate-300')}>{it.count}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function FilterSidebar({ meta, filters, onChange, onReset }: Props) {
  const toggle = (key: 'districts' | 'stages' | 'subjects' | 'modes', v: string) => {
    const cur = filters[key];
    onChange({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<F>);
  };

  const activeCount =
    filters.districts.length +
    filters.stages.length +
    filters.subjects.length +
    filters.modes.length +
    (filters.verdict ? 1 : 0) +
    (filters.minHourly ? 1 : 0) +
    (filters.maxCommuteMinutes ? 1 : 0) +
    (filters.starredOnly ? 1 : 0);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <span className="text-[12px] font-medium text-slate-500">筛选条件</span>
        <button
          onClick={onReset}
          disabled={!activeCount}
          className={cn(
            'text-[11px] transition-colors',
            activeCount ? 'text-indigo-600 hover:text-indigo-700' : 'text-slate-300',
          )}
        >
          清空{activeCount ? `(${activeCount})` : ''}
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {/* 可接性放最上面：决策 10 是「排除优先」，先砍掉接不了的，比在剩下的里面挑更省时间 */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400">可接性</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {(['', ...VERDICTS] as const).map((v) => {
              const active = filters.verdict === v;
              return (
                <button
                  key={v || 'all'}
                  onClick={() => onChange({ verdict: v })}
                  className={cn(
                    'chip justify-center border py-1 transition-colors',
                    active
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                  )}
                >
                  {v || '全部'}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10.5px] leading-snug text-slate-400">
            「存疑」= 有资料没填全或只写了「优先」，宁可疑也不漏
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400">时薪下限</h3>
          <div className="relative">
            <input
              value={filters.minHourly}
              onChange={(e) => onChange({ minHourly: e.target.value.replace(/[^\d.]/g, '') })}
              placeholder="例如 80"
              inputMode="decimal"
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 pr-14 text-[13px] outline-none transition-colors placeholder:text-slate-300 focus:border-indigo-400"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
              元/小时
            </span>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-snug text-slate-400">
            月薪会按 频次×单次时长 折算后再比较
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400">通勤上限</h3>
          <div className="relative">
            <input
              value={filters.maxCommuteMinutes}
              onChange={(e) => onChange({ maxCommuteMinutes: e.target.value.replace(/[^\d]/g, '') })}
              placeholder="例如 60"
              inputMode="numeric"
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 pr-10 text-[13px] outline-none transition-colors placeholder:text-slate-300 focus:border-indigo-400"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
              分钟
            </span>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-snug text-slate-400">
            只留算法算完的单子；没算完的不参与比较，避免「先算完的」冒充「最近的」
          </p>
        </section>

        <FacetGroup title="区域" items={meta?.districts} selected={filters.districts} onToggle={(v) => toggle('districts', v)} />
        <FacetGroup title="学段" items={meta?.stages} selected={filters.stages} onToggle={(v) => toggle('stages', v)} />
        <FacetGroup title="科目" items={meta?.subjects} selected={filters.subjects} onToggle={(v) => toggle('subjects', v)} />
        <FacetGroup title="授课形式" items={meta?.modes} selected={filters.modes} onToggle={(v) => toggle('modes', v)} />

        <section>
          <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400">其他</h3>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-slate-600">
            <input
              type="checkbox"
              checked={filters.starredOnly}
              onChange={(e) => onChange({ starredOnly: e.target.checked })}
              className="h-3.5 w-3.5 accent-indigo-600"
            />
            只看已收藏
          </label>
        </section>
      </div>
    </aside>
  );
}
