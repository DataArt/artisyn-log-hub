import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { SetUserSettingDto } from './dto/set-user-setting.dto';
import { UserSettingsService } from './user-settings.service';

const SETTING_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Generic per-user settings CRUD. The owning user is always taken from the
 * session — no route parameter or body field can target another user's rows.
 */
@Controller('api/v1/user-settings')
@UseGuards(SessionAuthGuard)
export class UserSettingsController {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  private getUserId(req: Request): number {
    const user = req.user as { id: number };
    return user.id;
  }

  private assertValidName(name: string): string {
    if (!SETTING_NAME_PATTERN.test(name)) {
      throw new BadRequestException(
        'setting name must match /^[A-Za-z0-9._-]{1,100}$/',
      );
    }
    return name;
  }

  @Get()
  list(@Req() req: Request) {
    return this.userSettingsService.list(this.getUserId(req));
  }

  @Get(':name')
  get(@Req() req: Request, @Param('name') name: string) {
    return this.userSettingsService.get(
      this.getUserId(req),
      this.assertValidName(name),
    );
  }

  @Put(':name')
  set(
    @Req() req: Request,
    @Param('name') name: string,
    @Body() dto: SetUserSettingDto,
  ) {
    return this.userSettingsService.set(
      this.getUserId(req),
      this.assertValidName(name),
      dto.value,
    );
  }

  @Delete(':name')
  @HttpCode(204)
  remove(@Req() req: Request, @Param('name') name: string) {
    return this.userSettingsService.remove(
      this.getUserId(req),
      this.assertValidName(name),
    );
  }
}
