/**
 * 通勤层回归：缓存键、出发时刻、队列时序、配额保护、编排落库。
 *
 * 【为什么全程用假 provider】高德是真金白银的配额（免费档每天就那么点），
 * 回归一次跑几十条单子，一天额度当场见底；而且网络抖动会让测试红绿无常。
 * 真 key 只留给手动冒烟（见 CONTEXT 8.4）。
 *
 * 运行：npm -w server run test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommuteError, QuotaExceededError } from './types.ts';
import type { CommuteOption, CommuteProvider, GeoPoint } from './types.ts';

let failed = 0;
let passed = 0;

function check(name: string, actual: unknown, expect: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expect)}\n      实际: ${JSON.stringify(actual)}`);
}

const dir = mkdtempSync(join(tmpdir(), 'jiajiao-commute-'));
process.env.JIAJIAO_DATA = dir;

const db = await import('./../db.ts');
const cache = await import('./cache.ts');
const { CommuteQueue } = await import('./queue.ts');
const { createCommuteService, parseDailyLimit, DEFAULT_DAILY_LIMIT } = await import('./service.ts');

/* ------------------------------------------------------------------ *
 * 假 provider：把地址映射成固定坐标，方案写死两条（快但换乘多 / 慢但只换一次）
 * ------------------------------------------------------------------ */
class FakeProvider implements CommuteProvider {
  readonly name: string;
  geoCalls: string[] = [];
  transitCalls = 0;
  /** 每个地址固定坐标：同一个地址第二次必须命中缓存，不该再来问 */
  private points: Record<string, GeoPoint> = {
    暨南大学: { lng: 113.343, lat: 23.128 },
    广州番禺桥南: { lng: 113.313, lat: 22.937 },
    海珠昌岗: { lng: 113.276, lat: 23.089 },
    广州市天河区天河东站附近: { lng: 113.334, lat: 23.144 },
    广州市白云区丽城路49号: { lng: 113.256, lat: 23.163 },
    广州市增城区新塘凤凰城云顶: { lng: 113.612, lat: 23.126 },
    广州竹料地铁站: { lng: 113.377, lat: 23.312 },
  };

  constructor(name = 'fake') {
    this.name = name;
  }

  async geocode(address: string) {
    this.geoCalls.push(address);
    const p = this.points[address];
    if (!p) throw new CommuteError(`定位不到 ${address}`);
    return { location: p, formatted: address, level: '兴趣点' };
  }

  async planTransit(_origin: GeoPoint, _dest: GeoPoint, departAt: Date): Promise<CommuteOption[]> {
    this.transitCalls++;
    const stamp = cache.localStamp(departAt);
    return [
      { mode: 'transit', minutes: 35, distance: 11200, walking: 900, fare: 7, transfers: 2, lines: ['地铁3号线', '地铁2号线', '番81路'], departAt: stamp },
      { mode: 'transit', minutes: 41, distance: 10400, walking: 420, fare: 5, transfers: 1, lines: ['地铁3号线', '番81路'], departAt: stamp },
    ];
  }
}

const NOW = new Date(2026, 10, 6, 15, 0, 0); // 2026-11-06 周五 15:00（本地时区）
const noSleep = async () => {};

