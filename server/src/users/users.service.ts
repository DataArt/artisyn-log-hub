import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../database/database.constants';
import * as schema from '../database/schema';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async findByEmail(email: string) {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email.toLowerCase()));
    return rows[0] ?? null;
  }

  async create(
    email: string,
    passwordHash: string | null,
    role: 'admin' | 'user' = 'user',
  ) {
    const rows = await this.db
      .insert(schema.users)
      .values({ email: email.toLowerCase(), passwordHash, role })
      .returning();
    return rows[0];
  }

  /**
   * Used by Mode 1 (identify) and Mode 4 (OAuth callback) — the two places an
   * account can be created with no local password. Idempotent under a
   * concurrent-insert race: on a unique-constraint conflict (two simultaneous
   * requests for the same not-yet-existing email), re-fetches by email and
   * returns the winner's row instead of surfacing an error to either caller.
   */
  async findOrCreateAutoProvisioned(email: string) {
    const lowercased = email.toLowerCase();
    const existing = await this.findByEmail(lowercased);
    if (existing) return existing;

    const totalUsers = await this.countAll();
    const role = totalUsers === 0 ? 'admin' : 'user';

    try {
      return await this.create(lowercased, null, role);
    } catch (err) {
      const isUniqueViolation =
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === '23505';
      if (!isUniqueViolation) throw err;
      const winner = await this.findByEmail(lowercased);
      if (!winner) throw err;
      return winner;
    }
  }

  /**
   * Flips 'pending' invitations to 'accepted' for teams this user is already
   * a member of — the force-invite path in TeamsService.sendInvitation
   * grants team membership immediately but leaves the invitation 'pending' so
   * the inviter's Invitations tab reads like any other outstanding invite
   * until the invitee actually logs in. Called from each login entry point
   * (Mode 1 identify/auto-identify, Mode 4 OAuth callback) — deliberately NOT
   * from findOrCreateAutoProvisioned itself, since that is also called by the
   * *inviter* mid-invite (before the invitee has ever logged in), which would
   * flip the status too early. Lives here rather than on TeamsService to
   * avoid an Auth<->Teams circular module dependency; UsersService already
   * has direct schema access, so no new module edge is needed.
   */
  async acceptGrantedInvitations(userId: number): Promise<void> {
    const memberships = await this.db
      .select({ teamId: schema.teamMembers.teamId })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.userId, userId));
    if (memberships.length === 0) return;

    await this.db
      .update(schema.invitations)
      .set({ status: 'accepted' })
      .where(
        and(
          eq(schema.invitations.inviteeId, userId),
          eq(schema.invitations.status, 'pending'),
          inArray(
            schema.invitations.teamId,
            memberships.map((m) => m.teamId),
          ),
        ),
      );
  }

  async findById(id: number) {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id));
    return rows[0] ?? null;
  }

  async countAll(): Promise<number> {
    const rows = await this.db.select({ value: count() }).from(schema.users);
    return rows[0]?.value ?? 0;
  }

  async countAdmins(): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(schema.users)
      .where(eq(schema.users.role, 'admin'));
    return rows[0]?.value ?? 0;
  }

  async updateRole(userId: number, role: 'admin' | 'user') {
    // Explicit column list — a bare .returning() would expose passwordHash to
    // the controllers, which return this row in the response body.
    const rows = await this.db
      .update(schema.users)
      .set({ role })
      .where(eq(schema.users.id, userId))
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      });
    return rows[0];
  }

  async renameEmail(userId: number, email: string) {
    // Explicit column list — a bare .returning() would expose passwordHash to
    // the controllers, which return this row in the response body.
    const rows = await this.db
      .update(schema.users)
      .set({ email: email.toLowerCase() })
      .where(eq(schema.users.id, userId))
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      });
    return rows[0];
  }

  async findAll() {
    return this.db.select().from(schema.users);
  }

  /**
   * Atomic revoke: only deletes a still-unconfirmed account. Returns the
   * deleted row's id, or null if the row no longer exists / was already
   * confirmed (email_confirmation_tokens rows cascade-delete via their FK).
   */
  async deleteIfUnconfirmed(userId: number): Promise<number | null> {
    const rows = await this.db
      .delete(schema.users)
      .where(
        and(eq(schema.users.id, userId), isNull(schema.users.emailConfirmedAt)),
      )
      .returning({ id: schema.users.id });
    return rows[0]?.id ?? null;
  }

  async markEmailConfirmed(userId: number) {
    const rows = await this.db
      .update(schema.users)
      .set({ emailConfirmedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
        emailConfirmedAt: schema.users.emailConfirmedAt,
      });
    return rows[0];
  }

  async updatePassword(userId: number, passwordHash: string) {
    // Explicit column list — a bare .returning() would expose passwordHash to
    // the controllers, which return this row in the response body.
    const rows = await this.db
      .update(schema.users)
      .set({ passwordHash })
      .where(eq(schema.users.id, userId))
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      });
    return rows[0];
  }
}
