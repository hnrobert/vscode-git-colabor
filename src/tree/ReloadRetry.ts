/**
 * "Try again in a moment" for a reload whose CLI call failed — and nothing
 * more. The rules exist because the naive version loops: a retry is armed
 * only by a FAILURE, never by the reload event itself, and it fires at most
 * once per interval. So a failing CLI costs one extra attempt per interval
 * (two short-lived processes), a healthy one costs nothing.
 */
export class ReloadRetry {
  static readonly INTERVAL_MS = 5_000;

  private timer: NodeJS.Timeout | undefined;

  /** @param retry performs ONE reload attempt (its errors are the caller's business) */
  constructor(
    private readonly retry: () => void,
    private readonly intervalMs: number = ReloadRetry.INTERVAL_MS,
  ) {}

  get armed(): boolean {
    return this.timer !== undefined;
  }

  /**
   * A reload failed → try again after the interval. Several failures inside
   * one interval (UI refreshes still run and still fail) share the same
   * pending attempt.
   */
  arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined; // the attempt is now in flight; only ITS outcome decides what is next
      this.retry();
    }, this.intervalMs);
  }

  /** A reload succeeded → there is nothing left to retry. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
