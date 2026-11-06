/**
 * 把 server 打包成**一个纯 JS 文件**，供桌面壳 spawn。
 *
 * 【为什么不直接把 server/src 塞进安装包】
 * 1. 源码是 TS，靠 Node 24 的原生剥类型跑；Electron 自带的 Node 版本未必支持（且打包后不该赌）。
 * 2. express / cors 在 npm workspaces 下被提升到仓库根的 node_modules，
 *    要打进安装包就得原样复制整棵依赖树，路径与平台差异一堆。
 * 打成单文件后，安装包里只有 `server/server.mjs` 一个文件，没有 node_modules。
 *
 * 【为什么 CJS 依赖能进 ESM 产物】esbuild 会为 CJS 模块生成 require 包装，
 * 顶部的 banner 补一个 createRequire，兜住极少数运行时才 require 的写法。
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // desktop/scripts
const root = resolve(here, '../..');

await build({
  entryPoints: [resolve(root, 'server/src/index.ts')],
  outfile: resolve(root, 'desktop/dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  // 打包后的相对路径全变了：让运行期用环境变量指路（服务入口本身读 JIAJIAO_DATA / JIAJIAO_WEB_DIST）
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});

console.log('[jiajiao] 服务端已打成单文件 desktop/dist/server.mjs');
