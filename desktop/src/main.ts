/**
 * Electron 主进程：起本地服务 → 等它健康 → 开窗口。
 *
 * 【为什么桌面壳只做「起服务 + 开窗口」两件事】
 * 业务逻辑全在本地 HTTP 服务里（决策 2），壳里多写一行判断，浏览器直连 8787 的行为就和桌面版
 * 不一样了，两套表现迟早会分叉。所以这里**不碰数据、不碰解析**，只负责进程生命周期与窗口。
 *
 * 【为什么不用 `ELECTRON_RUN_AS_NODE` 硬编码】打包后最理想的是完全自带运行时（不要求装 Node），
 * 但 Electron 内置的 Node 是否编进了 `node:sqlite` 要看构建参数，不敢假设。所以启动前**实测一次**：
 * 能跑就用自带运行时，跑不了退回系统 node；两个都不行就把真实报错摆给用户看，而不是转圈。
 */
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 应用名决定 `%APPDATA%` 下那个目录叫什么。不设的话 Electron 会取 package.json 的 name
 * （这里是 workspace 名 `desktop`），于是数据落在 `%APPDATA%\desktop\data` —— 名字太泛、
 * 还容易和别的程序撞；文档里也没法写一个确定位置。必须在 getPath('userData') 之前调用。
 */
app.setName('jiajiao');

const here = dirname(fileURLToPath(import.meta.url)); // 开发期是 desktop/dist
const dev = !app.isPackaged;

/** 服务入口：开发期是 esbuild 打出来的单文件；打包后由 electron-builder 放到 resources/server */
const serverEntry = dev ? join(here, 'server.mjs') : join(process.resourcesPath, 'server', 'server.mjs');
/** 前端构建产物：服务端负责托管（同端口，避免桌面版还要单独起一个 vite） */
const webDist = dev ? resolve(here, '../../web/dist') : join(process.resourcesPath, 'web');
/**
 * 数据目录：开发期用仓库里的真实 data/，打包后落 userData（安装目录通常不可写）。
 * 允许 JIAJIAO_DATA 覆盖 —— 端到端测试必须能指向一个临时库，否则截图中会混进真实单子。
 */
const dataDir = process.env.JIAJIAO_DATA?.trim() || (dev ? resolve(here, '../../data') : join(app.getPath('userData'), 'data'));
/** .env 只读不写：开发期读仓库根目录，打包后读 userData（AMAP_KEY 等仍不进版本控制） */
const envFile = dev ? resolve(here, '../../.env') : join(app.getPath('userData'), '.env');

/**
 * 打包版第一次启动时放一份配置模板。
 *
 * 【为什么值得写一个空模板】桌面版没有「项目根目录」这个概念，`.env` 该放哪、该写什么键，
 * 用户无从得知；而没有 AMAP_KEY 的表现是**通勤一列永远空白**，界面上只写「未配置」，
 * 谁都不会想到要去 %APPDATA% 里新建一个隐藏文件名以点开头的文件。模板里把两个键和默认值都写清楚。
 */
const ENV_TEMPLATE = `# 家教单助手 · 本机配置（只在本机，不上传，也不进版本控制）

# 高德「Web服务」key。填了才会算通勤（公交/地铁方案）；
# 不填也能用，只是通勤一列显示「未配置」，列表按时薪/时效排。
AMAP_KEY=

# 每天最多调用多少次高德接口（一单最多 2 次：地理编码 + 路径规划）
AMAP_DAILY_LIMIT=2000

# 复制群消息就自动入库。默认关 —— 它会静默往库里写东西，需要你自己打开。
# CLIPBOARD_AUTO_IMPORT=1
`;

function ensureEnvTemplate(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ENV_TEMPLATE, 'utf8');
  console.log(`[jiajiao] 已生成配置模板：${path}`);
}

let child: ChildProcess | null = null;
let win: BrowserWindow | null = null;
/** 服务进程最近几十行输出：起不来时原样给用户看，比「启动失败」四个字有用得多 */
const logRing: string[] = [];

