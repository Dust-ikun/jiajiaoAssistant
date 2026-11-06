/**
 * 端到端截图：用真的浏览器把界面点一遍，把四类关键画面存下来。
 *
 * 【为什么必须用临时库】截图里如果混进真实单子，就等于把家长地址、电话写进了图片，
 * 而图片会进聊天记录、进截图工具的历史。所以这里 `JIAJIAO_DATA` 指向系统临时目录，
 * 用完即删；`data/` 里的真实库一个字节都不碰。
 *
 * 【为什么不装 playwright 全套】本机已有 Edge，`playwright-core` + `channel:'msedge'`
 * 直接驱动它，省掉 300MB 的 Chromium 下载（阶段 7 手动用 CDP 截图也是这个思路，这里只是脚本化）。
 *
 * 【为什么还要伪造通勤数据】高德的 key 在测试里绝不能消耗（CODEBUDDY.md 红线）。
 * 队列的真实链路在 `commute.test.ts` 里已经用假 provider 端到端测过；这里要的是**界面长什么样**，
 * 所以直接按 `commute.test.ts` 同款列名写入已算完的结果，一行网络请求都不发。
 *
 *   node desktop/e2e/shots.mjs            # 网页版四类截图
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url)); // desktop/e2e
const root = resolve(here, '../..');
const serverEntry = resolve(root, 'desktop/dist/server.mjs');
const webDist = resolve(root, 'web/dist');
const shotsDir = resolve(here, 'shots');
const samples = resolve(root, 'server/src/parser/samples');

if (!existsSync(serverEntry) || !existsSync(webDist)) {
  console.error('缺产物：先跑 npm run build && npm run build:server');
  process.exit(1);
}
mkdirSync(shotsDir, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'jj-e2e-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(p));
    });
  });
}

// AMAP_KEY 给个假值：只是为了不让界面上顶着一条「通勤未配置」的黄条，
// 队列里没活（下面把每单都写成 ok）就不会有任何真实请求
const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  JIAJIAO_DATA: dataDir,
  JIAJIAO_WEB_DIST: webDist,
  AMAP_KEY: 'e2e-not-a-real-key',
  CLIPBOARD_AUTO_IMPORT: '',
};
delete env.AMAP_DAILY_LIMIT;

const server = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
const onLog = (c) => serverLog.push(c.trimEnd());
server.stdout.on('data', onLog);
server.stderr.on('data', onLog);
server.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error('[e2e] 服务进程退出', code);
});

async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务没起来：\n${serverLog.slice(-15).join('\n')}`);
}

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

/* ------------------------------------------------------------------ *
 * 造数据
 * ------------------------------------------------------------------ */

const GROUP = {
  't1.txt': '广州家教群YF11群',
  't2.txt': '广州家教群YF11群',
  't3.txt': '某家教群1',
  't4.txt': '广州众行家教群93',
  't6.txt': '番禺家教群',
};

async function seed() {
  for (const [file, groupName] of Object.entries(GROUP)) {
    const text = readFileSync(join(samples, file), 'utf8');
    await post('/api/import', { text, groupName, source: 'e2e' });
  }

  // 出发点：走真实接口（顺便验证它），坐标用 SQL 补 —— 接口故意不接坐标，避免壳/前端伪造定位
  const origin = await post('/api/origins', { name: '暨大石牌', address: '广州市天河区暨南大学石牌校区' });

  const db = new DatabaseSync(join(dataDir, 'jiajiao.db'));
  db.prepare('UPDATE origins SET lng = ?, lat = ? WHERE id = ?').run(113.34, 23.13, origin.id);

  // 通勤结果：数值按下标铺开，让三种颜色都出现（≤45 绿 / ≤75 琥珀 / 更久红）
  const minutes = [18, 24, 29, 33, 38, 44, 51, 57, 63, 72, 81, 95];
  const rows = db.prepare('SELECT id, address FROM orders ORDER BY id').all();
  const upd = db.prepare(
    `UPDATE orders SET commute_status = 'ok', commute_minutes = ?, commute_distance = ?,
       commute_transfers = ?, commute_fare = ?, commute_origin_id = ?, commute_address = ?,
       commute_cache_key = ?, commute_checked_at = ? WHERE id = ?`,
  );
  const now = new Date().toISOString();
  rows.forEach((row, i) => {
    const m = minutes[i % minutes.length];
    upd.run(m, m * 380, i % 3 === 0 ? 0 : 1, i % 4 === 0 ? 2 : 4, origin.id, row.address ?? '', `e2e-${row.id}`, now, row.id);
  });
  db.close();
  return { orders: rows.length, origin: origin.name };
}

