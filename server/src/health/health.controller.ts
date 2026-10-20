import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { Pool } from 'pg';
import type { BuildInfo } from '../common/build-info';
import { readBuildInfo } from '../common/build-info';
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

  /** Public (no auth) — lets the top nav show the running version to every user. */
  @Get('version')
  getVersion(): BuildInfo {
    return readBuildInfo();
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