/** 日志里可能出现的手机号一律打码 —— 红线：日志不记单子正文（含家长电话） */
function redact(line: string): string {
  return line.replace(/\b1[3-9]\d{9}\b/g, '1**********');
}

function record(chunk: string): void {
  for (const raw of chunk.split(/\r?\n/)) {
    const line = redact(raw.trim());
    if (!line) continue;
    logRing.push(line.slice(0, 400));
    if (logRing.length > 40) logRing.shift();
  }
}

function tail(n = 12): string {
  return logRing.slice(-n).join('\n');
}

/* ------------------------------------------------------------------ *
 * 运行时探测
 * ------------------------------------------------------------------ */

interface Runner {
  label: string;
  cmd: string;
  /** 追加到子进程的环境（不污染主进程） */
  env: NodeJS.ProcessEnv;
}

/**
 * 探测一个运行时能否跑本项目：Node ≥ 22.5 有 `node:sqlite`，Node ≥ 22.18 / 23.6 才默认剥 TS 类型。
 * 我们喂给它的是**已打包的纯 JS**（scripts/build-server.mjs），所以只查 `node:sqlite` 一项。
 */
function works(runner: Runner): boolean {
  const r = spawnSync(runner.cmd, ['-e', 'process.stdout.write("ok:" + process.versions.node + ":" + (require("node:sqlite") ? "sqlite" : "no"))'], {
    env: { ...process.env, ...runner.env },
    timeout: 10_000,
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status === 0 && typeof r.stdout === 'string' && r.stdout.includes(':sqlite');
}

function pickRunner(): Runner {
  const candidates: Runner[] = [
    // 自带运行时：打包版的首选，用户什么都不用装
    { label: 'Electron 内置 Node', cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
    // 系统 node：开发期的首选（和 npm test / npm start 用同一个运行时）
    { label: '系统 node', cmd: 'node', env: {} },
  ];
  // 开发期先试系统 node：它和回归测试同一个版本，行为最好预测
  const ordered = dev ? [candidates[1], candidates[0]] : candidates;
  for (const c of ordered) {
    if (works(c)) return c;
  }
  throw new Error(
    '找不到能跑本地服务的 Node 运行时：\n' +
      '· Electron 自带的 Node 没编译 node:sqlite\n' +
      '· 系统 PATH 里也没有可用的 node（需要 Node 22.5+）',
  );
}

/* ------------------------------------------------------------------ *
 * 端口
 * ------------------------------------------------------------------ */

const PREFERRED_PORT = Number(process.env.PORT ?? 8787);

function probePort(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const srv = createServer();
    srv.once('error', () => resolveP(false));
    srv.once('listening', () => srv.close(() => resolveP(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 优先用 8787（和浏览器直连、同学的用法保持一致）；被占用时向系统要一个空闲端口。
 * 【为什么不直接报错退出】8787 上常驻着开发期的 `npm run dev` 是最常见的情况，
 * 桌面版为了这个打不开，用户只会以为程序坏了。换端口对界面没有影响（前端全用相对路径 /api）。
 */
async function pickPort(): Promise<number> {
  if (await probePort(PREFERRED_PORT)) return PREFERRED_PORT;
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : PREFERRED_PORT;
      srv.close(() => resolveP(port));
    });
  });
}

/* ------------------------------------------------------------------ *
 * .env
 * ------------------------------------------------------------------ */

/** 极简 .env 解析：只认 KEY=VALUE 与 # 注释，够读 AMAP_KEY / AMAP_DAILY_LIMIT 就行 */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 起服务 / 等健康
 * ------------------------------------------------------------------ */

async function health(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body?.ok === true;
  } catch {
    return false;
  }
}

async function startServer(): Promise<number> {
  if (!existsSync(serverEntry)) {
    throw new Error(`找不到服务入口：${serverEntry}\n先跑一次 npm run build:server`);
  }
  const runner = pickRunner();
  const port = await pickPort();

  if (!existsSync(webDist)) record('[壳] 没有找到前端构建产物，界面会是 404：先跑 npm run build');

  child = spawn(runner.cmd, [serverEntry], {
    cwd: dirname(serverEntry),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    /**
     * 覆盖顺序很关键：`.env` 只是兜底，**不能盖掉壳自己算出来的东西**。
     * 曾经想当然地写成「process.env → runner.env → .env」，结果是：壳挑了 8790 端口，
     * 而 `.env` 里若有 PORT=8787，服务会去听 8787，壳却一直轮询 8790 —— 表现为「启动 20 秒超时」，
     * 日志里还一切正常。数据目录同理（指错就是读写另一个库，比起不来更隐蔽）。
     */
    env: {
      ...readEnvFile(envFile),
      ...process.env,
      ...runner.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      JIAJIAO_DATA: dataDir,
      JIAJIAO_WEB_DIST: webDist,
    },
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  child.on('exit', (code) => {
    record(`[壳] 服务进程退出（code=${code ?? 'null'}）`);
    child = null;
  });

  console.log(`[jiajiao] 本地服务由「${runner.label}」启动，端口 ${port}`);

  // 等健康：串行队列、起服务约 300ms，给到 20s 足够（慢机器 + 首次建库）
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await health(port)) return port;
    if (!child) throw new Error(`本地服务启动后立刻退出。\n\n${tail()}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`本地服务 20 秒内没起来（端口 ${port}）。\n\n${tail()}`);
}

function stopServer(): void {
  if (!child) return;
  const c = child;
  child = null;
  c.kill();
  // 强杀兜底：Windows 上 TerminateProcess 是即时的，这里只是不想留下「退不干净」的可能
  setTimeout(() => {
    if (c.exitCode === null && !c.killed) c.kill('SIGKILL');
  }, 1500).unref?.();
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><meta charset="utf-8"><title>家教单助手</title>
<style>
  html,body{margin:0;height:100%;background:#f8fafc;color:#334155;
    font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{height:100%;display:grid;place-items:center;text-align:center}
  .badge{width:44px;height:44px;border-radius:12px;background:#4f46e5;color:#fff;
    display:grid;place-items:center;font-size:17px;font-weight:700;margin:0 auto 14px}
  .tip{color:#94a3b8;font-size:12px;margin-top:6px}
</style>
<div class="wrap"><div><div class="badge">家</div>
<div>正在启动本地服务…</div><div class="tip">首次启动会建库，稍等一两秒</div></div></div>
`)}`;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#f8fafc',
    title: '家教单助手',
    /**
     * 窗口图标只在**开发期**需要显式指定：这时跑的是 node_modules 里的 electron.exe，
     * 任务栏认的是那个原子的图标。打包后 exe 自己的图标已被 electron-builder 写入，
     * 窗口默认继承它 —— 再指一个 resources 里不存在的路径只会让图标变空。
     */
    icon: dev ? join(here, '../build/icon.png') : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      // 界面只是本地服务的客户端，不需要任何 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  w.once('ready-to-show', () => w.show());

  // 外链（家长群链接之类）走系统浏览器，不在应用窗口里打开
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 只允许待在本地服务这个 origin 里：地址栏不可见，跳走了用户就回不来了
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:')) e.preventDefault();
  });

  if (process.argv.includes('--dev')) w.webContents.openDevTools({ mode: 'detach' });

  void w.loadURL(SPLASH);
  return w;
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

// 单实例：第二次双击时把已经开着的窗口顶到前面，而不是再起一个服务抢端口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // 开发期读的是仓库 .env（不该被程序生成），只有打包版才铺模板
    if (!dev) ensureEnvTemplate(envFile);
    win = createWindow();
    try {
      const port = await startServer();
      await win.loadURL(`http://127.0.0.1:${port}/`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dialog.showErrorBox('本地服务没起来', msg);
      stopServer();
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', stopServer);
  app.on('will-quit', stopServer);
}
