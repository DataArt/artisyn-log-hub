import { forwardRef, Module } from '@nestjs/common';
import { TeamAccessGuard } from '../common/guards/team-access.guard';
import { TeamOwnerGuard } from '../common/guards/team-owner.guard';
import { LogsModule } from '../logs/logs.module';
import { UsersModule } from '../users/users.module';
import { InvitationsController } from './invitations.controller';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { TeamRepoRecomputeService } from './team-repo-recompute.service';

@Module({
  imports: [UsersModule, forwardRef(() => LogsModule)],
  controllers: [TeamsController, InvitationsController],
  providers: [
    TeamsService,
    TeamRepoRecomputeService,
    TeamAccessGuard,
    TeamOwnerGuard,
  ],
  exports: [TeamsService],
})
export class TeamsModule {}
