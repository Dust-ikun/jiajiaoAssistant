/**
 * 通勤计算的串行队列。
 *
 * 【为什么必须串行 + 间隔】高德 Web 服务的 QPS 限制很低（免费档个位数），
 * 一屏 30 个单子并发打过去会直接撞限流，返回的还是一堆失败 —— 既烧配额又白干。
 *
 * 【为什么间隔是 400ms 而不是 300ms】个人 Key 的 QPS 通常按 3 次/秒算，
 * 300ms 等于 3.33 次/秒，而且一个 job 内部的 geocode + planTransit 是紧挨着发的，
 * 很容易在某一秒里冒出 4 次请求 → 高德返回 10004（封停一分钟，表现是"连续失败一阵又自己好了"）。
 * 400ms = 2.5 次/秒，留出余量；30 单仍是 12 秒左右，用户感觉不到。
 *
 * 【为什么失败要重试 1 次】通勤失败大多是网络抖动或高德偶发 5xx，
 * 重试一次能吃掉大部分；重试到第三次就是在拿配额赌运气了。
 *
 * 【为什么不在这里写数据库】这个类只做调度：拿 id → 调 handler → 失败通知。
 * 落库、缓存、配额都注入进来，所以测试可以用假 handler 把时序跑一遍，一个 HTTP 都不发。
 */

import { QuotaExceededError } from './types.ts';

export interface CommuteQueueOptions {
  /** 真正干活的函数；抛错即视为该单失败（由 onFailure 落库） */
  handler: (orderId: number) => Promise<void>;
  /** 每单之间的间隔，默认 400ms（见文件头：300ms 会顶到个人 Key 的 3 次/秒） */
  intervalMs?: number;
  /** 失败后等多久重试，默认 800ms */
  retryDelayMs?: number;
  /** 重试次数，默认 1 次（即最多跑 2 次） */
  retries?: number;
  /** 每次开跑前问一句「还能继续吗」，通常看配额 */
  canRun?: () => boolean;
  /** 配额撞墙时回调一次，用于置状态位给前端提示 */
  onQuotaExhausted?: () => void;
  /** 重试后仍失败 */
  onFailure?: (orderId: number, error: Error) => void;
  /** 注入 sleep，测试里立刻返回，不必真等 300ms */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CommuteQueue {
  private readonly opts: Required<Omit<CommuteQueueOptions, 'onQuotaExhausted' | 'onFailure' | 'canRun'>> &
    Pick<CommuteQueueOptions, 'onQuotaExhausted' | 'onFailure' | 'canRun'>;

  private ids: number[] = [];
  /** 排队中（还没轮到） */
  private waiting = new Set<number>();
  /** 正在跑（避免同一单被重复入队两遍） */
  private inFlight = new Set<number>();
  private running = false;
  private stopRequested = false;
  private quotaHit = false;
  private lastError: string | null = null;

  constructor(options: CommuteQueueOptions) {
    // 注意顺序：sleep 要在展开之后兜底，否则 service 里 `sleep: undefined` 会把真实实现冲成 undefined
    this.opts = {
      intervalMs: 400,
      retryDelayMs: 800,
      retries: 1,
      ...options,
      sleep: options.sleep ?? realSleep,
    };
  }

  /** 入队，返回真正新增的条数（已在队列里的不重复加） */
  enqueue(orderIds: number[]): number {
    let added = 0;
    for (const id of orderIds) {
      if (this.waiting.has(id) || this.inFlight.has(id)) continue;
      this.waiting.add(id);
      this.ids.push(id);
      added++;
    }
    if (added > 0 && !this.running) void this.loop();
    return added;
  }

  size(): number {
    return this.ids.length;
  }

  isBusy(): boolean {
    return this.running;
  }

  quotaExhausted(): boolean {
    return this.quotaHit;
  }

  lastFailure(): string | null {
    return this.lastError;
  }

  /** 清空待办（例如用户改了出发地，旧出发地的结果全部作废） */
  clear(): void {
    this.ids = [];
    this.waiting.clear();
    this.stopRequested = true;
  }

  private async loop(): Promise<void> {
    this.running = true;
    this.stopRequested = false;
    try {
      while (this.ids.length && !this.stopRequested) {
        if (this.opts.canRun && !this.opts.canRun()) {
          this.haltForQuota();
          break;
        }
        const id = this.ids.shift()!;
        this.waiting.delete(id);
        this.inFlight.add(id);
        try {
          await this.runWithRetry(id);
        } finally {
          this.inFlight.delete(id);
        }
        if (this.ids.length && !this.stopRequested) await this.opts.sleep(this.opts.intervalMs);
      }
    } finally {
      this.running = false;
    }
  }

  private async runWithRetry(id: number): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await this.opts.handler(id);
        return;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.lastError = err.message;
        // 配额撞墙是「今天到此为止」，再重试只会更快烧完
        if (err instanceof QuotaExceededError) {
          this.opts.onFailure?.(id, err);
          this.haltForQuota();
          return;
        }
        if (attempt >= this.opts.retries) {
          this.opts.onFailure?.(id, err);
          return;
        }
        attempt++;
        await this.opts.sleep(this.opts.retryDelayMs);
      }
    }
  }

  private haltForQuota(): void {
    this.quotaHit = true;
    this.ids = [];
    this.waiting.clear();
    this.opts.onQuotaExhausted?.();
  }

  /** 测试用：等队列自然跑空 */
  async drain(): Promise<void> {
    while (this.running || this.ids.length) await realSleep(0);
  }
}
