/**
 * 落库回归：导入、增量补全、体检数据。
 *
 * 用临时目录当 JIAJIAO_DATA，绝不碰真实家教库。
 * 因为 db.ts 在模块顶层就把库打开了，所以必须先设 env 再动态 import。
 *
 * 运行：npm -w server run test
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const dir = mkdtempSync(join(tmpdir(), 'jiajiao-db-'));
process.env.JIAJIAO_DATA = dir;
const db = await import('./db.ts');

const sample = (name: string) => readFileSync(new URL(`./parser/samples/${name}.txt`, import.meta.url), 'utf8');

const T6_FIRST = `家教编号: 2026101803
学员地址: 广州番禺桥南
辅导科目: 剑桥think1教材
学员情况: 四年级、生，一对一老师上门
时间安排: 每周1次；每次2小时 周末
教员要求: 男女不限，英语专业，有剑桥辅导经验，有耐心，有责任心。
老师薪水: 130元/h`;

const T6_FIRST_PARTIAL = `家教编号: 2026101803
学员地址: 广州番禺桥南`;

try {
  /* ---------------------------------------------------------------- *
   * 一、导入：发送时间、分档薪水、体检数据
   * ---------------------------------------------------------------- */
  console.log('\n[1] 导入 T5（住家教073）');
  {
    const res = db.importMessage({ text: sample('t5') });
    check('切出 4 单', [res.orders, res.inserted], [4, 4]);
    check('锚点统计', res.diagnostics.anchors, [{ kind: 'hashId', count: 4 }]);
    check('第 1 单的发送时间', res.diagnostics.orders[0]?.sentAt, '2026-11-05T14:58:00');
    check('第 1 单没缺字段（#1138 是完整单）', res.diagnostics.orders[0]?.missingFields, []);
    check(
      '第 4 单标出缺「要求」',
      res.diagnostics.orders[3]?.missingFields.includes('要求'),
      true,
    );
    check('非单消息标记', res.diagnostics.nonOrder, false);

    const rows = db.listOrders({ q: '1138' });
    check('落库后的发送时间', rows[0]?.sentAt, '2026-11-05T14:58:00');
    check('落库后的分档薪水（150-180/h）', rows[0]?.salaryTiers, [
      { label: null, min: 150, max: 180, unit: 'hour' },
    ]);
    check('列表按发送时间排（newest）', db.listOrders({ sort: 'newest' })[0]?.orderNo, '1138');
  }

  console.log('\n[2] 非单消息不该污染库');
  {
    const before = db.listOrders({}).length;
    const res = db.importMessage({ text: '今天没有新单，大家休息一下吧' });
    check('识别为非单消息', [res.orders, res.nonOrderText], [0, true]);
    check('库里没多出单子', db.listOrders({}).length, before);
  }

  /* ---------------------------------------------------------------- *
   * 二、增量补全：分多次复制同一单
   * ---------------------------------------------------------------- */
  console.log('\n[3] 增量补全（先复制到一半，再补全）');
  {
    const first = db.importMessage({ text: T6_FIRST_PARTIAL });
    check('第一次：新增 1 单', [first.orders, first.inserted, first.duplicated], [1, 1, 0]);
    const id = db.listOrders({ q: '2026101803' })[0]!.id;
    db.updateOrder(id, { status: 'contacted', starred: true, remark: '已加微信' });

    const second = db.importMessage({ text: T6_FIRST });
    check('第二次：走补全而不是新增', [second.inserted, second.duplicated], [0, 1]);

    const rows = db.listOrders({ q: '2026101803' });
    check('仍然只有 1 行', rows.length, 1);
    const row = rows[0]!;
    check('补上了薪水', row.salaryMin, 130);
    check('补上了科目', row.subjects, ['英语']);
    check('补上了要求', row.teacherReq?.includes('男女不限'), true);
    check('置信度升到 high', row.confidence, 'high');
    check('出现次数累加', row.occurrences, 2);
    check('用户手改的 status 没被动', row.status, 'contacted');
    check('用户手改的 starred 没被动', row.starred, true);
    check('用户手改的 remark 没被动', row.remark, '已加微信');
  }

  console.log('\n[4] 补全不许用空值覆盖实值');
  {
    const before = db.listOrders({ q: '2026101803' })[0]!;
    db.importMessage({ text: T6_FIRST_PARTIAL }); // 又复制了一次残缺片段
    const after = db.listOrders({ q: '2026101803' })[0]!;
    check('薪水没被清空', after.salaryMin, 130);
    check('地址没变', after.address, '广州番禺桥南');
    check('科目没被 [] 覆盖', after.subjects, ['英语']);
    check('置信度没被降级', after.confidence, 'high');
    check('出现次数继续累加', [before.occurrences, after.occurrences], [2, 3]);
  }

  console.log('\n[5] 同一段原文重复导入（content_hash 拦掉）');
  {
    const before = db.listOrders({ q: '2026101803' })[0]!;
    const res = db.importMessage({ text: T6_FIRST });
    check('不新增', res.inserted, 0);
    check('识别为重复', res.duplicated, 1);
    const after = db.listOrders({ q: '2026101803' })[0]!;
    check('原文没重复入库', db.listOrders({ q: '2026101803' }).length, 1);
    check('次数累加', after.occurrences, before.occurrences + 1);
  }
  /* ---------------------------------------------------------------- *
   * 六、同号不同单：撞号不能并成一张
   * ---------------------------------------------------------------- */
  console.log('\n[6] 同号不同单');
  {
    const PHYS = `广州线下: ZX2208#新单
学员地址: 南沙东涌地铁站
辅导科目: DSE物理
老师要求: 物理专业本科生`;
    const MATH = `广州线下: ZX2208#新单
学员地址: 海珠昌岗
辅导科目: 奥数启蒙`;

    const a = db.importMessage({ text: MATH });
    const b = db.importMessage({ text: PHYS });
    check('同编号不同单各建一行', [a.inserted, b.inserted], [1, 1]);

    const rows = db.listOrders({}).filter((r) => r.orderNo === 'ZX2208');
    check('两行都在', rows.length, 2);
    check('科目没有被并掉', rows.map((r) => r.subjects.join('/')).sort(), ['数学', '物理']);
    check('地址各归各的', rows.map((r) => r.address).sort(), ['南沙东涌地铁站', '海珠昌岗'].sort());

    const again = db.importMessage({ text: PHYS });
    check('同一张单子再转发仍然合并', [again.inserted, again.duplicated], [0, 1]);
    check('不会越滚越多', db.listOrders({}).filter((r) => r.orderNo === 'ZX2208').length, 2);
  }
} finally {
  // Windows 上 SQLite 连接还开着，临时目录删不掉是可以接受的，别让清理影响结论
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(failed === 0 ? `\n全部通过 ✓（${passed} 项）\n` : `\n${failed} 项未通过 ✗（通过 ${passed} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
