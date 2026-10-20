import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from './guards/session-auth.guard';

@Controller('api/v1/ping')
export class PingController {
  @Get()
  @HttpCode(204)
  @UseGuards(SessionAuthGuard)
  ping(): void {}
}
