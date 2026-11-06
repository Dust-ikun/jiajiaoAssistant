import { useEffect, useState } from 'react';
import { fetchCaptureStatus } from '../../api';
import type { CaptureStatus } from '../../types';
import { cn } from '../../cn';
import { SectionTitle } from './bits';
import { relTime } from '../../format';

/**
 * 「剪贴板自动导入」面板。
 *
 * 【为什么要把这条放在设置里、还要明说开了没】它会**静默**往库里写东西。
 * 一个默默运行、看不见的写入通道，比一个报错的写入通道可怕得多 ——
 * 用户必须随时能确认「现在它是开着的还是关着的、刚才那一下到底导没导」。
 */
export function CapturePanel() {
  const [s, setS] = useState<CaptureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetchCaptureStatus()
        .then((r) => {
          setS(r);
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : '读取失败'));
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  if (!s) {
    return <div className="px-4 py-6 text-[12px] text-slate-400">{error ?? '读取中…'}</div>;
  }

  return (
    <div className="space-y-5 px-4 py-4">
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'chip',
              s.running ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500',
            )}
          >
            {s.running ? '已开启' : '未开启'}
          </span>
          <span className="text-[12px] text-slate-700">复制即入库</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          在微信里选中群消息 Ctrl+C，程序会自己把它收进来并拆单，列表几秒内刷新。
          只处理<b>能识别出编号</b>的内容 —— 复制链接、密码、代码不会被导入。
        </p>
      </div>

      {!s.running && (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-600">
          <p className="font-medium text-slate-700">怎么开</p>
          {s.supported ? (
            <>
              <p className="mt-1">
                在项目根目录的 <span className="font-mono text-slate-800">.env</span> 里加一行：
              </p>
              <pre className="mt-1 rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-800">
                CLIPBOARD_AUTO_IMPORT=1
              </pre>
              <p className="mt-1">然后重启服务。默认关着 —— 这是故意留的一道门，不会替你决定。</p>
            </>
          ) : (
            <p className="mt-1">{s.reason ?? '当前系统不支持'}</p>
          )}
        </div>
      )}

      <div>
        <SectionTitle>最近的自动导入</SectionTitle>
        {s.recent.length === 0 ? (
          <p className="text-[11.5px] leading-relaxed text-slate-400">
            {s.running ? '还没导过东西。复制一段群消息试试。' : '开启后这里会出现每次导入的摘要。'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {s.recent.map((r, i) => (
              <li
                key={`${r.at}-${i}`}
                className={cn(
                  'rounded-lg border bg-white px-2.5 py-1.5',
                  i === 0 ? 'border-indigo-200' : 'border-slate-200',
                )}
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[12px] font-medium text-slate-700">{r.orders} 单</span>
                  <span className="text-[11px] text-slate-500">
                    新增 {r.inserted}
                    {r.duplicated > 0 ? ` · 合并 ${r.duplicated}` : ''}
                  </span>
                  <span className="text-[10.5px] text-slate-400">{relTime(r.at)}</span>
                </div>
                {r.orderNos.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.orderNos.slice(0, 8).map((no) => (
                      <span key={no} className="chip bg-slate-100 font-mono text-[10.5px] text-slate-600">
                        #{no}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[10.5px] leading-relaxed text-slate-400">
          摘要里只有编号和计数，没有单子正文 —— 地址、家长电话都不会出现在这条通道上。
        </p>
      </div>
    </div>
  );
}