try {
  /* ---------------------------------------------------------------- *
   * 一、纯函数：出发时刻锚点 + 缓存键
   * ---------------------------------------------------------------- */
  console.log('\n[1] 出发时刻锚点与缓存键');
  {
    check(
      '周五下午 → 下周一 08:00（周末不算工作日）',
      cache.localStamp(cache.nextWorkdayDepartAt(NOW)),
      '2026-11-09T08:00',
    );
    check(
      '周五早上 7 点 → 当天 08:00',
      cache.localStamp(cache.nextWorkdayDepartAt(new Date(2026, 10, 6, 7, 0, 0))),
      '2026-11-06T08:00',
    );
    check(
      '周六 → 下周一 08:00',
      cache.localStamp(cache.nextWorkdayDepartAt(new Date(2026, 10, 7, 10, 0, 0))),
      '2026-11-09T08:00',
    );
    check(
      '刚过 08:00 也算「下一个」（避免和正在算的桶撞车）',
      cache.localStamp(cache.nextWorkdayDepartAt(new Date(2026, 10, 6, 8, 0, 0))),
      '2026-11-09T08:00',
    );

    check('坐标取 4 位小数', cache.coordKey({ lng: 113.123456, lat: 23.654321 }), '113.1235,23.6543');
    const departAt = cache.nextWorkdayDepartAt(NOW);
    check(
      '同一地址两次解析出的微小偏差命中同一条缓存',
      cache.planCacheKey('transit', { lng: 113.12342, lat: 23.65431 }, { lng: 113.30011, lat: 23.00011 }, departAt) ===
        cache.planCacheKey('transit', { lng: 113.12344, lat: 23.65432 }, { lng: 113.30012, lat: 23.00012 }, departAt),
      true,
    );
    check(
      '键里不含用户，只含坐标与出发桶',
      cache.planCacheKey('transit', { lng: 113.1234, lat: 23.6543 }, { lng: 113.3, lat: 23.0 }, departAt),
      'transit|113.1234,23.6543|113.3,23|2026-11-09T08:00',
    );
    check('地址归一化只去噪声、不改内容', cache.normalizeAddress('广州 番禺（桥南），'), '广州番禺(桥南)');
    check('不同区不合并（绝不猜行政区）', cache.normalizeAddress('番禺桥南') !== cache.normalizeAddress('广州番禺桥南'), true);

    // 配额上限可以从 .env 调，但写错不许把闸门放开
    check('AMAP_DAILY_LIMIT 正常生效', parseDailyLimit('1500'), 1500);
    check('小数取整', parseDailyLimit('12.7'), 12);
    check('不填用默认', [parseDailyLimit(undefined), DEFAULT_DAILY_LIMIT], [300, 300]);
    check('写错（abc / 负数 / 空串）一律退回默认', [parseDailyLimit('abc'), parseDailyLimit('-5'), parseDailyLimit(' ')], [300, 300, 300]);
  }

  /* ---------------------------------------------------------------- *
   * 二、队列：串行、去重、重试、配额
   * ---------------------------------------------------------------- */
  console.log('\n[2] 串行队列时序');
  {
    let concurrency = 0;
    let maxConcurrency = 0;
    const order: number[] = [];
    const sleeps: number[] = [];
    const q = new CommuteQueue({
      handler: async (id) => {
        concurrency++;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        order.push(id);
        await Promise.resolve();
        concurrency--;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const added = q.enqueue([1, 2, 3]);
    q.enqueue([2, 3]); // 已在队列里的不重复加
    await q.drain();
    check('入队去重', added, 3);
    check('严格串行（最大并发 1）', maxConcurrency, 1);
    check('按入队顺序执行', order, [1, 2, 3]);
    check('单子之间留 400ms 间隔（个人 Key 3 次/秒，留余量）', sleeps, [400, 400]);
    check('跑空后不再 busy', [q.isBusy(), q.size()], [false, 0]);
  }

  console.log('\n[3] 失败重试 1 次，仍失败才落到 onFailure');
  {
    let attempts = 0;
    const failures: { id: number; msg: string }[] = [];
    const q = new CommuteQueue({
      handler: async (id) => {
        attempts++;
        if (id === 9) throw new CommuteError('网络抖了一下');
        if (id === 10) throw new CommuteError('地址定位不到');
      },
      sleep: noSleep,
      onFailure: (id, err) => failures.push({ id, msg: err.message }),
    });
    q.enqueue([9, 10]);
    await q.drain();
    check('每单最多跑 2 次（1 次 + 重试 1 次）', attempts, 4);
    check('失败通知带原因', failures, [
      { id: 9, msg: '网络抖了一下' },
      { id: 10, msg: '地址定位不到' },
    ]);
  }

  console.log('\n[4] 配额撞墙：立刻停手，不继续撞');
  {
    let ran = 0;
    let halted = 0;
    const q = new CommuteQueue({
      handler: async () => {
        ran++;
        throw new QuotaExceededError('今日高德调用已达上限 3 次，明天再算');
      },
      sleep: noSleep,
      onQuotaExhausted: () => halted++,
    });
    q.enqueue([1, 2, 3, 4]);
    await q.drain();
    check('配额用尽只跑 1 单就停（不重试、不继续）', ran, 1);
    check('丢掉剩余待办', q.size(), 0);
    check('标记 quotaExhausted 并回调一次', [q.quotaExhausted(), halted], [true, 1]);
  }

  /* ---------------------------------------------------------------- *
   * 三、编排：假 provider 端到端
   * ---------------------------------------------------------------- */
  console.log('\n[5] 单条单子的完整计算 + 落库');
  const provider = new FakeProvider();
  const service = createCommuteService({ provider, now: () => NOW, sleep: noSleep });
  {
    db.importMessage({
      text: `家教编号: 2026101803
学员地址: 广州番禺桥南
辅导科目: 英语
时间安排: 每周1次，每次2小时
教员要求: 男女不限
老师薪水: 130元/h`,
      sentAt: '2026-11-05T09:00:00',
    });

    // 还没有出发点：不许拿学校名之类的信息去猜一个起点（猜错会让整列通勤静默偏掉）
    check('没有出发点时的状态是 no_origin', service.status().blockedBy, 'no_origin');
    check('也不入队', service.enqueueMissing(db.listOrders({})), { candidates: 0, queued: 0 });

    const origin = db.addOrigin({ name: '学校', address: '暨南大学', isDefault: true });
    check('出发点落库且为默认', [origin.name, origin.isDefault, origin.lng], ['学校', true, null]);

    const before = db.listOrders({ q: '2026101803' })[0]!;
    check('导入后通勤是「还没算」而不是「算不出来」', [before.commuteStatus, before.commuteMinutes], [null, null]);

    const res = service.enqueueMissing(db.listOrders({}));
    check('缺数据的单子进了队列', res, { candidates: 1, queued: 1 });
    await service.queue.drain();

    const row = db.listOrders({ q: '2026101803' })[0]!;
    check('状态 ok', row.commuteStatus, 'ok');
    check('标量列取最快一套（35 分钟）', row.commuteMinutes, 35);
    check('距离/换乘/票价一起落库', [row.commuteDistance, row.commuteTransfers, row.commuteFare], [11200, 2, 7]);
    check('记下用的是哪个出发点', row.commuteOriginId, origin.id);
    check('记下算的时候用的地址（供地址变更后判定作废）', row.commuteAddress, '广州番禺桥南');
    check('缓存键落库（详情面板据此取全部方案）', typeof row.commuteCacheKey === 'string', true);

    const view = service.optionsFor(row.id)!;
    check('多套方案都能取回（决策 6）', view.options.length, 2);
    check('方案按耗时升序', view.options.map((o) => o.minutes), [35, 41]);
    check('出发时刻是下一个工作日 08:00', view.departAt, '2026-11-09T08:00');

    check('地理编码：起点 1 次 + 地址 1 次', provider.geoCalls.length, 2);
    check('公交规划只调 1 次', provider.transitCalls, 1);

    service.enqueueMissing(db.listOrders({}));
    await service.queue.drain();
    check('已算完的单子不再入队', service.queue.size(), 0);
    check('也不会重复调高德', provider.transitCalls, 1);
  }

  console.log('\n[6] 同一地址被多单共用：只解析一次、只规划一次');
  {
    db.importMessage({
      text: `家教编号: 2026110599
学员地址: 广州番禺桥南
辅导科目: 数学
时间安排: 每周2次，每次2小时
教员要求: 女老师
老师薪水: 150元/h`,
      sentAt: '2026-11-05T10:00:00',
    });
    const countBefore = provider.geoCalls.filter((a) => a === '广州番禺桥南').length;
    const transitBefore = provider.transitCalls;
    const orders = db.listOrders({ q: '2026110599' });
    service.enqueueMissing(orders);
    await service.queue.drain();
    check('地址级 geo 缓存：不再问高德', provider.geoCalls.filter((a) => a === '广州番禺桥南').length, countBefore);
    check('同起点同终点同出发桶 → 命中通勤缓存', provider.transitCalls, transitBefore);
    check('第二条单子拿到了同样的通勤结果', db.listOrders({ q: '2026110599' })[0]!.commuteMinutes, 35);
  }

  console.log('\n[7] 地址定位不到：记 failed + 原因，不留白转圈');
  {
    db.importMessage({
      text: `家教编号: 2026110601
学员地址: 广州某某不存在的地方
辅导科目: 物理
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 100元/h`,
      sentAt: '2026-11-05T11:00:00',
    });
    const before = db.listOrders({ q: '2026110601' })[0]!;
    const geoBefore = provider.geoCalls.length;
    service.enqueueMissing([before]);
    await service.queue.drain();
    const row = db.listOrders({ q: '2026110601' })[0]!;
    check('状态 failed', row.commuteStatus, 'failed');
    check('原因为空话不留（写了高德的原话）', row.commuteError?.includes('定位不到'), true);
    check('没有分钟数（绝不编一个）', row.commuteMinutes, null);
    // 队列确实重试了一次，但地址级缓存里已经记着「定位不到」，第二次不再打高德 ——
    // 失败缓存的意义就在这里：一次失败不该变成两次配额
    check('重试时被地址缓存挡住，只问了 1 次高德', provider.geoCalls.length - geoBefore, 1);

    // 失败也进缓存：再请求一次不该继续扣配额，更不该被重新排队（否则刷一次页面就空转一圈）
    const geoAfter = provider.geoCalls.length;
    check('6 小时内不再入队', service.enqueueMissing([db.listOrders({ q: '2026110601' })[0]!]).queued, 0);
    await service.queue.drain();
    check('也不再问高德', provider.geoCalls.length, geoAfter);
  }

  /* ---------------------------------------------------------------- *
   * 四、排序红线：未算完的单子不得混进通勤排序
   * ---------------------------------------------------------------- */
  console.log('\n[8] 通勤排序只含已算完的单子');
  {
    db.importMessage({
      text: `家教编号: 2026110602
学员地址: 海珠昌岗
辅导科目: 化学
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 120元/h`,
      sentAt: '2026-11-05T12:00:00',
    });
    const pending = db.listOrders({ q: '2026110602' })[0]!;
    check('这单还没算', pending.commuteStatus, null);

    const sorted = db.listOrders({ sort: 'commute' });
    check('未算完的单子不在通勤排序里', sorted.some((o) => o.id === pending.id), false);
    check('已算完的两单在', sorted.map((o) => o.orderNo).sort(), ['2026101803', '2026110599']);
    check('按分钟升序', sorted.map((o) => o.commuteMinutes), [35, 35]);

    const limited = db.listOrders({ maxCommuteMinutes: 20 });
    check('通勤上限筛选同样排除未算完的', limited.length, 0);

    check('ready 计数', db.countCommuteReady(), 2);
    check('pending 计数（含算失败的）', db.countCommutePending() >= 2, true);
  }

  /* ---------------------------------------------------------------- *
   * 五、无 key / 配额上限
   * ---------------------------------------------------------------- */
  console.log('\n[9] 没有高德 key：整站照常，只是通勤不工作');
  {
    const offline = createCommuteService({ provider: null, now: () => NOW, sleep: noSleep });
    const status = offline.status();
    check('configured=false', status.provider.configured, false);
    check('给出可操作的原因', status.provider.reason?.includes('AMAP_KEY'), true);
    check('状态里直接点名是被 key 卡住的', status.blockedBy, 'no_key');
    const res = offline.enqueueMissing(db.listOrders({}));
    check('不入队', res, { candidates: 0, queued: 0 });
    const row = db.listOrders({ q: '2026110602' })[0]!;
    check('引擎不该给单子落任何假结论', row.commuteStatus, null);
  }

  console.log('\n[10] 日配额上限：算到上限就停，状态能看出来');
  {
    const quota = cache.createDailyQuota(2, 'test-quota', () => NOW);
    const p2 = new FakeProvider('fake-quota');
    const limitedService = createCommuteService({ provider: p2, quota, now: () => NOW, sleep: noSleep });
    db.importMessage({
      text: `家教编号: 2026110603
学员地址: 广州市天河区天河东站附近
辅导科目: 英语
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 110元/h`,
      sentAt: '2026-11-05T13:00:00',
    });
    db.importMessage({
      text: `家教编号: 2026110604
学员地址: 广州竹料地铁站
辅导科目: 数学
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 100元/h`,
      sentAt: '2026-11-05T14:00:00',
    });
    const targets = db.listOrders({}).filter((o) => ['2026110603', '2026110604'].includes(o.orderNo ?? ''));
    limitedService.enqueueMissing(targets);
    await limitedService.queue.drain();

    const st = limitedService.status();
    check('配额用满（2 次：起点 geo + 一次规划）', st.quota.used, 2);
    check('剩余 0', st.quota.remaining, 0);
    check('标记为耗尽', st.quota.exhausted, true);
    check('状态里点名是被配额卡住的', st.blockedBy, 'quota');
    check('只算完第一单，第二单不许编结果', db.listOrders({ q: '2026110603' })[0]!.commuteStatus, 'ok');
    check('第二单仍是「还没算」', db.listOrders({ q: '2026110604' })[0]!.commuteStatus, null);
  }

  console.log('\n[11] 换出发点 → 旧结论作废，重新入队（多半命中缓存）');
  {
    const second = db.addOrigin({ name: '家', address: '广州竹料地铁站', isDefault: true });
    check('新出发点成为默认', db.getDefaultOrigin()?.id, second.id);
    const res = service.enqueueMissing(db.listOrders({}));
    check('已算过的单子全部因出发点变化重新入队', res.candidates >= 2, true);
    await service.queue.drain();
    const row = db.listOrders({ q: '2026101803' })[0]!;
    check('重新算完，记的是新出发点', row.commuteOriginId, second.id);
    check('仍按最快的来', row.commuteMinutes, 35);
  }

  /* ---------------------------------------------------------------- *
   * 六、回归：入队源不能用「已过滤的当前页」
   * ---------------------------------------------------------------- */
  console.log('\n[12] 按通勤排序时，待算单也必须被捞进来（曾经的队列断粮）');
  {
    const fresh = [
      { no: '2026110610', addr: '海珠昌岗' },
      { no: '2026110611', addr: '广州番禺桥南' },
      { no: '2026110612', addr: '广州竹料地铁站' },
    ];
    for (const f of fresh) {
      db.importMessage({
        text: `家教编号: ${f.no}
学员地址: ${f.addr}
辅导科目: 英语
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 120元/h`,
        sentAt: '2026-11-05T15:00:00',
      });
    }
    const ids = fresh.map((f) => db.listOrders({ q: f.no })[0]!.id);

    // 前提：红线仍然成立 —— 通勤排序里看不到它们。这正是「拿当前页去入队」会拿到 0 个候选的原因
    const sortedBefore = db.listOrders({ sort: 'commute' });
    check('未算完的单子仍不在通勤排序里（红线没被放松）', sortedBefore.some((o) => ids.includes(o.id)), false);

    // 修复点：从「待算集合」入队，与当前页无关
    const res = service.enqueuePending(30);
    check('待算集合里能捞到它们（至少 3 条）', res.candidates >= 3, true);
    await service.queue.drain();

    const after = fresh.map((f) => db.listOrders({ q: f.no })[0]!);
    check(
      '三单都算完了',
      after.map((o) => o.commuteStatus),
      ['ok', 'ok', 'ok'],
    );
    check('算完后它们才出现在通勤排序里', db.listOrders({ sort: 'commute' }).some((o) => ids.includes(o.id)), true);

    // 冷却中的失败单不算候选，否则每刷新一次就把它捞回来空转一圈
    check('冷却期内的失败单不再入队', service.enqueuePending(30), { candidates: 0, queued: 0 });
  }

  console.log('\n[13] 线上单：不算通勤、不占配额、不计入「还没算」');
  {
    const pendingBefore = db.countCommutePending();
    db.importMessage({
      text: `家教编号: 2026110617
学员地址: 线上
辅导科目: 英语
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 160元/h`,
      sentAt: '2026-11-05T16:00:00',
    });
    const row = db.listOrders({ q: '2026110617' })[0]!;
    check('地址被剥成授课形式', [row.address, row.mode], [null, '线上']);

    const geoBefore = provider.geoCalls.length;
    const transitBefore = provider.transitCalls;
    check('线上单不进队列', service.enqueuePending(30), { candidates: 0, queued: 0 });
    await service.queue.drain();
    check('一次高德都不问', [provider.geoCalls.length, provider.transitCalls], [geoBefore, transitBefore]);
    check('通勤保持 null（既没算，也没算失败）', row.commuteStatus, null);
    check('不把「还有 N 单没算出通勤」一直挂着', db.countCommutePending(), pendingBefore);

    // 清单：这些单子在按通勤排序的列表里看不到，只能靠它
    const issues = db.listCommuteIssues();
    check('清单里没有线上单（它不需要通勤，别当问题单）', issues.some((i) => i.orderNo === '2026110617'), false);
    check('算不出的单在清单里', issues.filter((i) => i.status === 'failed').map((i) => i.orderNo), ['2026110601']);
    check('清单带原因，界面才能说清为什么', issues[0]?.error?.includes('定位不到'), true);
  }
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上连接还开着时删不掉，忽略 */
  }
}

console.log(failed === 0 ? `\n全部通过 ✓（${passed} 项）\n` : `\n${failed} 项未通过 ✗（通过 ${passed} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
