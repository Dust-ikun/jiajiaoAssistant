import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './api.ts';
import { createAmapProvider } from './commute/amap.ts';
import { createCommuteService, DEFAULT_DAILY_LIMIT, parseDailyLimit } from './commute/service.ts';
import { clipboardWatcher, maybeStartClipboardWatcher } from './clipboard.ts';

const here = dirname(fileURLToPath(import.meta.url));

// 日配额上限（HTTP 调用次数，一单最多 2 次）：可用 .env 的 AMAP_DAILY_LIMIT 覆盖，
// 灌历史单那天临时调到 2000 比改代码重新构建合理；写错了退回默认值
const provider = createAmapProvider();
const dailyLimit = parseDailyLimit(process.env.AMAP_DAILY_LIMIT);
const commute = createCommuteService({ provider, dailyLimit });
if (!provider) console.log('[jiajiao] 未配置 AMAP_KEY，通勤列显示「未配置」，其余功能正常');
console.log(`[jiajiao] 通勤日配额上限 ${dailyLimit} 次（HTTP 调用数，可用 .env 的 AMAP_DAILY_LIMIT 调整）`);

// 出发点故意**不**自动生成。曾经拿 profile.school 试过一次：高德把「暨南大学」解析到了
// 番禺校区的公交站，通勤结果整体偏了十几公里，而界面上完全看不出来 —— 这种「静默错」正是
// 本项目最怕的。没有出发点时状态里给 no_origin，等用户在设置里明确填一次。
// 日志只记状态，不记地址全文（CODEBUDDY.md 硬约束）
if (!commute.status().origin) console.log('[jiajiao] 还没有出发点，通勤暂不计算（设置里添加）');

const app = createApp(commute);

// 生产模式：前端构建产物由同一个端口托管（Electron 壳和局域网同学都访问这里）
// 打成单文件塞进安装包后，`../../web/dist` 这个相对位置就不成立了 ——
// 所以允许桌面壳用 JIAJIAO_WEB_DIST 指路，缺省仍是仓库里的 web/dist（开发期、npm start 都不变）
const dist = resolve(process.env.JIAJIAO_WEB_DIST?.trim() || resolve(here, '../../web/dist'));
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`[jiajiao] API 已启动 → http://${HOST}:${PORT}`);
});

// 剪贴板自动导入：默认关，.env 里写 CLIPBOARD_AUTO_IMPORT=1 才开（见 clipboard.ts 的说明）
maybeStartClipboardWatcher();

// 服务退出时把 powershell 子进程一起收掉，否则它会一直挂在后台读剪贴板
const shutdown = () => {
  clipboardWatcher.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => clipboardWatcher.stop());
