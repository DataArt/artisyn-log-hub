import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { UpdateInvitationDto } from './dto/update-invitation.dto';
import { TeamsService } from './teams.service';

type AuthUser = { id: number; role: 'admin' | 'user' };

@Controller('api/v1/invitations')
@UseGuards(SessionAuthGuard)
export class InvitationsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Get()
  listInvitations(@Req() req: Request) {
    const user = req.user as AuthUser;
    return this.teamsService.listInvitations(user.id);
  }

  @Patch(':invId')
  @HttpCode(200)
  respondToInvitation(
    @Req() req: Request,
    @Param('invId', ParseIntPipe) invId: number,
    @Body() dto: UpdateInvitationDto,
  ) {
    const user = req.user as AuthUser;
    return this.teamsService.respondToInvitation(
      invId,
      user.id,
      dto.action,
      dto.acknowledgedAccessMode,
    );
  }
}
