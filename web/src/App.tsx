import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCaptureStatus, fetchMeta, fetchOrders, patchOrder } from './api';
import { FilterSidebar } from './components/Filters';
import { ImportDialog } from './components/ImportDialog';
import { OrderCard } from './components/OrderCard';
import { SettingsDrawer, type SettingsTab } from './components/SettingsDrawer';
import type { CaptureStatus, Filters, Meta, Order, OrderStatus, OrdersResponse } from './types';
import { SORT_LABEL, STATUS_LABEL } from './types';
import { cn } from './cn';

const DEFAULT_FILTERS: Filters = {
  q: '',
  districts: [],
  stages: [],
  subjects: [],
  modes: [],
  statuses: [],
  verdict: '',
  minHourly: '',
  maxCommuteMinutes: '',
  commuteFailed: false,
  starredOnly: false,
  // 决策 8：默认通勤最短优先
  sort: 'commute',
};

const STATUS_TABS: (OrderStatus | null)[] = [null, 'new', 'seen', 'contacted', 'discarded'];

/** 后台算通勤时的轮询间隔：一屏 30 单约 12 秒跑完，3.5 秒一刷够快又不吵 */
const POLL_MS = 3500;

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [orders, setOrders] = useState<Order[]>([]);
  const [page, setPage] = useState<OrdersResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile');
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /** 从任何地方跳到设置里的某一页（典型路径：通勤提示条说「还没有出发点」→ 直接落到出发点表单） */
  const openSettings = useCallback((tab: SettingsTab = 'profile') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  /** quiet = 后台轮询，不显示「加载中」，也不闪列表 */
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await fetchOrders(filters);
        setOrders(res.items);
        setPage(res);
      } catch {
        if (!quiet) setToast('无法连接本地服务，请确认后端已启动');
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [filters],
  );

  const reloadMeta = useCallback(() => {
    fetchMeta().then(setMeta).catch(() => undefined);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 180);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    reloadMeta();
  }, [reloadMeta]);

  /**
   * 剪贴板自动导入的反馈。
   *
   * 【为什么界面必须自己轮询】自动导入发生在服务端，界面完全看不见 ——
   * 用户复制完一段切回来看，如果列表没动、也没有任何提示，就会以为功能坏了，
   * 然后又去手动粘一遍（于是走了「合并」，还以为是重复导入）。
   * 所以这里盯着 `/api/capture/status`：出现新摘要就弹提示 + 重拉列表。
   */
  const captureSeen = useRef<string | null>(null);
  const captureReady = useRef(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchCaptureStatus();
        if (!alive) return;
        setCapture(s);
        const newest = s.recent[0];
        if (newest && newest.at !== captureSeen.current) {
          const isFirstLook = !captureReady.current;
          captureSeen.current = newest.at;
          captureReady.current = true;
          // 首次打开页面时把历史摘要当基线，不弹旧提示
          if (!isFirstLook) {
            setToast(
              newest.orders > 0
                ? `剪贴板识别到 ${newest.orders} 单（新增 ${newest.inserted}${newest.duplicated ? `，合并 ${newest.duplicated}` : ''}）`
                : '剪贴板内容没识别出单子',
            );
            void load(true);
            reloadMeta();
          }
        }
      } catch {
        /* 服务没起或接口不存在：静默，不打扰 */
      }
    };
    void tick();
    const timer = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load, reloadMeta]);

  /**
   * 通勤是后台串行算的：请求返回时这些单子还没数。
   * 只要队列里还有活（或本次又排进去了新的），就隔几秒自己再拉一次，算完自动出现。
   * 【为什么不做 WebSocket】为了一个「十几秒后就安静」的场景引入长连接，
   * 换来的是状态同步、断线重连一堆复杂度，不值得。
   */
  useEffect(() => {
    if (!page) return;
    const c = page.commute;
    const busy = c.busy || c.queued > 0 || page.commuteEnqueued > 0;
    if (!busy) return;
    const t = setTimeout(() => void load(true), POLL_MS);
    return () => clearTimeout(t);
  }, [page, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const patch = useCallback(
    async (id: number, p: Partial<Pick<Order, 'status' | 'starred'>>) => {
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ...p } : o)));
      try {
        await patchOrder(id, p);
        reloadMeta();
      } catch {
        setToast('更新失败');
      }
    },
    [reloadMeta],
  );

  const toggleExpand = (o: Order) => {
    setExpandedId((cur) => (cur === o.id ? null : o.id));
    // 展开即视为看过，但不再重新拉列表，避免条目当场消失
    if (o.status === 'new') void patch(o.id, { status: 'seen' });
  };

  const activeStatus = filters.statuses.length === 1 ? (filters.statuses[0] as OrderStatus) : null;
  const commute = page?.commute;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-[13px] font-bold text-white">
            家
          </div>
          <div>
            <div className="text-[13.5px] font-semibold leading-tight text-slate-900">家教单助手</div>
            <div className="text-[10.5px] leading-tight text-slate-400">
              共 {meta?.total ?? 0} 单 · {meta?.fresh ?? 0} 条未看
            </div>
          </div>
        </div>

        <div className="ml-3 flex-1">
          <div className="relative max-w-md">
            <svg
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              placeholder="搜索地址、科目、教员要求…"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-14 text-[13px] outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white px-1 text-[10px] text-slate-400">
              /
            </kbd>
          </div>
        </div>

        {capture?.running && (
          <button
            onClick={() => openSettings('capture')}
            title="剪贴板自动导入已开启：复制一段群消息就会自动入库"
            className="chip bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            自动导入
          </button>
        )}

        <button onClick={() => openSettings('profile')} title="资质 / 出发点 / 通勤状态 / 自动导入" className="btn-ghost">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008.9 19a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 8.9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H10a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V10a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
          </svg>
          设置
        </button>
        <button onClick={() => setImportOpen(true)} className="btn-primary">
          粘贴导入
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <FilterSidebar
          meta={meta}
          filters={filters}
          commuteFailedCount={page?.commuteFailed ?? 0}
          onChange={(p) => setFilters((f) => ({ ...f, ...p }))}
          onReset={() => setFilters(DEFAULT_FILTERS)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-2">
            <div className="flex items-center gap-0.5">
              {STATUS_TABS.map((s) => {
                const active = s === activeStatus;
                return (
                  <button
                    key={s ?? 'all'}
                    onClick={() =>
                      setFilters((f) => ({ ...f, statuses: s && !active ? [s] : [] }))
                    }
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[12px] transition-colors',
                      active ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
                    )}
                  >
                    {s ? STATUS_LABEL[s] : '全部'}
                  </button>
                );
              })}
            </div>

            <div className="flex-1" />

            <span className="text-[11.5px] tabular-nums text-slate-400">{loading ? '加载中…' : `${orders.length} 条`}</span>

            {/*
              「通勤算不出」这一栏没有一单有通勤数据，排序器给不了任何信息，
              与其显示一个假的「按通勤最短」，不如直接说明它是按入库时间倒序。
            */}
            {filters.commuteFailed ? (
              <span className="text-[11.5px] text-slate-400" title="这些单子没有通勤数据可排，按入库时间倒序">
                按导入时间排
              </span>
            ) : (
              <select
                value={filters.sort}
                onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as Filters['sort'] }))}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-600 outline-none focus:border-indigo-400"
              >
                {(Object.keys(SORT_LABEL) as Filters['sort'][]).map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABEL[k]}
                  </option>
                ))}
              </select>
            )}
          </div>

          <ProfileNotice page={page} onOpenSettings={openSettings} />
          {/* 空库时不显示通勤提示条：第一屏的引导块已经把「加出发点」这一步说清楚了（见下方 FirstRun） */}
          {Boolean(meta?.total) && <CommuteNotice page={page} onOpenSettings={openSettings} />}

          <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
            {!loading && orders.length === 0 && (
              <div className="mt-24 text-center">
                <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-slate-200/70 text-slate-400">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v11a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5z" />
                    <path d="M8 9h8M8 13h5" strokeLinecap="round" />
                  </svg>
                </div>
                <p className="text-[13px] font-medium text-slate-600">
                  {meta?.total ? '当前条件下没有单子' : '还没有收录任何单子'}
                </p>
                <p className="mx-auto mt-1 max-w-xs text-[12px] leading-relaxed text-slate-400">
                  {meta?.total
                    ? filters.commuteFailed
                      ? '当前没有「通勤算不出」的单子 —— 切回「全部」继续看。'
                      : filters.sort === 'commute' || filters.maxCommuteMinutes
                        ? '通勤还没算完的单子不会参与通勤排序/筛选 —— 等后台算完再看，或者先切回「按时薪排序」。'
                        : '试着放宽时薪下限，或清空左侧的区域/科目筛选。'
                    : '两步就能用起来：先粘一批单子，再告诉程序你从哪出发。'}
                </p>
                {!meta?.total && (
                  <FirstRun
                    onImport={() => setImportOpen(true)}
                    onAddOrigin={() => openSettings('origins')}
                    hasOrigin={Boolean(page?.commute.origin)}
                  />
                )}
              </div>
            )}

            <div className="space-y-2">
              {orders.map((o) => (
                <OrderCard
                  key={o.id}
                  order={o}
                  expanded={expandedId === o.id}
                  onToggle={() => toggleExpand(o)}
                  onPatch={(p) => void patch(o.id, p)}
                />
              ))}
            </div>
          </div>
        </main>
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          void load();
          reloadMeta();
        }}
      />

      <SettingsDrawer
        open={settingsOpen}
        tab={settingsTab}
        onTab={setSettingsTab}
        onClose={() => setSettingsOpen(false)}
        // 资质改了 → 判定要重算；出发点是判定无关、通勤有关。两者都表现为「列表得重拉一次」
        onProfileSaved={() => {
          void load();
          reloadMeta();
        }}
        onOriginsChanged={() => {
          void load();
          reloadMeta();
        }}
      />

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-800 px-4 py-2 text-[12.5px] text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/**
 * 空库首启的两步引导。
 *
 * 【为什么要把两步摆在一起】这两件事**只有用户能做**：单子得他复制、出发点必须他给
 * （第 6 节第 14 条：起点不许猜）。而它们的入口分散在头部「粘贴导入」和「设置 → 出发点」，
 * 新用户看到一屏空白，最可能的动作是关掉程序 —— 所以第一屏就把顺序写死：先粘单，再给起点。
 * 第二步没做时明确说清后果（通勤不算、列表只能按时薪排），而不是留一个沉默的空白列。
 */
