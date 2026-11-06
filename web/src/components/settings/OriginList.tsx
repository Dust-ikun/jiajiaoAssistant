import { useCallback, useEffect, useState } from 'react';
import { createOrigin, deleteOrigin, fetchOrigins, patchOrigin } from '../../api';
import type { Origin } from '../../types';
import { cn } from '../../cn';
import { SectionTitle } from './bits';

interface Props {
  /** 出发点变了 → 通勤全部作废重算，外层必须重拉列表 */
  onChanged: () => void;
}

export function OriginList({ onChanged }: Props) {
  const [items, setItems] = useState<Origin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');

  const [editing, setEditing] = useState<Origin | null>(null);
  const [editName, setEditName] = useState('');
  const [editAddress, setEditAddress] = useState('');

  const load = useCallback(() => {
    setError(null);
    fetchOrigins()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '读取失败'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** 所有写操作都走这里：统一忙状态、统一报错、成功后重读列表并让外层重算 */
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      await createOrigin({ name: name.trim(), address: address.trim() });
      setName('');
      setAddress('');
    });

  const startEdit = (o: Origin) => {
    setEditing(o);
    setEditName(o.name);
    setEditAddress(o.address);
  };

  const commitEdit = () =>
    run(async () => {
      if (!editing) return;
      await patchOrigin(editing.id, { name: editName.trim(), address: editAddress.trim() });
      setEditing(null);
    });

  return (
    <div className="space-y-5 px-4 py-4">
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-500">
        通勤从这里算起。<b>必须由你自己添加</b>，程序不会拿「学校名」之类的东西去猜 ——
        猜错的结果是整列通勤偏十几公里，而界面上完全看不出来。地址越具体越准（写到门牌或小区名）。
      </p>

      <div>
        <SectionTitle>已有出发点</SectionTitle>
        {!items ? (
          <p className="text-[12px] text-slate-400">{error ?? '读取中…'}</p>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-amber-200 bg-amber-50/60 px-3 py-2 text-[11.5px] leading-relaxed text-amber-700">
            还没有出发点 —— 通勤一列会一直是空白。在下面加一个即可开算。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((o) => {
              const isEditing = editing?.id === o.id;
              return (
                <li
                  key={o.id}
                  className={cn(
                    'rounded-lg border bg-white px-2.5 py-2',
                    o.isDefault ? 'border-indigo-200' : 'border-slate-200',
                  )}
                >
                  {isEditing ? (
                    <div className="space-y-1.5">
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} className="field" placeholder="名称" />
                      <input
                        value={editAddress}
                        onChange={(e) => setEditAddress(e.target.value)}
                        className="field"
                        placeholder="详细地址"
                      />
                      <p className="text-[10.5px] leading-snug text-amber-600">
                        改地址会让旧坐标作废，涉及的单子会重新算一次通勤（多数能命中缓存）
                      </p>
                      <div className="flex gap-1.5">
                        <button onClick={commitEdit} disabled={busy} className="btn-primary !px-2 !py-1 !text-[11.5px]">
                          保存
                        </button>
                        <button onClick={() => setEditing(null)} className="btn-ghost !px-2 !py-1 !text-[11.5px]">
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[12.5px] font-medium text-slate-800">{o.name}</span>
                          {o.isDefault && <span className="chip bg-indigo-50 text-indigo-600">默认</span>}
                          {o.lng === null && (
                            <span className="chip bg-slate-100 text-slate-500" title="下次算通勤时会向高德定位一次">
                              未定位
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 break-all text-[11.5px] leading-relaxed text-slate-500">{o.address}</div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {!o.isDefault && (
                          <button
                            onClick={() => run(() => patchOrigin(o.id, { isDefault: true }))}
                            disabled={busy}
                            className="text-[11px] text-indigo-600 hover:text-indigo-700"
                          >
                            设为默认
                          </button>
                        )}
                        <button
                          onClick={() => startEdit(o)}
                          className="text-[11px] text-slate-500 hover:text-slate-700"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`删除出发点「${o.name}」？已算出的通勤结果会作废。`)) {
                              void run(() => deleteOrigin(o.id));
                            }
                          }}
                          disabled={busy}
                          className="text-[11px] text-slate-400 hover:text-rose-600"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <SectionTitle>添加出发点</SectionTitle>
        <div className="space-y-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称，如「家」「宿舍」" className="field" />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="详细地址，如「广州市天河区暨南大学石牌校区」"
            className="field"
          />
          <button
            onClick={add}
            disabled={busy || !name.trim() || !address.trim()}
            className="btn-primary disabled:opacity-40"
          >
            {items?.length ? '添加' : '添加并开始算通勤'}
          </button>
        </div>
      </div>

      {error && items && <p className="text-[12px] leading-relaxed text-rose-600">{error}</p>}
    </div>
  );
}
