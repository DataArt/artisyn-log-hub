import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { Pool } from 'pg';
import type { BuildInfo, BuildOrigin } from '../common/build-info';
import { readBuildInfo, readBuildOrigin } from '../common/build-info';
import { PG_POOL } from '../database/database.constants';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.checkDatabase()]);
  }

  /**
   * Public (no auth) — lets the top nav show the running version to every user. `origin`
   * (from `build.origin.json`) is additive and omitted entirely when the file is absent.
   */
  @Get('version')
  getVersion(): BuildInfo & { origin?: BuildOrigin } {
    const origin = readBuildOrigin();
    return { ...readBuildInfo(), ...(origin ? { origin } : {}) };
  }

  private async checkDatabase(): Promise<HealthIndicatorResult> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      return { database: { status: 'up' } };
    } catch {
      return { database: { status: 'down' } };
    } finally {
      client.release();
    }
  }
}