function FirstRun({
  onImport,
  onAddOrigin,
  hasOrigin,
}: {
  onImport: () => void;
  onAddOrigin: () => void;
  hasOrigin: boolean;
}) {
  return (
    <div className="mx-auto mt-5 w-[370px] space-y-2 text-left">
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex items-center gap-2">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-indigo-600 text-[10.5px] font-semibold text-white">
            1
          </span>
          <span className="text-[12.5px] font-medium text-slate-800">粘一批群消息进来</span>
          <div className="flex-1" />
          <button onClick={onImport} className="btn-primary !px-2.5 !py-1 !text-[11.5px]">
            粘贴导入
          </button>
        </div>
        <p className="mt-1.5 pl-7 text-[11px] leading-relaxed text-slate-500">
          在微信里选中消息复制，整段粘进来；一条消息里的多个单子会按编号自动拆开。
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold',
              hasOrigin ? 'bg-emerald-500 text-white' : 'bg-indigo-600 text-white',
            )}
          >
            2
          </span>
          <span className="text-[12.5px] font-medium text-slate-800">告诉我你从哪出发</span>
          <div className="flex-1" />
          {hasOrigin ? (
            <span className="text-[11px] text-emerald-600">已设置</span>
          ) : (
            <button onClick={onAddOrigin} className="btn-ghost !px-2.5 !py-1 !text-[11.5px]">
              添加出发点
            </button>
          )}
        </div>
        <p className="mt-1.5 pl-7 text-[11px] leading-relaxed text-slate-500">
          通勤按「你从哪出发」算，不填就只有时薪和时效可排 —— 而通勤正是默认排序依据。
        </p>
      </div>
    </div>
  );
}