/* ------------------------------------------------------------------ *
 * 截图
 * ------------------------------------------------------------------ */

const taken = [];
async function shot(page, name) {
  const file = join(shotsDir, name);
  await page.screenshot({ path: file });
  taken.push(name);
  console.log(`[e2e] 截图 ${name}`);
}

/**
 * 演示资质：截图里「我的资质」全空看着像没做完，所以灌一份**编造**的示例资料。
 * 必须自己写、绝不复制仓库里的 `data/profile.json` —— 那是用户本人的真实资质，
 * 一旦进了截图就会跟着图片流出本机。
 */
function seedProfile() {
  const demo = {
    name: '示例同学',
    gender: '男',
    school: '暨南大学',
    schoolTier: '211',
    degree: '本科',
    teacherType: '大学生',
    majors: ['光电信息科学与工程'],
    majorCategory: '理科',
    certificates: ['英语六级'],
    languages: ['普通话', '粤语'],
    hasExperience: true,
  };
  writeFileSync(join(dataDir, 'profile.json'), `${JSON.stringify(demo, null, 2)}\n`, 'utf8');
}

async function main() {
  seedProfile();
  await waitHealth();

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // favicon 缺失不影响功能，别让它把一次成功的端到端判死
    if (t.includes('favicon') || t.includes('404')) return;
    problems.push(`console: ${t}`);
  });

  // ① 空库首启
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByText('两步就能用起来').waitFor({ timeout: 10_000 });
  await shot(page, '01-首启空库-两步引导.png');

  // ② 造数据后看列表
  const seeded = await seed();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('main .space-y-2 > *').length > 5, null, { timeout: 10_000 });
  await shot(page, '02-列表-判定与通勤.png');

  // ③ 设置抽屉四个页签
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const tabs = [
    ['我的资质', '03-设置-我的资质.png'],
    ['出发点', '04-设置-出发点.png'],
    ['通勤状态', '05-设置-通勤状态.png'],
    ['自动导入', '06-设置-自动导入.png'],
  ];
  for (const [label, file] of tabs) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(250); // 页签内有二次请求（资质/通勤状态），等它落地再拍
    await shot(page, file);
  }
  await page.keyboard.press('Escape');

  // ④ 导入体检：故意粘一段被截断的（T5 最后一条缺【要求】），体检面板要当场说出来
  const t5 = readFileSync(join(samples, 't5.txt'), 'utf8').split(/\r?\n/);
  const cut = t5.findIndex((l) => l.includes('110-140/h'));
  const truncated = t5.slice(0, cut + 1).join('\n');
  await page.locator('header').getByRole('button', { name: '粘贴导入' }).click();
  await page.locator('textarea').fill(truncated);
  await page.getByRole('button', { name: '解析并导入' }).click();
  await page.getByText('导入体检').waitFor({ timeout: 10_000 });
  await shot(page, '07-导入体检-缺字段.png');

  await browser.close();

  console.log(`[e2e] 造数：${seeded.orders} 单，出发点「${seeded.origin}」`);
  console.log(`[e2e] 输出目录 ${shotsDir}`);
  if (problems.length) {
    console.error('[e2e] 页面报错：');
    for (const p of problems) console.error('  ' + p);
    process.exitCode = 1;
  } else {
    console.log('[e2e] 无页面报错');
  }
}

/** 等服务真的退出：SQLite 的 .db/-wal 还开着时，Windows 不允许删目录（EPERM） */
function stopServer() {
  return new Promise((res) => {
    if (server.exitCode !== null) return res();
    server.once('exit', () => res());
    server.kill();
    setTimeout(res, 2000);
  });
}

async function removeDir(dir) {
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.warn(`[e2e] 临时库没删干净（文件还被占用），可手动删：${dir}`);
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error('[e2e] 失败：', e instanceof Error ? e.message : e);
  console.error('[e2e] 服务日志：\n' + serverLog.slice(-20).join('\n'));
  exitCode = 1;
} finally {
  await stopServer();
  await removeDir(dataDir);
  process.exit(exitCode || process.exitCode || 0);
}
