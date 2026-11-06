/**
 * 桌面壳冒烟：真的把 Electron 拉起来，看窗口里是不是那个界面，退出后服务有没有跟着死。
 *
 * 【为什么这条必须单独测，不能只看网页版截图】桌面壳只做两件网页版不会做的事：
 * 自己把服务拉起来、自己把它收掉。这两件事出问题的表现都很恶心 ——
 * 起不来是「窗口一片白」，收不掉是「下次开机端口被占、库里被两个进程同时写」。
 *
 * 两种模式各验一遍：
 *   node desktop/e2e/electron-smoke.mjs              # 源码模式（用系统 node 起服务）
 *   node desktop/e2e/electron-smoke.mjs --packaged   # 打包模式（用 Electron 自带 Node 起服务）
 *
 * 都用临时库（JIAJIAO_DATA），不碰 data/；AMAP_KEY 置空，通勤不会发任何请求。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const desktopDir = resolve(root, 'desktop');
const shotsDir = resolve(here, 'shots');
const packaged = process.argv.includes('--packaged');

/** electron 包的二进制位置就写在 path.txt 里；没下载成功时它根本不存在 */
function electronBinary() {
  const pkg = resolve(root, 'node_modules/electron');
  const txt = join(pkg, 'path.txt');
  if (!existsSync(txt)) return null;
  const exe = join(pkg, 'dist', readFileSync(txt, 'utf8').trim());
  return existsSync(exe) ? exe : null;
}

/** 打包产物：electron-builder --dir 出来的免安装目录 */
function packagedBinary() {
  const dir = resolve(desktopDir, 'release/win-unpacked');
  if (!existsSync(dir)) return null;
  const exe = readdirSync(dir).find((f) => f.endsWith('.exe'));
  return exe ? join(dir, exe) : null;
}

const target = packaged
  ? { label: '打包版', exe: packagedBinary(), args: [], cwd: undefined, port: 8796, shot: '09-打包版窗口.png', hint: '先跑 npm run desktop:pack' }
  : { label: '源码版', exe: electronBinary(), args: [desktopDir], cwd: desktopDir, port: 8797, shot: '08-桌面窗口.png', hint: '先跑 npm -w desktop run build' };

if (!target.exe) {
  if (packaged) {
    console.error(`跳过打包版：没有 ${target.hint}`);
    process.exit(0);
  }
  console.log('[smoke] 跳过：Electron 二进制没下载下来。');
  console.log('       在国内网络下执行：');
  console.log('       set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/" && node node_modules\\electron\\install.js');
  process.exit(0);
}
if (!packaged && !existsSync(resolve(desktopDir, 'dist/main.js'))) {
  console.error(`缺 desktop/dist/main.js：${target.hint}`);
  process.exit(1);
}

mkdirSync(shotsDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'jj-desktop-'));

const app = await electron.launch({
  executablePath: target.exe,
  args: target.args,
  cwd: target.cwd,
  env: { ...process.env, JIAJIAO_DATA: dataDir, AMAP_KEY: '', CLIPBOARD_AUTO_IMPORT: '', PORT: String(target.port) },
});

let failed = false;
try {
  const win = await app.firstWindow({ timeout: 40_000 });
  await win.waitForSelector('header', { timeout: 40_000 });
  // 等首屏真的画完：只等 header 会拍到「加载中…」，那种截图证明不了任何事
  await win.getByText('两步就能用起来').waitFor({ timeout: 25_000 });

  console.log(`[smoke] ${target.label} 窗口标题：`, await win.title());
  await win.screenshot({ path: join(shotsDir, target.shot) });
  console.log(`[smoke] 截图 ${target.shot}`);

  // 服务必须监听在壳挑的那个端口上：端口对不上时页面是白的，而日志一切正常
  const health = await win.evaluate(async () => (await fetch('/api/health')).status);
  console.log(`[smoke] 页面内 /api/health → ${health}（端口 ${target.port}）`);
  if (health !== 200) failed = true;

  const body = await win.evaluate(() => document.body.innerText);
  if (!body.includes('家教单助手')) {
    console.error('[smoke] 窗口里没看到界面');
    failed = true;
  }
  console.log(`[smoke] 库文件：${existsSync(join(dataDir, 'jiajiao.db')) ? '已建' : '没建'}`);
} catch (e) {
  console.error('[smoke] 失败：', e instanceof Error ? e.message : e);
  failed = true;
} finally {
  await app.close();
  // 退出后端口必须空出来：服务没被收掉的话，下次启动会换端口，用户库里则可能双写
  await new Promise((r) => setTimeout(r, 1500));
  const free = await new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.listen(target.port, '127.0.0.1', () => srv.close(() => res(true)));
  });
  console.log(`[smoke] 退出后 ${target.port} ${free ? '已释放' : '仍被占用 —— 服务进程没跟着退出'}`);
  if (!free) failed = true;

  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  process.exit(failed ? 1 : 0);
}
