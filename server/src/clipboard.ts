/**
 * 剪贴板自动导入：在微信里 Ctrl+C 复制一段群消息，程序自己把它收进库。
 *
 * 动手前先定三条规矩，它们比功能本身更重要：
 *
 * 1. **正文只落 `raw_messages`，不进日志、不进摘要**：入库方式和手动粘贴完全一样
 *    （原文要留着，重解析靠它），但控制台与 `/api/capture/status` 只出现「几张单、哪些编号」，
 *    绝不出现单子内容（红线：日志不记单子正文，含家长电话）。
 * 2. **不是什么都导**：必须能被解析器切出至少一张单子（命中编号锚点）才入库。
 *    「复制了个密码 / 链接 / 一段代码」不该在库里留下任何痕迹。
 * 3. **同一段只导一次**：轮询会反复看到同一份内容，按内容 hash 去重。
 *    用户主动想再导一次（比如补全了原文）时，内容变了，hash 也变了，自然就放行。
 *
 * 【为什么用 PowerShell 长驻子进程而不是 Node 原生】Node 没有读剪贴板的 API，
 * 加依赖（clipboardy 之类）要编译原生模块。Windows 自带 `Get-Clipboard`，
 * 起**一个**长驻 powershell 循环输出变化，比每秒 spawn 一次进程轻得多。
 * 输出用 base64 单行，避免多行文本在 stdout 上被拆行拆坏。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { importMessage, type ImportResult } from './db.ts';
import { parseMessage } from './parser/parse.ts';

/** 一次自动导入的摘要。**故意不存正文**，只留编号与计数 */
export interface CaptureRecord {
  at: string;
  /** 解析出几张单 */
  orders: number;
  inserted: number;
  duplicated: number;
  orderNos: string[];
}

export interface CaptureStatus {
  supported: boolean;
  running: boolean;
  /** 没开或开不了时的原因，界面要原样显示 */
  reason: string | null;
  /** 最近几次自动导入，最新的在前 */
  recent: CaptureRecord[];
}

/* ------------------------------------------------------------------ *
 * 纯函数部分（可测，不碰剪贴板也不碰库）
 * ------------------------------------------------------------------ */

