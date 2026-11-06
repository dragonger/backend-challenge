import { Logger } from '@nestjs/common';

/**
 * Runs `tick` repeatedly until stopped. `tick` returns true when it found work
 * (the next tick starts immediately) and false when idle (sleep `intervalMs`).
 * An exception never kills the loop: it is logged and the loop backs off.
 * `stop()` interrupts the sleep and waits for the tick in progress to finish,
 * which is what graceful shutdown needs.
 */
export class PollingLoop {
  private readonly logger: Logger;
  private running: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<boolean>,
    private readonly intervalMs: number,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.stopping = false;
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = undefined;
  }

  private async loop(): Promise<void> {
    let failures = 0;

    while (!this.stopping) {
      let again = false;

      try {
        again = await this.tick();
        failures = 0;
      } catch (error) {
        failures += 1;
        this.logger.error(
          `${this.name} tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!again && !this.stopping) {
        // Back off further while failing, capped at 10 intervals.
        await this.sleep(this.intervalMs * Math.min(10, 1 + failures));
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);

      function done(): void {
        clearTimeout(timer);
        resolve();
      }

      this.wake = done;
    });
  }
}
