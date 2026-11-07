import express, { type Request } from 'express';
import cors from 'cors';
import {
  addOrigin,
  countCommuteReady,
  deleteOrder,
  deleteOrigin,
  getMeta,
  importMessage,
  listOrders,
  listOrigins,
  updateOrder,
  updateOrigin,
  type OrderQuery,
} from './db.ts';
import { EMPTY_PROFILE, loadProfile, ProfileError, profilePath, saveProfile, type Profile } from './profile.ts';
import { matchOrder } from './match/match.ts';
import { createAmapProvider } from './commute/amap.ts';
import { createCommuteService, type CommuteService } from './commute/service.ts';
import { clipboardWatcher } from './clipboard.ts';

/**
 * 读资质时「坏文件不拦路」：profile.json 写坏了只让判定失效，
 * 不该让整个列表打不开；错误原样带回给前端提示。
 */
function currentProfile(): { profile: Profile; error: string | null } {
  try {
    return { profile: loadProfile(), error: null };
  } catch (e) {
    return { profile: { ...EMPTY_PROFILE }, error: e instanceof Error ? e.message : String(e) };
  }
}


function arr(req: Request, key: string): string[] | undefined {
  const v = req.query[key];
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v.split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean);
}

function num(req: Request, key: string): number | undefined {
  const v = req.query[key];
  if (typeof v !== 'string' || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 通勤服务默认从 env 造一个：没有 AMAP_KEY 时 provider 为 null，整站照常、通勤列显示「未配置」 */
export function createApp(commute: CommuteService = createCommuteService({ provider: createAmapProvider() })) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  /** 导入：文本 → 切块 → 归一化 → 入库（本地去重） */
  app.post('/api/import', (req, res) => {
    const { text, groupName, sender, sentAt, source } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text 不能为空' });
      return;
    }
    res.json(importMessage({ text, groupName, sender, sentAt, source }));
  });

  app.get('/api/orders', (req, res) => {
    const requested = (req.query.sort as OrderQuery['sort']) ?? 'commute';
    /**
     * 默认按通勤最短排（决策 8）。但刚导入时一条都还没算完，按红线又不能把没算的单子混进来，
     * 于是首页会变成空列表 —— 用户只会以为坏了。所以：一单都没算完时降级按时薪排，
     * 并在响应里明确标 `sortFallback`，界面据此显示「通勤计算中，暂按时薪排」。
     * 这不违反红线：没算完的单子没有出现在任何「通勤排序」的结果里。
     */
    const sortUsed: OrderQuery['sort'] =
      requested === 'commute' && countCommuteReady() === 0 ? 'hourly' : requested;

    const q: OrderQuery = {
      q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
      districts: arr(req, 'districts'),
      stages: arr(req, 'stages'),
      subjects: arr(req, 'subjects'),
      modes: arr(req, 'modes'),
      statuses: arr(req, 'statuses'),
      minHourly: num(req, 'minHourly'),
      maxHourly: num(req, 'maxHourly'),
      starred: req.query.starred === '1',
      sort: sortUsed,
      maxCommuteMinutes: num(req, 'maxCommuteMinutes'),
      limit: num(req, 'limit') ?? 500,
    };
    const { profile, error } = currentProfile();
    let items = listOrders(q).map((o) => ({ ...o, match: matchOrder(o.teacherReq, profile) }));
    // 三态筛选：?verdict=可接 / 存疑 / 不可接
    const verdict = typeof req.query.verdict === 'string' && req.query.verdict ? req.query.verdict : undefined;
    if (verdict) items = items.filter((o) => o.match.verdict === verdict);

    /**
     * 按需计算：每次请求把 **全库待算集合** 里的前 30 条入队（决策 8.4）。
     *
     * 【为什么不能用 items 去入队】按通勤排序时 items 只含「已算完」的单子（红线），
     * 于是算完第一单之后这里永远拿到 0 个候选，剩下的单子再没人捞 ——
     * 界面一直显示「还有 N 单没算出通勤」，队列却是空闲的。
     * 入队源必须与当前页的排序/筛选解耦。
     */
    const { candidates, queued } = commute.enqueuePending();

    res.json({
      total: items.length,
      items,
      profileError: error,
      sort: sortUsed,
      sortFallback: sortUsed !== requested,
      commute: commute.status(),
      commuteEnqueued: queued,
      commuteCandidates: candidates,
    });
  });

  /** 单子的全部换乘方案（决策 6：要能看多种方案）。数据来自缓存，不重新调用高德 */
  app.get('/api/orders/:id/commute', (req, res) => {
    const view = commute.optionsFor(Number(req.params.id));
    if (!view) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(view);
  });

  app.get('/api/commute/status', (_req, res) => res.json(commute.status()));

  /** 剪贴板自动导入的状态与最近几次摘要（只有编号与计数，没有正文） */
  app.get('/api/capture/status', (_req, res) => res.json(clipboardWatcher.status()));

  app.get('/api/origins', (_req, res) => res.json({ items: listOrigins() }));

  app.post('/api/origins', (req, res) => {
    const { name, address, isDefault } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || typeof address !== 'string' || !address.trim()) {
      res.status(400).json({ error: 'name 与 address 都不能为空' });
      return;
    }
    /**
     * 只在客户端**明确**给了布尔值时才传 isDefault。
     * 原来写的是 `Boolean(isDefault)`：客户端不带这个字段时变成 `false`，
     * 于是「第一条出发点自动成为默认」这条规则被悄悄取消了 —— 库里有一堆出发点、一个都不是默认，
     * 界面上那条「默认」标签永远不会亮起来。宁可传 undefined，让 db.addOrigin 自己决定。
     */
    res.json(
      addOrigin({
        name: name.trim(),
        address: address.trim(),
        isDefault: typeof isDefault === 'boolean' ? isDefault : undefined,
      }),
    );
  });

  app.patch('/api/origins/:id', (req, res) => {
    const origin = updateOrigin(Number(req.params.id), req.body ?? {});
    if (!origin) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(origin);
  });

  app.delete('/api/origins/:id', (req, res) => {
    deleteOrigin(Number(req.params.id));
    res.json({ ok: true });
  });

  app.patch('/api/orders/:id', (req, res) => {
    const row = updateOrder(Number(req.params.id), req.body ?? {});
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(row);
  });

  app.delete('/api/orders/:id', (req, res) => {
    deleteOrder(Number(req.params.id));
    res.json({ ok: true });
  });

  /** 我的资质：可读可改，落 data/profile.json，改完立刻生效（每次请求重新读） */
  app.get('/api/profile', (_req, res) => {
    const { profile, error } = currentProfile();
    res.json({ profile, error, path: profilePath() });
  });

  app.put('/api/profile', (req, res) => {
    try {
      res.json({ profile: saveProfile(req.body ?? {}), error: null, path: profilePath() });
    } catch (e) {
      if (e instanceof ProfileError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
  });

  app.get('/api/meta', (_req, res) => res.json(getMeta()));

  return app;
}