/** powershell 输出的一行 base64 → 文本。坏行返回 null，绝不抛错打断监听 */
export function decodeClipboardLine(line: string): string | null {
  const t = line.trim();
  if (!t || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  try {
    return Buffer.from(t, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 这段文本值不值得导入。
 * 判据就是「解析器能不能切出单子」—— 和界面上的导入完全同一套规则，
 * 不额外发明一套「像不像家教单」的猜测（猜错了要么漏单要么污染库）。
 */
export function looksLikeOrderText(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  // 太短的（一个词、一个链接）不可能是一张单
  if (t.length < 8) return false;
  // 太长的多半是整份文档/代码，整段解析会把库塞满噪声
  if (t.length > 50_000) return false;
  return parseMessage(t, null).length > 0;
}

export interface CaptureSink {
  /** 处理一段剪贴板文本；不值得导入或导过了 → 返回 null */
  handle(text: string): CaptureRecord | null;
  recent(): CaptureRecord[];
}

/**
 * 导入动作的可测外壳：把「要不要导、导完记什么」和「怎么读剪贴板」拆开。
 * 测试里注入一个假的 importText，就能把去重、过滤、摘要全测到，不用碰 powershell。
 */
export function createCaptureSink(deps: {
  importText: (input: { text: string; source: string; groupName?: string }) => ImportResult;
  now?: () => Date;
  /** 内存里留几条摘要给界面看 */
  keepRecent?: number;
  /** 记住多少个历史 hash 用于去重 */
  keepSeen?: number;
}): CaptureSink {
  const now = deps.now ?? (() => new Date());
  const keepRecent = deps.keepRecent ?? 10;
  const keepSeen = deps.keepSeen ?? 50;

  const recentRecords: CaptureRecord[] = [];
  const seen: string[] = [];

  const fingerprint = (text: string) => createHash('sha1').update(text).digest('hex');

  return {
    handle(text: string) {
      const t = text.trim();
      if (!looksLikeOrderText(t)) return null;

      const fp = fingerprint(t);
      if (seen.includes(fp)) return null;

      const res = deps.importText({ text: t, source: 'clipboard', groupName: '剪贴板' });
      if (!res.orders) return null;

      seen.unshift(fp);
      if (seen.length > keepSeen) seen.length = keepSeen;

      const record: CaptureRecord = {
        at: now().toISOString(),
        orders: res.orders,
        inserted: res.inserted,
        duplicated: res.duplicated,
        orderNos: res.diagnostics.orders.map((o) => o.orderNo).filter((n): n is string => Boolean(n)),
      };
      recentRecords.unshift(record);
      if (recentRecords.length > keepRecent) recentRecords.length = keepRecent;
      return record;
    },
    recent() {
      return [...recentRecords];
    },
  };
}

/* ------------------------------------------------------------------ *
 * 真正读剪贴板的那一层
 * ------------------------------------------------------------------ */

/**
 * 长驻的 powershell 循环：内容一变就吐一行 base64。
 *
 * 【为什么开循环之前先「记下当前内容」】否则服务一启动就会把剪贴板里**残留的旧内容**导入一遍：
 * 那段可能是几小时前已经导过的、也可能只是复制到一半的半截。
 * 现在的语义很干脆：**只导「服务运行期间新复制的内容」**。
 * 想让旧内容入库，再按一次 Ctrl+C 即可（内容一变就会被看到）。
 */
function watcherScript(intervalMs: number, parentPid: number): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$parentPid = ${parentPid}
$last = Get-Clipboard -Raw
if ($null -eq $last) { $last = '' }
$tick = 0
while ($true) {
  # 父进程（node）没了就自己退出。被 taskkill /F 强杀时 Node 的 exit 钩子不会执行，
  # 不做这个检查就会留下一个一直在读剪贴板的孤儿进程。
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  $t = Get-Clipboard -Raw
  if ($null -eq $t) { $t = '' }
  if ($t.Length -gt 0 -and $t -ne $last) {
    $last = $t
    [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))
    [Console]::Out.Flush()
  }
  # 心跳：Get-Clipboard 在剪贴板被别的程序占用时会**卡住不返回**（实测会卡死整个循环，
  # 子进程还活着、还占着句柄，但它已经不再读任何东西了）。Node 侧靠这个心跳判断死活。
  $tick++
  if ($tick % 5 -eq 0) {
    [Console]::Out.WriteLine('--beat--')
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds ${intervalMs}
}
`.trim();
}

/**
 * 心跳判死的阈值来自轮询间隔：子进程每 5 个 tick 吐一次心跳，
 * Node 侧连续 4 个心跳周期（约 4×4s）没收到任何输出，就认定它卡住了。
 * 【为什么必须有】`Get-Clipboard` 并不保证一定返回 —— 剪贴板被别的程序锁住时它会卡住不返回，
 * 表现为「功能还在、就是不工作」，比进程直接挂掉更难发现。
 */
function beatTimeoutOf(intervalMs: number): number {
  return intervalMs * 5 * 4;
}

export interface ClipboardWatcher {
  status(): CaptureStatus;
  start(): void;
  stop(): void;
}

export function createClipboardWatcher(options: {
  sink: CaptureSink;
  /** 轮询间隔：800ms 足够快，又不至于让 powershell 空转吃掉一个核 */
  intervalMs?: number;
  onCapture?: (r: CaptureRecord) => void;
  platform?: NodeJS.Platform;
}): ClipboardWatcher {
  const intervalMs = options.intervalMs ?? 800;
  const platform = options.platform ?? process.platform;
  const supported = platform === 'win32';

  const beatTimeout = beatTimeoutOf(intervalMs);

  let child: ChildProcessWithoutNullStreams | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let lastBeat = Date.now();
  let restarts = 0;
  let reason: string | null = supported
    ? null
    : '剪贴板监听目前只支持 Windows（靠系统自带的 Get-Clipboard）';
  let buffer = '';

  const onLine = (line: string) => {
    lastBeat = Date.now();
    const text = decodeClipboardLine(line);
    if (!text) return;
    const record = options.sink.handle(text);
    if (record) options.onCapture?.(record);
  };

  const spawnChild = () => {
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', watcherScript(intervalMs, process.pid)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
      child = null;
      return;
    }
    lastBeat = Date.now();
    buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const l of lines) onLine(l);
    });
    // 子进程挂了（用户手动结束、被系统杀掉）就把状态翻回去，别让界面一直显示「已开启」
    child.on('exit', () => {
      child = null;
      reason = reason ?? '剪贴板监听进程已退出';
    });
    child.on('error', (e) => {
      child = null;
      reason = e.message;
    });
  };

  return {
    status() {
      return {
        supported,
        // 卡住的子进程不算「在跑」：它占着句柄但读不到任何东西，比没开更误导人
        running: child !== null && Date.now() - lastBeat < beatTimeout,
        reason,
        recent: options.sink.recent(),
      };
    },
    start() {
      if (child || !supported) return;
      spawnChild();
      if (!child) return;
      watchdog = setInterval(() => {
        if (!child) return;
        if (Date.now() - lastBeat <= beatTimeout) return;
        // 心跳断了：杀掉重开。最多连着重启两次，再不行就停手并说明原因，
        // 免得变成「每 15 秒杀一次 powershell」的噪声（那是另一类卡）
        child.kill();
        child = null;
        if (++restarts >= 3) {
          reason = '剪贴板监听反复无响应，已停止（可能被其他程序长期占用剪贴板）';
          if (watchdog) clearInterval(watchdog);
          watchdog = null;
          return;
        }
        spawnChild();
      }, Math.max(1000, Math.floor(beatTimeout / 3)));
    },
    stop() {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      child?.kill();
      child = null;
    },
  };
}

/** 全局单例：index.ts 启动它，api.ts 读它的状态 */
export const clipboardWatcher: ClipboardWatcher = createClipboardWatcher({
  sink: createCaptureSink({ importText: importMessage }),
  onCapture: (r) => {
    // 只记计数与编号，不记正文（红线）
    console.log(`[jiajiao] 剪贴板识别到 ${r.orders} 单（新增 ${r.inserted}，合并 ${r.duplicated}）`);
  },
});

/**
 * 是否启用：默认**关**，必须在 `.env` 里显式写 `CLIPBOARD_AUTO_IMPORT=1`。
 * 【为什么默认关】它会静默往库里写东西，这种能力必须是用户主动打开的，
 * 不能因为「更新了版本」就替用户决定把剪贴板接进来。
 */
export function parseAutoImportFlag(raw: string | undefined): boolean {
  return raw?.trim() === '1' || raw?.trim().toLowerCase() === 'true';
}

export function maybeStartClipboardWatcher(flag: string | undefined = process.env.CLIPBOARD_AUTO_IMPORT): boolean {
  if (!parseAutoImportFlag(flag)) return false;
  clipboardWatcher.start();
  const s = clipboardWatcher.status();
  if (s.running) console.log('[jiajiao] 剪贴板自动导入已开启：复制一段群消息就会自动入库');
  else console.log(`[jiajiao] 剪贴板自动导入没起来：${s.reason ?? '未知原因'}`);
  return s.running;
}
