import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PointAlertService } from './point-alert.service';

const INTERVAL_MS = 60_000;

/** 每分钟核对点卡余额，跌破 100 / 10 时由服务端推一次。 */
@Injectable()
export class PointAlertWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PointAlertWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private boot: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;

  constructor(private alerts: PointAlertService) {}

  onModuleInit() {
    this.boot = setTimeout(() => void this.tick(), 15_000);
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.logger.log('PointAlertWorker 已启动: 间隔=60秒；同时低于100与10只推更低档(10)')
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.boot) clearTimeout(this.boot);
    if (this.timer) clearInterval(this.timer);
    this.boot = null;
    this.timer = null;
  }

  private async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      await this.alerts.scan();
    } catch (e: any) {
      this.logger.warn(`点卡余额推送扫描失败: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
