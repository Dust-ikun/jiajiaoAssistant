/**
 * HTTP 层回归：设置抽屉与导入体检面板真正依赖的那几个接口。
 *
 * 【为什么要有这一层】解析 / 判定 / 落库各有自己的回归，但它们保不住「接口把参数传错了」——
 * 例如 `POST /api/origins` 曾经写成 `Boolean(isDefault)`：客户端不带这个字段时变成 false，
 * 「第一条出发点自动成为默认」这条规则就悄悄失效了，库里有出发点却一个默认都没有，
 * 而界面只是少一个灰色小标签，谁都不会去查。这类 bug 只有打到 HTTP 上才看得见。
 *
 * 起服务用 `provider: null` 的通勤服务：没有 key 就不会发任何请求，绝不消耗真实高德配额。
 *
 * 运行：npm -w server run test
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

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

const dir = mkdtempSync(join(tmpdir(), 'jiajiao-api-'));
process.env.JIAJIAO_DATA = dir;

// db.ts 在模块顶层打开库，必须先设 env 再动态 import
const { createApp } = await import('./api.ts');
const { createCommuteService } = await import('./commute/service.ts');

const app = createApp(createCommuteService({ provider: null }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) });

try {
  /* ---------------------------------------------------------------- *
   * 一、出发点：第一条自动默认、改地址清坐标、删默认后有人顶上
   * ---------------------------------------------------------------- */
  console.log('\n[1] 出发点增删改');
  {
    const a = await post('/api/origins', { name: '家', address: '广州市天河区暨南大学石牌校区' });
    check('第一条创建成功', a.status, 200);
    check('第一条自动成为默认（回归：Boolean(undefined) 曾把它变成 false）', a.body.isDefault, true);

    const b = await post('/api/origins', { name: '宿舍', address: '广州市天河区石牌东路' });
    check('第二条默认 false', b.body.isDefault, false);

    const switched = await patch(`/api/origins/${b.body.id}`, { isDefault: true });
    check('设为默认成功', switched.body.isDefault, true);
    const list1 = await api('/api/origins');
    check(
      '默认只有一个',
      list1.body.items.filter((o: any) => o.isDefault).map((o: any) => o.name),
      ['宿舍'],
    );

    const moved = await patch(`/api/origins/${a.body.id}`, { address: '广州市海珠区昌岗' });
    check('改地址后坐标作废（lng/lat 同时清空）', [moved.body.lng, moved.body.lat], [null, null]);

    const empty = await post('/api/origins', { name: '  ', address: '' });
    check('空名称/地址拒绝', empty.status, 400);

    await api(`/api/origins/${b.body.id}`, { method: 'DELETE' });
    const list2 = await api('/api/origins');
    check('删掉默认出发点后剩下的顶上', list2.body.items.map((o: any) => [o.name, o.isDefault]), [['家', true]]);
  }

  /* ---------------------------------------------------------------- *
   * 二、资质：坏值必须 400、好值必须落盘且能读回
   * ---------------------------------------------------------------- */
  console.log('\n[2] 资质读写');
  {
    const init = await api('/api/profile');
    check('没文件时给空资质而不是崩', [init.status, init.body.profile.gender, init.body.error], [200, null, null]);
    check('path 指向临时数据目录', init.body.path.startsWith(dir), true);

    const bad = await put('/api/profile', { gender: '男生' });
    check('枚举写错直接 400', bad.status, 400);
    check('400 里说清允许值', String(bad.body.error).includes('只能是'), true);

    const good = await put('/api/profile', {
      ...init.body.profile,
      gender: '男',
      school: '暨南大学',
      schoolTier: '211',
      degree: '本科',
      teacherType: '大学生',
      majors: ['光电信息科学与工程'],
      majorCategory: '理科',
      certificates: ['英语六级'],
      languages: ['英语'],
      hasExperience: false,
    });
    check('合法资质保存成功', good.status, 200);
    check('落盘文件存在', existsSync(join(dir, 'profile.json')), true);

    const back = await api('/api/profile');
    check('读回的是刚存的值', [back.body.profile.gender, back.body.profile.schoolTier, back.body.profile.hasExperience], [
      '男',
      '211',
      false,
    ]);
  }

  /* ---------------------------------------------------------------- *
   * 三、导入体检：面板上的每个格子都有数据
   * ---------------------------------------------------------------- */
  console.log('\n[3] 导入体检数据');
  {
    const t5 = await post('/api/import', {
      text: [
        '上门家教073（朝九晚六周日休息）    2026年11月5日 14:58',
        '#1138',
        '【地址】广州市天河区天河东站附近',
        '【年级】高一 双胞胎',
        '【科目】数学',
        '【时间】一周1次 周日上午 一次2h',
        '【薪资】150-180/h',
        '【要求】有经验女大学生 DSE课程 一对二',
        '',
        '#1045',
        '【地址】广州市番禺区钟村街道诜敦村生态园',
        '【年级】初一',
        '【科目】猎德英语',
        '【薪资】110-140/h',
      ].join('\n'),
      groupName: '住家教073',
    });
    const d = t5.body.diagnostics;
    check('切出 2 单', [t5.body.orders, t5.body.inserted], [2, 2]);
    check('锚点统计', d.anchors, [{ kind: 'hashId', count: 2 }]);
    check('第 1 单不缺字段', d.orders[0].missingFields, []);
    check('第 2 单标出缺「要求」', d.orders[1].missingFields.includes('要求'), true);
    check('第 1 单的发送时间取自文本头', d.orders[0].sentAt, '2026-11-05T14:58:00');
    check('置信度字段存在', typeof d.orders[0].confidence, 'string');

    const noise = await post('/api/import', { text: '这些单是我们合作的跑行的单，大家可以放心接' });
    check('公告文本不算单子', [noise.body.nonOrderText, noise.body.diagnostics.nonOrder], [true, true]);
    check('没识别出单子时不写库', noise.body.inserted, 0);

    const empty = await post('/api/import', { text: '   ' });
    check('空文本 400', empty.status, 400);
  }

  /* ---------------------------------------------------------------- *
   * 四、列表与通勤状态：界面状态条的三种原因必须能区分
   * ---------------------------------------------------------------- */
  console.log('\n[4] 列表与通勤状态');
  {
    const orders = await api('/api/orders?sort=commute');
    check('一单都没算通勤时降级按时薪排', [orders.body.sort, orders.body.sortFallback], ['hourly', true]);
    check('通勤状态随列表一起返回', orders.body.commute.blockedBy, 'no_key');
    check('列表里带判定结果', typeof orders.body.items[0].match.verdict, 'string');

    const status = await api('/api/commute/status');
    check('没有 key 时 blockedBy = no_key', status.body.blockedBy, 'no_key');
    check('配额度对象齐全', Object.keys(status.body.quota).sort(), ['exhausted', 'limit', 'remaining', 'used']);
  }
} finally {
  server.close();
  // Windows 上 SQLite 连接还开着，删不掉是可以接受的，别让清理影响结论
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(
  failed === 0 ? `\n全部通过 ✅（${passed} 项）\n` : `\n${failed} 项未通过 🗙（通过 ${passed} 项）\n`,
);
process.exit(failed === 0 ? 0 : 1);
