import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { clientIp } from '../auth/client-ip';
import {
  AllowedAuthModes,
  AuthModeGuard,
} from '../auth/guards/auth-mode.guard';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AdminService } from './admin.service';
import type { CreateAdminUserResponse } from './admin.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';

/**
 * Admin-provisioned accounts — auth mode `strict-managed` only. `AuthModeGuard`
 * runs first, so every caller (anonymous, user, admin) gets 404 in other modes.
 */
@Controller('api/v1/admin/users')
@UseGuards(AuthModeGuard, SessionAuthGuard, AdminGuard)
export class AdminUserProvisioningController {
  constructor(private readonly adminService: AdminService) {}

  @Post()
  @HttpCode(201)
  @AllowedAuthModes('strict-managed')
  createUser(
    @Req() req: Request,
    @Body() dto: CreateAdminUserDto,
  ): Promise<CreateAdminUserResponse> {
    return this.adminService.createProvisionedUser(dto, clientIp(req));
  }

  @Post(':id/password-link')
  @HttpCode(200)
  @AllowedAuthModes('strict-managed')
  sendPasswordLink(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.adminService.sendPasswordLink(id, clientIp(req));
  }
}