/**
 * 资质读取失败提示。
 *
 * 【为什么必须单独一条、且用红色】profile.json 写坏时后端故意不拦路：列表照常返回，
 * 但**全部**单子都按空资质判成「存疑」。这在界面上看起来完全像是「今天没有好单」——
 * 不明确指出，用户永远不会想到去修一个 JSON 文件。
 */
function ProfileNotice({
  page,
  onOpenSettings,
}: {
  page: OrdersResponse | null;
  onOpenSettings: (tab: SettingsTab) => void;
}) {
  if (!page?.profileError) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-rose-100 bg-rose-50 px-4 py-1.5 text-[11.5px] text-rose-700">
      <span className="font-medium">资质读不出来</span>
      <span className="min-w-0 truncate" title={page.profileError}>
        {page.profileError}
      </span>
      <span className="shrink-0 opacity-80">—— 现在全部单子都按空资质判成「存疑」</span>
      <div className="flex-1" />
      <button
        onClick={() => onOpenSettings('profile')}
        className="shrink-0 rounded bg-white/70 px-1.5 py-0.5 font-medium hover:bg-white hover:underline"
      >
        去修资质 →
      </button>
    </div>
  );
}

/**
 * 通勤状态条。
 *
 * 【为什么值得占一行】「通勤一列空白」有四种完全不同的原因：没 key、没出发点、配额用完、
 * 正在算。不写清楚，用户唯一能做的就是反复刷新然后怀疑程序坏了。
 *
 * 【为什么要把按钮放在这句话旁边】没有出发点是最常见的空状态，而且**只有用户能修**（起点不许猜）。
 * 只说一句「还没有出发点」，用户还得自己去找设置入口。
 */
