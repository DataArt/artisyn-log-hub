/**
 * Who may view / manage a budget scope (2026-11-05 budgets-threshold-alerts, DD-2).
 *
 * - `/repositories/:repoId/...` without `teamId` → the personal `repo` scope; only the
 *   `repositories` row owner passes (`assertRepoAccess`), and the owner manages it.
 * - `/repositories/:repoId/...?teamId=T` → the `team-repo` scope; any team member linked to the
 *   repository passes, the team owner and managers manage it.
 * - `/teams/:teamId/...` → the `team` scope; any team member passes (403 otherwise), the team
 *   owner and managers manage it.
 *
 * `fullView` is the team analytics gate (`TeamScope.analyticsAllowed`); a caller without it gets
 * the DD-9 restricted (own-spend) view.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { isOtelTeamMember } from '../otel/otel-facts-read.sql';
import { RepositoriesService, type AuthUser } from '../repositories.service';
import type { TeamScope } from '../team-scope';
import type { ScopeAccess } from './budget-scope';

function canManageTeam(teamScope: TeamScope): boolean {
  return teamScope.isTeamOwner || teamScope.isManager;
}

@Injectable()
export class BudgetAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
  ) {}

  /** The `repo` (no `teamId`) or `team-repo` scope of a repository route (DD-2). */
  async resolveRepoScope(
    user: AuthUser,
    repoId: number,
    teamId?: number,
  ): Promise<ScopeAccess> {
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const teamScope = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    if (teamId === undefined) {
      return {
        scope: { kind: 'repo', userId: repo.userId, repoUrl: repo.repoUrl },
        canManage: true,
        fullView: true,
        teamScope,
      };
    }
    return {
      scope: { kind: 'team-repo', teamId, repoUrl: repo.repoUrl },
      canManage: canManageTeam(teamScope),
      fullView: teamScope.analyticsAllowed,
      teamScope,
    };
  }

  /** The `team` scope of a team route (DD-2): 403 for a non-member. */
  async resolveTeamScope(user: AuthUser, teamId: number): Promise<ScopeAccess> {
    if (!(await isOtelTeamMember(this.db, teamId, user.id))) {
      throw new ForbiddenException();
    }
    const teamScope = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    return {
      scope: { kind: 'team', teamId },
      canManage: canManageTeam(teamScope),
      fullView: teamScope.analyticsAllowed,
      teamScope,
    };
  }

  /** 403 unless the caller may create / edit / delete the scope's budgets. */
  assertCanManage(access: ScopeAccess): void {
    if (!access.canManage) throw new ForbiddenException();
  }

  /** 403 unless the caller sees the whole scope (budgets list, events, sessions). */
  assertFullView(access: ScopeAccess): void {
    if (!access.fullView) throw new ForbiddenException();
  }
}
