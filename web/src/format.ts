import type { Order, SalaryTier } from './types';

/**
 * 「多久之前」的相对时间。
 *
 * 【为什么单独一个函数】时效是这个工具最看重的维度：好单几小时内被抢，
 * 隔天看到的单基本无效。所以列表上必须时刻显示「几小时前」，而不是埋在详情里。
 *
 * 【时间从哪来】微信复制出来的文本多数不带时间头，所以后端在没解析到时间头时
 * 落的是**导入时间**（2026-11-07 改）。两者都是真实值，不猜；这里只负责显示，
 * 不该再自己编一个「刚刚」。
 */
export function relTime(iso: string | null): string {
  if (!iso) return '时间未知';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '发送时间未知';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

/** 超过 24 小时的单子另给一个颜色：微信群里这种单基本已经被接掉了 */
export function isStale(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && Date.now() - t > 24 * 3600_000;
}

export function minutesText(m: number): string {
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

export function distanceText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${m} 米`;
}

export interface CommuteBadge {
  text: string;
  /** tone 决定配色：ok 正常、warn 需要留意、muted 未算、bad 失败 */
  tone: 'ok' | 'warn' | 'muted' | 'bad';
  title: string;
}

/**
 * 卡片上的通勤摘要。
 *
 * 【为什么「未算」和「算不出来」必须分开】前者是「正在算/还没轮到」，等一会儿会有；
 * 后者是「这个地址高德定位不到」，等多久都不会有。混成一个灰色横杠，用户会一直等。
 */
export function commuteBadge(o: Order): CommuteBadge {
  /**
   * 线上单先判：它既没有地址、也不该有通勤结论。
   * 放在「无地址」之前，是为了不把它显示成「无地址」—— 那是缺数据，而线上单是**本来就不需要**。
   */
  if (o.mode === '线上') {
    return { text: '不用通勤', tone: 'muted', title: '线上授课：不需要地址，也不会占用高德配额' };
  }
  if (o.commuteStatus === 'ok' && o.commuteMinutes !== null) {
    const bits = [minutesText(o.commuteMinutes)];
    if (o.commuteTransfers !== null && o.commuteTransfers > 0) bits.push(`换 ${o.commuteTransfers} 次`);
    if (o.commuteFare !== null) bits.push(`${o.commuteFare} 元`);
    return {
      text: bits.join(' · '),
      tone: o.commuteMinutes <= 45 ? 'ok' : o.commuteMinutes <= 75 ? 'warn' : 'bad',
      title: '最快的一套公交方案（下一个工作日 08:00 出发）',
    };
  }
  if (o.commuteStatus === 'failed') {
    return { text: '通勤算不出', tone: 'bad', title: o.commuteError ?? '这次没算出来' };
  }
  if (!o.address) return { text: '无地址', tone: 'muted', title: '这条单子没解析出地址，无法计算通勤' };
  return { text: '通勤未算', tone: 'muted', title: '还没轮到它，或者还没配置出发点/key' };
}

/** 分档薪水：`一本100 / 92或研究生 110-120` */
export function salaryTierText(tiers: SalaryTier[]): string | null {
  if (!tiers.length) return null;
  return tiers
    .map((t) => {
      const range = t.min === t.max ? `${t.min}` : `${t.min}-${t.max}`;
      return t.label ? `${t.label} ${range}` : `${range}`;
    })
    .join(' / ');
}

export function verdictTone(v: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (v === '可接') return 'ok';
  if (v === '存疑') return 'warn';
  if (v === '不可接') return 'bad';
  return 'muted';
}
