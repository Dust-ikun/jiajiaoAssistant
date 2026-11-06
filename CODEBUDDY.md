# 家教单看板（jiajiao）

本地工具，Windows。把微信家教群的聊天记录粘贴进来，拆成一条条单子、抽取元数据、判定「我接不接得了」，再按通勤/时薪/时效排序。

**完整背景先读 `docs/CONTEXT.md`** —— 产品决策、六套真实模板原文、当前进度、已知的坑都在里面。本文件只放不变的红线。

## 硬约束

- **纯本地**：SQLite 与缓存只落本机；日志不记地址全文、不记单子正文（含家长电话）
- **密钥只从 `.env` 读**（`AMAP_KEY`），绝不写进代码、文档或提交记录；`.env` 已在 `.gitignore` 里
- **宁可留空不猜**：解析不出的字段落 `null` + `warnings`，绝不编造
- **时效只能用消息发送时间**，禁止用导入时间冒充发布时间
- **匹配三态**（可接 / 存疑 / 不可接），不确定一律落「存疑」，因为漏单不可察觉
- **资质必须外部可改**：落 `data/profile.json`（或 `PUT /api/profile`），绝不写死在代码里；该文件只在本机、不入版本控制
- **未算完通勤的单子不得混进已排序列表**，否则「前 10 名」只是「先算完的 10 单」
- **加列必须走 `PRAGMA table_info` 检测**，`CREATE TABLE IF NOT EXISTS` 不会给已有表补列
- **桌面壳不碰业务**：`desktop/src/main.ts` 只负责起服务、等健康、开窗、退出收尸；数据/解析/判定一律留在本地 HTTP 服务，否则浏览器直连 8787 的用法会和桌面版分叉
- **端到端与截图必须用临时库**：`JIAJIAO_DATA` 指到临时目录，图片里绝不能出现真实单子（含家长地址电话）

## 技术约定

- Node 24 + TypeScript，解析层是纯函数、零 IO
- 存储用 `node:sqlite`（Node 内置），**不要换成 better-sqlite3**
- 端口 8787；npm workspaces：`server` / `web`（`desktop` 待建）
- 改 `dict.ts`、同义词表或匹配规则后，必须重跑六模板回归
- 改 `api.ts` 的入参或响应形状后，必须跑 `api.test.ts`（只测 db 层发现不了「接口把参数传错了」）
- **测试一律用假 provider，绝不消耗真实高德配额**；真 key 只用于手动冒烟
- 通勤配额上限走 `.env` 的 `AMAP_DAILY_LIMIT`，队列间隔与并发不写死在调用处
- **`electron` 必须是精确版本**（`45.2.3`，不能是 `^45.2.3`）：electron-builder 解析不了版本范围会直接中止打包
- 国内网络装 Electron / 打安装包前先设镜像：`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`（见 `docs/CONTEXT.md` 第 5 节），否则会卡在从 GitHub 拉二进制

## 表达风格

中文注释；给结论时带上「为什么」的论证；举例优先用 `docs/CONTEXT.md` 里的真实数据。
