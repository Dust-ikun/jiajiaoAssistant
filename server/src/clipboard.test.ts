/**
 * 剪贴板自动导入回归。
 *
 * 这一层最危险的失败不是「没导进来」，而是「把不该导的东西导进去了」——
 * 复制一个密码、一段代码，结果在库里多出一条莫名其妙的单子，或者更糟：正文进了日志。
 * 所以断言的重点全在**过滤**和**不留正文**上，而不是「能导入」。
 *
 * 用临时目录当 JIAJIAO_DATA，绝不碰真实库；不启动 powershell，也就不会真的读剪贴板。
 *
 * 运行：npm -w server run test
 */
import { mkdtempSync, rmSync } from 'node:fs';
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

function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

const dir = mkdtempSync(join(tmpdir(), 'jiajiao-clip-'));
process.env.JIAJIAO_DATA = dir;

const db = await import('./db.ts');
const clip = await import('./clipboard.ts');

const ORDER = `家教编号: 2026110601
学员地址: 番禺桥南
辅导科目: 英语
时间安排: 每周1次，每次2小时
教员要求: 女老师
老师薪水: 130元/h`;

try {
  /* ---------------------------------------------------------------- *
   * 一、base64 解码：坏行不能把监听搞崩
   * ---------------------------------------------------------------- */
  console.log('\n[1] 剪贴板行解码');
  {
    const b64 = Buffer.from('你好\n世界', 'utf8').toString('base64');
    check('正常行还原', clip.decodeClipboardLine(b64), '你好\n世界');
    check('空行 → null', clip.decodeClipboardLine('   '), null);
    check('坏 base64 → null', clip.decodeClipboardLine('不是base64!!!'), null);
    // 子进程的存活心跳（Get-Clipboard 会卡住，靠它判断死活），不能当成剪贴板内容
    check('心跳行不当作内容', clip.decodeClipboardLine('--beat--'), null);
  }

  /* ---------------------------------------------------------------- *
   * 二、过滤：只有能切出单子的文本才导入
   * ---------------------------------------------------------------- */
  console.log('\n[2] 什么样的剪贴板内容不该导');
  {
    checkTrue('正常单子 → 要导', clip.looksLikeOrderText(ORDER));
    check('群公告 → 不导', clip.looksLikeOrderText('这些单是我们合作的跑行的单，大家可以放心接'), false);
    check('网址 → 不导', clip.looksLikeOrderText('https://www.amap.com/dir?from=xxx'), false);
    check('一个词 → 不导', clip.looksLikeOrderText('好的'), false);
    check('空文本 → 不导', clip.looksLikeOrderText('   '), false);
    check('超长文档 → 不导', clip.looksLikeOrderText('家教编号: 1\n' + 'x'.repeat(50_001)), false);
    check('一段代码 → 不导', clip.looksLikeOrderText('const a = 1;\nconsole.log(a);'), false);
  }

  /* ---------------------------------------------------------------- *
   * 三、导入与去重
   * ---------------------------------------------------------------- */
  console.log('\n[3] 导入、去重、摘要');
  {
    const sink = clip.createCaptureSink({ importText: db.importMessage });

    const first = sink.handle(ORDER);
    check('第一段导入成功', first?.orders, 1);
    check('摘要里有编号', first?.orderNos, ['2026110601']);
    check('库里多了一条单子', db.listOrders({}).length, 1);

    // 轮询每 800ms 就会再看到同一份内容一次
    check('同一段第二次 → 不重复导', sink.handle(ORDER), null);
    check('库里没变多', db.listOrders({}).length, 1);
    check('摘要也只记一条', sink.recent().length, 1);

    check('公告 → 返回 null', sink.handle('大家可以放心接，信息费按我这边的来'), null);
    check('噪声没进库', db.listOrders({}).length, 1);

    // 补全后的原文（内容变了）应当再导一次，并走增量补全
    const completed = `${ORDER}\n【时间】周三晚上7点`;
    const second = sink.handle(completed);
    check('内容变了 → 再导一次', second?.orders, 1);
    check('走增量补全而不是新增一条', [second?.inserted, second?.duplicated], [0, 1]);
    check('库里仍然一条', db.listOrders({}).length, 1);
  }

  /* ---------------------------------------------------------------- *
   * 四、摘要里绝不能出现正文
   * ---------------------------------------------------------------- */
  console.log('\n[4] 摘要不含正文');
  {
    const sink = clip.createCaptureSink({ importText: db.importMessage });
    const rec = sink.handle(`家教编号: 2026110699
学员地址: 天河岗顶
辅导科目: 数学
时间安排: 一周一次
教员要求: 大学生
老师薪水: 150/h`);
    const json = JSON.stringify(rec);
    checkTrue('摘要里没有地址', !json.includes('天河岗顶'));
    checkTrue('摘要里没有薪水原文', !json.includes('150/h'));
    check('摘要字段就是这几个', Object.keys(rec ?? {}).sort(), ['at', 'duplicated', 'inserted', 'orderNos', 'orders']);
  }

  /* ---------------------------------------------------------------- *
   * 五、开关：必须显式打开
   * ---------------------------------------------------------------- */
  console.log('\n[5] 开关解析');
  {
    check('未配置 → 关', clip.parseAutoImportFlag(undefined), false);
    check('空字符串 → 关', clip.parseAutoImportFlag(''), false);
    check('写 0 → 关', clip.parseAutoImportFlag('0'), false);
    check('写 1 → 开', clip.parseAutoImportFlag('1'), true);
    check('写 true → 开', clip.parseAutoImportFlag('true'), true);
  }
} finally {
  // Windows 上 SQLite 连接还开着，临时目录删不掉是可以接受的
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(failed === 0 ? `\n全部通过 ✓（${passed} 项）\n` : `\n${failed} 项未通过 ✗（通过 ${passed} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
