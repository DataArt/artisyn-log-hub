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
import {
  AllowedAuthModes,
  AuthModeGuard,
} from '../auth/guards/auth-mode.guard';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AdminService } from './admin.service';
import type { CreateAdminUserResponse } from './admin.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';

type AuthUser = { id: number; role: 'admin' | 'user' };

/**
 * Admin-provisioned accounts — auth mode `strict-managed` only. `AuthModeGuard`
 * runs first, so every caller (anonymous, user, admin) gets 404 in other modes.
 * The email limit is counted per calling admin, not per IP.
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
    const caller = req.user as AuthUser;
    return this.adminService.createProvisionedUser(dto, caller.id);
  }

  @Post(':id/password-link')
  @HttpCode(200)
  @AllowedAuthModes('strict-managed')
  sendPasswordLink(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const caller = req.user as AuthUser;
    return this.adminService.sendPasswordLink(id, caller.id);
  }
}
