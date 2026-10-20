import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiKeyAuthGuard } from '../api-keys/api-key-auth.guard';

/**
 * `POST /api/v1/log-echo` — the API-key check the hooks installer calls
 * (`artisyn-hooks-installer/src/install.ts`). Log uploads go through
 * `POST /api/v2/logs` (`logs-v2.controller.ts`); the synchronous v1 upload route
 * was removed (open-source readiness).
 */
@Controller('api/v1')
export class LogsController {
  @Post('log-echo')
  @HttpCode(200)
  @UseGuards(ApiKeyAuthGuard)
  logEcho(): string {
    return 'OK';
  }
}