function CommuteNotice({
  page,
  onOpenSettings,
}: {
  page: OrdersResponse | null;
  onOpenSettings: (tab: SettingsTab) => void;
}) {
  if (!page) return null;
  const c = page.commute;
  const queued = page.commuteEnqueued > 0 || c.busy || c.queued > 0;

  let text: string | null = null;
  let tone: 'warn' | 'info' | 'muted' = 'info';
  let action: { label: string; tab: SettingsTab } | null = null;

  if (c.blockedBy === 'no_key') {
    text = '通勤未配置：没读到 AMAP_KEY，其余功能正常（在 .env 里填上即可）';
    tone = 'muted';
  } else if (c.blockedBy === 'no_origin') {
    text = '还没有出发点 —— 加一个出发点之后才会算通勤';
    tone = 'warn';
    action = { label: '添加出发点', tab: 'origins' };
  } else if (c.blockedBy === 'quota') {
    text = `今日通勤配额已用完（${c.quota.used}/${c.quota.limit} 次），明天 0 点恢复`;
    tone = 'warn';
    action = { label: '看配额', tab: 'commute' };
  } else if (page.sortFallback) {
    text = '通勤还在算，先按时薪排；算完会自动切回「按通勤最短」';
    tone = 'info';
  } else if (queued) {
    text = `正在算通勤${c.queued > 0 ? `（排队 ${c.queued} 单）` : ''}…`;
    tone = 'info';
  } else if (c.pending > 0) {
    text = `还有 ${c.pending} 单没算出通勤；它们不参与通勤排序与通勤上限筛选`;
    tone = 'muted';
    action = { label: '看通勤状态', tab: 'commute' };
  }

  if (!text) return null;

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[11.5px]',
        tone === 'warn' && 'border-amber-100 bg-amber-50 text-amber-700',
        tone === 'info' && 'border-indigo-100 bg-indigo-50 text-indigo-700',
        tone === 'muted' && 'border-slate-200 bg-white text-slate-500',
      )}
    >
      {tone === 'info' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />}
      <span>{text}</span>
      {action && (
        <button
          onClick={() => onOpenSettings(action.tab)}
          className="rounded bg-white/70 px-1.5 py-0.5 font-medium underline-offset-2 hover:bg-white hover:underline"
        >
          {action.label} →
        </button>
      )}
      <div className="flex-1" />
      <span className="tabular-nums text-[10.5px] opacity-70">
        已算 {c.ready} 单 · 配额 {c.quota.used}/{c.quota.limit}
      </span>
    </div>
  );
}
