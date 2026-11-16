import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import {
  AllowedAuthModes,
  AuthModeGuard,
} from '../auth/guards/auth-mode.guard';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { getRequestBaseUrl } from '../common/request-base-url';
import { UsersService } from '../users/users.service';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';

type AuthUser = { id: number; role: 'admin' | 'user' };

@Controller('api/v1/users')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  @Patch(':userId/role')
  async updateUserRole(
    @Req() req: Request,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateUserRoleDto,
  ) {
    const caller = req.user as AuthUser;

    if (caller.id === userId) {
      throw new BadRequestException('Cannot change your own role');
    }

    if (dto.role === 'user') {
      const adminCount = await this.usersService.countAdmins();
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot remove the last admin');
      }
    }

    return this.usersService.updateRole(userId, dto.role);
  }

  /** Not in strict-managed: there an admin sends an emailed link instead (404). */
  @Post(':userId/reset-password-link')
  @HttpCode(200)
  @AllowedAuthModes('none', 'password', 'password-confirm', 'azure-oauth')
  @UseGuards(AuthModeGuard)
  async generateResetPasswordLink(
    @Req() req: Request,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    const resetUrl = await this.authService.adminGenerateResetLink(
      getRequestBaseUrl(req),
      userId,
    );
    return { resetUrl };
  }
}
