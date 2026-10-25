import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import * as fs from 'fs';
import type { Request, Response } from 'express';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { ErrorLogsService } from '../error-logs/error-logs.service';
import { SystemInfoService } from '../system-info/system-info.service';
import { AccountDeletionService } from '../users/account-deletion.service';
import { UsersService } from '../users/users.service';
import { TransferOwnershipDto } from '../teams/dto/transfer-ownership.dto';
import { AdminService } from './admin.service';
import { DeleteUserDto } from './dto/delete-user.dto';
import { RenameUserEmailDto } from './dto/rename-user-email.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UploadQueueAdminService } from './upload-queue-admin.service';
import { UploadQueueStatsService } from './upload-queue-stats.service';

type AuthUser = { id: number; role: 'admin' | 'user' };

@Controller('api/v1/admin')
@UseGuards(SessionAuthGuard, AdminGuard)
export class AdminPanelController {
  private readonly logger = new Logger(AdminPanelController.name);

  constructor(
    private readonly adminService: AdminService,
    private readonly usersService: UsersService,
    private readonly systemInfoService: SystemInfoService,
    private readonly errorLogsService: ErrorLogsService,
    private readonly uploadQueueAdminService: UploadQueueAdminService,
    private readonly uploadQueueStatsService: UploadQueueStatsService,
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Get('repos')
  getRepos() {
    return this.adminService.getRepos();
  }

  @Get('system')
  getSystemInfo() {
    return this.systemInfoService.getSystemInfo();
  }

  @Get('error-logs')
  getErrorLogs() {
    return this.errorLogsService.getErrorLogs();
  }

  @Get('upload-queue')
  getUploadQueue() {
    return this.uploadQueueAdminService.listQueue();
  }

  @Delete('upload-queue/failed')
  @HttpCode(200)
  clearFailedUploadQueue() {
    return this.uploadQueueAdminService.clearFailed();
  }

  @Post('upload-queue/reprocess-failed')
  @HttpCode(200)
  reprocessFailedUploadQueue() {
    return this.uploadQueueAdminService.reprocessFailed();
  }

  /**
   * Worker load / throughput / latency stats for the Upload Queue tab's stats block.
   * A distinct static path from `@Get('upload-queue')`, so there is no route-order conflict.
   */
  @Get('upload-queue/stats')
  getUploadQueueStats() {
    return this.uploadQueueStatsService.getStats();
  }

  /**
   * Downloads the staged file behind one upload-queue row (typically a failed
   * one), so an admin can inspect the raw payload that failed to process.
   */
  @Get('upload-queue/:id/file')
  async downloadUploadQueueFile(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const file = await this.uploadQueueAdminService.resolveStagedFile(id);
    if (!file) {
      throw new NotFoundException('Staged file not found');
    }
    res.download(file.filePath, file.fileName, (err) => {
      if (err) {
        this.logger.warn(
          `Upload-queue file download failed for id=${id}: ${err.message}`,
        );
      }
    });
  }

  @Get('logs-archive')
  async downloadLogsArchive(@Res() res: Response) {
    const { filePath, fileName } =
      await this.systemInfoService.createLogsArchive();

    res.download(filePath, fileName, (err) => {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          this.logger.warn(
            `Failed to remove temp logs archive ${filePath}: ${unlinkErr.message}`,
          );
        }
      });
      if (err) {
        this.logger.warn(`Logs archive download failed: ${err.message}`);
      }
    });
  }

  @Delete('repos/:id')
  @HttpCode(204)
  async removeRepo(@Param('id', ParseIntPipe) id: number) {
    await this.adminService.removeRepo(id);
  }

  /** Orphan team link only (no `repositories` row for its URL) — 404 otherwise. */
  @Delete('team-repos/:teamRepoId')
  @HttpCode(204)
  async removeOrphanTeamRepo(
    @Param('teamRepoId', ParseIntPipe) teamRepoId: number,
  ) {
    await this.adminService.removeOrphanTeamRepo(teamRepoId);
  }

  @Get('teams')
  getTeams() {
    return this.adminService.getTeams();
  }

  /** Member identity only (no session data) — backs the "Set new owner" picker. */
  @Get('teams/:teamId/members')
  getTeamMembers(@Param('teamId', ParseIntPipe) teamId: number) {
    return this.adminService.getTeamMembers(teamId);
  }

  /** FR-8: any admin may hand a team to one of its current members. */
  @Post('teams/:teamId/owner')
  @HttpCode(200)
  setTeamOwner(
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.adminService.setTeamOwner(teamId, dto.userId);
  }

  @Get('auth')
  getAuthConfig() {
    return this.adminService.getAuthConfig();
  }

  @Get('auth/pending-registrations')
  getPendingRegistrations() {
    return this.adminService.getPendingRegistrations();
  }

  @Post('auth/pending-registrations/:id/resend')
  @HttpCode(200)
  resendPendingRegistration(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.resendPendingRegistration(id);
  }

  @Delete('auth/pending-registrations/:id')
  @HttpCode(204)
  async revokePendingRegistration(@Param('id', ParseIntPipe) id: number) {
    await this.adminService.revokePendingRegistration(id);
  }

  @Get('users')
  getUsers() {
    return this.adminService.getUsers();
  }

  @Patch('users/:id/role')
  async updateUserRole(
    @Req() req: Request,
    @Param('id', ParseIntPipe) userId: number,
    @Body() dto: UpdateUserRoleDto,
  ) {
    const caller = req.user as AuthUser;

    if (caller.id === userId) {
      throw new BadRequestException('Cannot change your own role');
    }

    const target = await this.usersService.findById(userId);
    if (target == null) {
      throw new NotFoundException('User not found');
    }

    if (dto.role === 'user') {
      const adminCount = await this.usersService.countAdmins();
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot remove the last admin');
      }
    }

    const updated = await this.usersService.updateRole(userId, dto.role);

    if (updated == null) {
      throw new NotFoundException('User not found');
    }

    return updated;
  }

  @Patch('users/:id/email')
  async renameUserEmail(
    @Param('id', ParseIntPipe) userId: number,
    @Body() dto: RenameUserEmailDto,
  ) {
    const email = dto.email.toLowerCase();
    const existing = await this.usersService.findByEmail(email);

    if (existing && existing.id !== userId) {
      throw new ConflictException('Email already in use');
    }

    const updated = await this.usersService.renameEmail(userId, email);

    if (updated == null) {
      throw new NotFoundException('User not found');
    }

    return updated;
  }

  /**
   * Hard-deletes another user's account and all of their data.
   * POST rather than DELETE because it carries a confirmation body that is
   * re-validated here.
   */
  @Post('users/:id/delete')
  @HttpCode(204)
  async deleteUser(
    @Req() req: Request,
    @Param('id', ParseIntPipe) userId: number,
    @Body() dto: DeleteUserDto,
  ): Promise<void> {
    const caller = req.user as AuthUser;

    if (caller.id === userId) {
      // Self-deletion goes through POST /api/v1/auth/delete-account, which also
      // signs the caller out — doing it here would leave a live session bound to
      // a user row that no longer exists.
      throw new BadRequestException('Cannot delete your own account here');
    }

    const target = await this.usersService.findById(userId);
    if (target == null) {
      throw new NotFoundException('User not found');
    }

    if (dto.confirmEmail.trim().toLowerCase() !== target.email.toLowerCase()) {
      throw new BadRequestException(
        'Confirmation email does not match the user being deleted',
      );
    }

    await this.accountDeletionService.hardDeleteUser(userId, {
      actingUserId: caller.id,
      via: 'admin',
    });
  }
}
