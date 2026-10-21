import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { TeamAccessGuard } from '../common/guards/team-access.guard';
import { TeamOwnerGuard } from '../common/guards/team-owner.guard';
import { AcknowledgeDisclosureDto } from './dto/acknowledge-disclosure.dto';
import { AddRepoDto } from './dto/add-repo.dto';
import { CreateTeamDto } from './dto/create-team.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { TeamsService } from './teams.service';

type AuthUser = { id: number; role: 'admin' | 'user' };

@Controller('api/v1/teams')
@UseGuards(SessionAuthGuard)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Post()
  @HttpCode(201)
  createTeam(@Req() req: Request, @Body() dto: CreateTeamDto) {
    const user = req.user as AuthUser;
    return this.teamsService.createTeam(user.id, dto.name);
  }

  @Get()
  listTeams(@Req() req: Request) {
    const user = req.user as AuthUser;
    return this.teamsService.listTeams(user.id);
  }

  /**
   * MUST stay declared before `@Get(':teamId')` below — Nest matches routes in
   * declaration order, so a later literal would be swallowed by the parametric
   * route and rejected by its `ParseIntPipe` with a 400.
   */
  @Get('pending-disclosures')
  listPendingDisclosures(@Req() req: Request) {
    const user = req.user as AuthUser;
    return this.teamsService.listPendingDisclosures(user.id);
  }

  @Get(':teamId')
  @UseGuards(TeamAccessGuard)
  getTeam(@Req() req: Request, @Param('teamId', ParseIntPipe) teamId: number) {
    const user = req.user as AuthUser;
    return this.teamsService.getTeam(teamId, user.id);
  }

  @Patch(':teamId')
  @UseGuards(TeamOwnerGuard)
  updateTeam(
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.teamsService.updateTeam(teamId, dto);
  }

  @Delete(':teamId')
  @HttpCode(204)
  @UseGuards(TeamOwnerGuard)
  async deleteTeam(@Param('teamId', ParseIntPipe) teamId: number) {
    await this.teamsService.deleteTeam(teamId);
  }

  @Get(':teamId/members')
  @UseGuards(TeamAccessGuard)
  getMembers(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    const user = req.user as AuthUser;
    return this.teamsService.getMembers(teamId, user);
  }

  @Patch(':teamId/members/:userId')
  @UseGuards(TeamOwnerGuard)
  updateMember(
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.teamsService.updateMember(teamId, userId, {
      canInvite: dto.canInvite,
      isManager: dto.isManager,
      isAdlcTrainer: dto.isAdlcTrainer,
    });
  }

  @Delete(':teamId/members/:userId')
  @HttpCode(204)
  @UseGuards(TeamOwnerGuard)
  async removeMember(
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    await this.teamsService.removeMember(teamId, userId);
  }

  @Post(':teamId/acknowledge-disclosure')
  @HttpCode(200)
  @UseGuards(TeamAccessGuard)
  acknowledgeDisclosure(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: AcknowledgeDisclosureDto,
  ) {
    const user = req.user as AuthUser;
    return this.teamsService.acknowledgeDisclosure(
      teamId,
      user.id,
      dto.acknowledgedAccessMode,
    );
  }

  @Post(':teamId/leave')
  @HttpCode(204)
  async leaveTeam(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    const user = req.user as AuthUser;
    await this.teamsService.leaveTeam(teamId, user.id);
  }

  @Post(':teamId/transfer')
  @UseGuards(TeamOwnerGuard)
  transferOwnership(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: TransferOwnershipDto,
  ) {
    const user = req.user as AuthUser;
    return this.teamsService.transferOwnership(teamId, user.id, dto.userId);
  }

  @Get(':teamId/repositories')
  @UseGuards(TeamAccessGuard)
  getTeamRepositories(@Param('teamId', ParseIntPipe) teamId: number) {
    return this.teamsService.getTeamRepositories(teamId);
  }

  @Post(':teamId/repositories')
  @HttpCode(201)
  @UseGuards(TeamOwnerGuard)
  addTeamRepository(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: AddRepoDto,
  ) {
    const user = req.user as AuthUser;
    return this.teamsService.addTeamRepository(teamId, dto.repoUrl, user.id);
  }

  @Delete(':teamId/repositories/:repoId/link')
  @HttpCode(204)
  @UseGuards(TeamOwnerGuard)
  async unlinkTeamRepository(
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('repoId', ParseIntPipe) repoId: number,
  ) {
    await this.teamsService.unlinkTeamRepository(teamId, repoId);
  }

  @Delete(':teamId/repositories/:repoId')
  @HttpCode(204)
  @UseGuards(TeamOwnerGuard)
  async removeTeamRepository(
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('repoId', ParseIntPipe) repoId: number,
  ) {
    await this.teamsService.removeTeamRepository(teamId, repoId);
  }

  @Post(':teamId/invitations')
  @HttpCode(201)
  @UseGuards(TeamAccessGuard)
  sendInvitation(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: InviteMemberDto,
  ) {
    const user = req.user as AuthUser;
    return this.teamsService.sendInvitation(
      teamId,
      user.id,
      dto.email,
      dto.force,
    );
  }

  @Delete(':teamId/invitations/:invId')
  @HttpCode(204)
  @UseGuards(TeamAccessGuard)
  async cancelInvitation(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('invId', ParseIntPipe) invId: number,
  ) {
    const user = req.user as AuthUser;
    await this.teamsService.cancelInvitation(teamId, invId, user.id);
  }
}
