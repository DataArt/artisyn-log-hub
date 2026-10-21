import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import * as schema from '../../database/schema';

@Injectable()
export class TeamAccessGuard implements CanActivate {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as { id: number } | undefined;
    const teamId = Number((request.params as Record<string, string>)['teamId']);

    const teams = await this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    const team = teams[0];
    if (!team) {
      throw new NotFoundException('Team not found');
    }

    // Attach team to request for downstream use
    (request as Request & { team: typeof team }).team = team;

    if (!user) {
      throw new ForbiddenException();
    }

    // Membership is the whole rule — the app admin role grants no bypass
    // (an admin manages teams only through the admin panel).
    const members = await this.db
      .select()
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, teamId),
          eq(schema.teamMembers.userId, user.id),
        ),
      );
    if (members.length > 0) {
      return true;
    }

    throw new ForbiddenException();
  }
}
