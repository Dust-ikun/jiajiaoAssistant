import type {
  CommuteIssues,
  CommuteStatus,
  Filters,
  ImportResult,
  Meta,
  Order,
  OrderCommuteDetail,
  OrdersResponse,
  Origin,
  Profile,
  ProfileResponse,
} from './types';

export function buildQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.districts.length) p.set('districts', f.districts.join(','));
  if (f.stages.length) p.set('stages', f.stages.join(','));
  if (f.subjects.length) p.set('subjects', f.subjects.join(','));
  if (f.modes.length) p.set('modes', f.modes.join(','));
  if (f.statuses.length) p.set('statuses', f.statuses.join(','));
  // 群名是用户手填的自由文本，可能带逗号 —— 一个群一个参数，别用逗号拼
  for (const g of f.groups) p.append('groups', g);
  if (f.verdict) p.set('verdict', f.verdict);
  if (f.minHourly.trim()) p.set('minHourly', f.minHourly.trim());
  if (f.maxCommuteMinutes.trim()) p.set('maxCommuteMinutes', f.maxCommuteMinutes.trim());
  if (f.commuteFailed) p.set('commute', 'failed');
  if (f.starredOnly) p.set('starred', '1');
  p.set('sort', f.sort);
  return p.toString();
}

/**
 * 列表 + 通勤状态一起返回。
 * 【为什么要返回整个响应而不是只有 items】界面需要知道三件事：排序是不是被降级了、
 * 还有多少单在算、通勤现在因为什么算不动 —— 否则用户面对一片「通勤未算」只会以为坏了。
 */
export async function fetchOrders(f: Filters): Promise<OrdersResponse> {
  const res = await fetch(`/api/orders?${buildQuery(f)}`);
  if (!res.ok) throw new Error('加载失败');
  return (await res.json()) as OrdersResponse;
}

export async function fetchMeta(): Promise<Meta> {
  const res = await fetch('/api/meta');
  if (!res.ok) throw new Error('加载失败');
  return (await res.json()) as Meta;
}

/** 全部换乘方案。走缓存，不触发高德调用 */
export async function fetchCommuteDetail(id: number): Promise<OrderCommuteDetail> {
  const res = await fetch(`/api/orders/${id}/commute`);
  if (!res.ok) throw new Error('取通勤方案失败');
  return (await res.json()) as OrderCommuteDetail;
}

/**
 * 后端把 400 的原因写在 body.error 里（资质枚举写错、name/address 为空）。
 * 只回一句「请求失败」等于把「哪里错了」丢掉，用户只能瞎试。
 */
async function reason(res: Response, fallback: string): Promise<never> {
  let msg = fallback;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) msg = body.error;
  } catch {
    /* body 不是 JSON 就沿用兜底文案 */
  }
  throw new Error(msg);
}

export async function importText(payload: {
  text: string;
  groupName?: string;
  source?: string;
}): Promise<ImportResult> {
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await reason(res, '导入失败');
  return (await res.json()) as ImportResult;
}

/**
 * 删掉一条单。
 * 【为什么需要】解析规则修好之后，库里按旧规则并出来的脏单不会自己消失 ——
 * 它带着错的地址和缝在一起的要求，还占着「可接」的位置。删掉再重粘一次才是干净的。
 */
export async function deleteOrder(id: number): Promise<void> {
  const res = await fetch(`/api/orders/${id}`, { method: 'DELETE' });
  if (!res.ok) await reason(res, '删除失败');
}

export async function patchOrder(id: number, patch: Partial<Pick<Order, 'status' | 'starred'>>): Promise<Order> {
  const res = await fetch(`/api/orders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('更新失败');
  return (await res.json()) as Order;
}

/* ------------------------------------------------------------------ *
 * 设置抽屉用到的接口（阶段 7）
 * ------------------------------------------------------------------ */

/** 读资质。注意 error 非空时 profile 是全空兜底值 —— 界面必须把错误说出来，别让用户以为资质被清空了 */
export async function fetchProfile(): Promise<ProfileResponse> {
  const res = await fetch('/api/profile');
  if (!res.ok) await reason(res, '读取资质失败');
  return (await res.json()) as ProfileResponse;
}

export async function saveProfile(profile: Profile): Promise<ProfileResponse> {
  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!res.ok) await reason(res, '保存资质失败');
  return (await res.json()) as ProfileResponse;
}

export async function fetchOrigins(): Promise<Origin[]> {
  const res = await fetch('/api/origins');
  if (!res.ok) throw new Error('读取出发点失败');
  const body = (await res.json()) as { items: Origin[] };
  return body.items;
}

export async function createOrigin(input: { name: string; address: string; isDefault?: boolean }): Promise<Origin> {
  const res = await fetch('/api/origins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await reason(res, '添加出发点失败');
  return (await res.json()) as Origin;
}

/** 只传 name / address / isDefault。地址一改，后端就把坐标置 NULL，下次通勤重新定位 */
export async function patchOrigin(
  id: number,
  patch: { name?: string; address?: string; isDefault?: boolean },
): Promise<Origin> {
  const res = await fetch(`/api/origins/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await reason(res, '更新出发点失败');
  return (await res.json()) as Origin;
}

export async function deleteOrigin(id: number): Promise<void> {
  const res = await fetch(`/api/origins/${id}`, { method: 'DELETE' });
  if (!res.ok) await reason(res, '删除出发点失败');
}

export async function fetchCommuteStatus(): Promise<CommuteStatus> {
  const res = await fetch('/api/commute/status');
  if (!res.ok) throw new Error('读取通勤状态失败');
  return (await res.json()) as CommuteStatus;
}

/** 算不出 / 还没轮到的单子清单（按通勤排序时它们在列表里看不到） */
export async function fetchCommuteIssues(): Promise<CommuteIssues> {
  const res = await fetch('/api/commute/issues');
  if (!res.ok) throw new Error('读取通勤问题清单失败');
  return (await res.json()) as CommuteIssues;
}


