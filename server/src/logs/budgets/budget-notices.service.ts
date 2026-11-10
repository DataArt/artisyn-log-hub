/**
 * Budget threshold notices (2026-11-05 budgets-threshold-alerts, DD-10 / DD-11 / DD-15 / DD-21):
 * the threshold job's writes (notices, recipients, `threshold_*` and `email_*` events, emails)
 * and the per-user tray (list, unread count, read marks).
 *
 * The job runs in every cluster worker. The unique key `(budget_id, period_start, threshold)` is
 * the dedup: only the worker whose `INSERT … ON CONFLICT DO NOTHING RETURNING` got the shown
 * notice's id back writes its recipients and events, and sends the emails after the commit.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { getEmailLinkBaseUrl } from '../../common/public-base-url';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import {
  budgetNoticeRecipients,
  budgetNotices,
  teamMembers,
  teams,
  users,
} from '../../database/schema';
import { MailService } from '../../mail/mail.service';
import { BUDGET_MIN_OFFSET, BUDGET_NOTICES_PAGE } from './budget.constants';
import { insertBudgetEvent } from './budget-events.sql';
import { selectThresholdNotices } from './budget-math';
import {
  budgetLabel,
  periodLabel,
  scopeLabel,
  scopeOfBudget,
  type BudgetScope,
} from './budget-scope';
import type {
  BudgetNoticeDto,
  BudgetNoticeLink,
  BudgetPeriod,
  BudgetRow,
  BudgetScopeKind,
  PeriodBounds,
} from './budgets.types';

export interface NoticeRecipient {
  userId: number;
  email: string;
}

export interface BudgetNoticesPage {
  items: BudgetNoticeDto[];
  unreadCount: number;
  nextBefore: number | null;
}

export type MarkReadInput = { ids: number[] } | { all: true };

/** One recipient row joined to its notice, with the DD-15 link parts resolved in SQL. */
interface NoticeRecipientRow {
  noticeId: number;
  recipientUserId: number;
  recipientEmail: string;
  readAt: Date | null;
  createdAt: Date;
  scopeKind: BudgetScopeKind;
  scopeUserId: number | null;
  teamId: number | null;
  teamName: string | null;
  repoUrl: string | null;
  budgetLabel: string;
  period: BudgetPeriod;
  amountMicros: number;
  timeZone: string;
  periodStart: Date;
  periodEnd: Date;
  threshold: number;
  spendMicros: number;
  repoId: number | null;
  rawOffset: number;
}

/** The scope of a notice's snapshot columns, or `null` for an impossible shape. */
function scopeOfNotice(row: NoticeRecipientRow): BudgetScope | null {
  if (row.scopeKind === 'repo' && row.scopeUserId != null && row.repoUrl) {
    return { kind: 'repo', userId: row.scopeUserId, repoUrl: row.repoUrl };
  }
  if (row.scopeKind === 'team-repo' && row.teamId != null && row.repoUrl) {
    return { kind: 'team-repo', teamId: row.teamId, repoUrl: row.repoUrl };
  }
  if (row.scopeKind === 'team' && row.teamId != null) {
    return { kind: 'team', teamId: row.teamId };
  }
  return null;
}

/** The DD-15 link of a notice for one recipient. */
function noticeLink(row: NoticeRecipientRow): BudgetNoticeLink {
  const offset = Math.max(BUDGET_MIN_OFFSET, Math.min(0, row.rawOffset));
  const link: BudgetNoticeLink = { period: row.period, offset };
  if (row.scopeKind !== 'repo' && row.teamId != null) link.teamId = row.teamId;
  // A team-wide budget links to the team Spend tab; a repository one to the repository page,
  // or — with no repository row to open — to the team Spend tab as well.
  if (row.scopeKind !== 'team' && row.repoId != null) link.repoId = row.repoId;
  return link;
}

/**
 * The client hash route of a notice link (the server twin of the client `budgetNoticeHref`),
 * used for emails. `null` when there is nothing to open (a personal scope with no repo row).
 */
export function noticeLinkPath(link: BudgetNoticeLink): string | null {
  const q = `sp=${link.period}&so=${link.offset}`;
  if (link.teamId != null && link.repoId != null) {
    return `/teams/${link.teamId}/repos/${link.repoId}?mtab=spend&${q}`;
  }
  if (link.repoId != null) return `/repos/${link.repoId}?mtab=spend&${q}`;
  if (link.teamId != null) return `/teams/${link.teamId}?ttab=spend&${q}`;
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class BudgetNoticesService {
  private readonly logger = new Logger(BudgetNoticesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly mailService: MailService,
  ) {}

  // ── Recipients ─────────────────────────────────────────────────────────────────────────────

  /**
   * Who gets a shown notice (DD-10): the owner for a personal repository budget; the team owner
   * plus the team's managers (`team_members.is_manager`) for team kinds.
   */
  async resolveNoticeRecipients(
    scope: BudgetScope,
  ): Promise<NoticeRecipient[]> {
    if (scope.kind === 'repo') {
      return this.db
        .select({ userId: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, scope.userId));
    }
    return this.db
      .select({ userId: users.id, email: users.email })
      .from(users)
      .where(
        or(
          inArray(
            users.id,
            this.db
              .select({ id: teams.ownerId })
              .from(teams)
              .where(eq(teams.id, scope.teamId)),
          ),
          inArray(
            users.id,
            this.db
              .select({ id: teamMembers.userId })
              .from(teamMembers)
              .where(
                and(
                  eq(teamMembers.teamId, scope.teamId),
                  eq(teamMembers.isManager, true),
                ),
              ),
          ),
        ),
      )
      .orderBy(users.id);
  }

  // ── Threshold job writes ───────────────────────────────────────────────────────────────────

  /**
   * Records the thresholds `spendMicros` newly crossed in the budget's current period (DD-7 /
   * DD-10 / DD-11): one shown notice (with recipients and a `threshold_crossed` event) and any
   * superseded ones (`threshold_superseded` events), in one transaction. The worker that inserted
   * the shown notice then sends its emails.
   */
  async recordCrossings(
    budget: BudgetRow,
    spendMicros: number,
    bounds: PeriodBounds,
  ): Promise<void> {
    const existingRows = await this.db
      .select({ threshold: budgetNotices.threshold })
      .from(budgetNotices)
      .where(
        and(
          eq(budgetNotices.budgetId, budget.id),
          eq(budgetNotices.periodStart, bounds.start),
        ),
      );
    const selection = selectThresholdNotices({
      thresholds: budget.thresholds,
      spendMicros,
      amountMicros: budget.amountMicros,
      existing: existingRows.map((r) => r.threshold),
    });
    if (selection.notify === null && selection.superseded.length === 0) {
      return;
    }

    const scope = scopeOfBudget(budget);
    const recipients =
      selection.notify === null
        ? []
        : await this.resolveNoticeRecipients(scope);
    const snapshot = {
      budgetId: budget.id,
      scopeKind: budget.scopeKind,
      userId: budget.userId,
      teamId: budget.teamId,
      repoUrl: budget.repoUrl,
      budgetLabel: budgetLabel(budget.period, budget.amountMicros),
      period: budget.period,
      amountMicros: budget.amountMicros,
      timeZone: budget.timeZone,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      spendMicros,
    };
    const periodStart = bounds.start.toISOString();

    const shownId = await this.db.transaction(async (tx) => {
      let shown: number | null = null;
      if (selection.notify !== null) {
        const [row] = await tx
          .insert(budgetNotices)
          .values({ ...snapshot, threshold: selection.notify })
          .onConflictDoNothing()
          .returning({ id: budgetNotices.id });
        if (row) {
          shown = row.id;
          if (recipients.length > 0) {
            await tx
              .insert(budgetNoticeRecipients)
              .values(
                recipients.map((r) => ({ noticeId: row.id, userId: r.userId })),
              )
              .onConflictDoNothing();
          }
          await insertBudgetEvent(tx, {
            budget,
            eventType: 'threshold_crossed',
            details: {
              threshold: selection.notify,
              spendMicros,
              periodStart,
            },
            actor: null,
          });
        }
      }
      for (const s of selection.superseded) {
        const [row] = await tx
          .insert(budgetNotices)
          .values({
            ...snapshot,
            threshold: s.threshold,
            supersededBy: s.supersededBy,
          })
          .onConflictDoNothing()
          .returning({ id: budgetNotices.id });
        if (!row) continue;
        await insertBudgetEvent(tx, {
          budget,
          eventType: 'threshold_superseded',
          details: {
            threshold: s.threshold,
            spendMicros,
            periodStart,
            supersededBy: s.supersededBy,
          },
          actor: null,
        });
      }
      return shown;
    });

    if (shownId !== null && selection.notify !== null) {
      await this.sendNoticeEmails(budget, shownId, scope, bounds);
    }
  }

  /**
   * Emails a just-committed shown notice to its recipients and logs the outcome (DD-10):
   * `email_sent` / `email_failed` per recipient, or one `email_skipped` when mail is not
   * configured. Failures here never undo the notice.
   */
  private async sendNoticeEmails(
    budget: BudgetRow,
    noticeId: number,
    scope: BudgetScope,
    bounds: PeriodBounds,
  ): Promise<void> {
    try {
      if (!this.mailService.isConfigured()) {
        await this.logEmailEvent(budget, 'email_skipped', { noticeId });
        return;
      }
      const rows = await this.noticeRecipientRows(
        eq(budgetNoticeRecipients.noticeId, noticeId),
      );
      if (rows.length === 0) return;
      const base = getEmailLinkBaseUrl(this.logger);
      const label = periodLabel(bounds);
      for (const row of rows) {
        const path = noticeLinkPath(noticeLink(row));
        const link = base !== null && path !== null ? `${base}/#${path}` : null;
        const delivery = await this.mailService.sendBudgetNoticeEmail(
          row.recipientEmail,
          {
            scopeLabel: scopeLabel(scope, row.teamName),
            budgetLabel: row.budgetLabel,
            threshold: row.threshold,
            spendMicros: row.spendMicros,
            amountMicros: row.amountMicros,
            periodLabel: label,
            link,
          },
        );
        await this.logEmailEvent(
          budget,
          delivery === 'sent' ? 'email_sent' : 'email_failed',
          delivery === 'sent'
            ? { noticeId, recipientEmail: row.recipientEmail }
            : {
                noticeId,
                recipientEmail: row.recipientEmail,
                error: 'SMTP delivery failed',
              },
        );
      }
    } catch (err) {
      this.logger.error(
        `Budget ${budget.id}: sending notice ${noticeId} emails failed: ${errorMessage(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  /** Writes one `email_*` event; a budget deleted meanwhile (FK) is logged, not thrown. */
  private async logEmailEvent(
    budget: BudgetRow,
    eventType: 'email_sent' | 'email_failed' | 'email_skipped',
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await insertBudgetEvent(this.db, {
        budget,
        eventType,
        details,
        actor: null,
      });
    } catch (err) {
      this.logger.warn(
        `Budget ${budget.id}: could not write ${eventType} event: ${errorMessage(err)}`,
      );
    }
  }

  // ── Tray ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Recipient rows joined to their notices, newest notice first. `repoId` is the recipient's own
   * `repositories` row for the URL, else (personal scope) the owner's, else (team repository)
   * the lowest id among the team owner's and members' rows with that URL (DD-15). `rawOffset`
   * is the notice period's offset from the current period in the notice's time zone.
   */
  private async noticeRecipientRows(
    where: SQL | undefined,
    page?: { limit: number },
  ): Promise<NoticeRecipientRow[]> {
    const n = budgetNotices;
    const r = budgetNoticeRecipients;
    const local = sql`(${n.periodStart} AT TIME ZONE ${n.timeZone})`;
    const now = sql`(now() AT TIME ZONE ${n.timeZone})`;
    const query = this.db
      .select({
        noticeId: r.noticeId,
        recipientUserId: r.userId,
        recipientEmail: users.email,
        readAt: r.readAt,
        createdAt: n.createdAt,
        scopeKind: n.scopeKind,
        scopeUserId: n.userId,
        teamId: n.teamId,
        teamName: teams.name,
        repoUrl: n.repoUrl,
        budgetLabel: n.budgetLabel,
        period: n.period,
        amountMicros: n.amountMicros,
        timeZone: n.timeZone,
        periodStart: n.periodStart,
        periodEnd: n.periodEnd,
        threshold: n.threshold,
        spendMicros: n.spendMicros,
        repoId: sql<number | null>`COALESCE(
          (SELECT MIN(rp.id) FROM repositories rp
            WHERE rp.user_id = ${r.userId} AND rp.repo_url = ${n.repoUrl}),
          CASE
            WHEN ${n.scopeKind} = 'repo' THEN (
              SELECT MIN(rp.id) FROM repositories rp
              WHERE rp.user_id = ${n.userId} AND rp.repo_url = ${n.repoUrl})
            WHEN ${n.scopeKind} = 'team-repo' THEN (
              SELECT MIN(rp.id) FROM repositories rp
              WHERE rp.repo_url = ${n.repoUrl}
                AND (rp.user_id = ${teams.ownerId}
                  OR rp.user_id IN (
                    SELECT tm.user_id FROM team_members tm WHERE tm.team_id = ${n.teamId})))
          END)`.mapWith((v: unknown) => (v == null ? null : Number(v))),
        rawOffset: sql<number>`(CASE ${n.period}
          WHEN 'month' THEN
            (extract(year FROM ${local}) * 12 + extract(month FROM ${local}))
            - (extract(year FROM ${now}) * 12 + extract(month FROM ${now}))
          WHEN 'week' THEN
            ((${local})::date - (date_trunc('week', ${now}))::date) / 7
          ELSE (${local})::date - (${now})::date
        END)::int`.mapWith(Number),
      })
      .from(r)
      .innerJoin(n, eq(n.id, r.noticeId))
      .innerJoin(users, eq(users.id, r.userId))
      .leftJoin(teams, eq(teams.id, n.teamId))
      .where(where)
      .orderBy(desc(r.noticeId));
    return page ? query.limit(page.limit) : query;
  }

  private async unreadCount(userId: number): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(budgetNoticeRecipients)
      .where(
        and(
          eq(budgetNoticeRecipients.userId, userId),
          isNull(budgetNoticeRecipients.readAt),
        ),
      );
    return row?.n ?? 0;
  }

  /** The caller's notices, newest first, one page at a time (`before` = previous `nextBefore`). */
  async listForUser(
    userId: number,
    q: { before?: number; limit?: number },
  ): Promise<BudgetNoticesPage> {
    const limit = Math.max(
      1,
      Math.min(
        BUDGET_NOTICES_PAGE.max,
        Math.trunc(q.limit ?? BUDGET_NOTICES_PAGE.default),
      ),
    );
    const rows = await this.noticeRecipientRows(
      and(
        eq(budgetNoticeRecipients.userId, userId),
        q.before !== undefined
          ? lt(budgetNoticeRecipients.noticeId, q.before)
          : undefined,
      ),
      { limit: limit + 1 },
    );
    const pageRows = rows.slice(0, limit);
    const items: BudgetNoticeDto[] = pageRows.map((row) => {
      const scope = scopeOfNotice(row);
      return {
        id: row.noticeId,
        createdAt: row.createdAt.toISOString(),
        read: row.readAt !== null,
        threshold: row.threshold,
        spendMicros: row.spendMicros,
        amountMicros: row.amountMicros,
        budgetLabel: row.budgetLabel,
        scopeLabel: scope ? scopeLabel(scope, row.teamName) : '',
        period: row.period,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        link: noticeLink(row),
      };
    });
    return {
      items,
      unreadCount: await this.unreadCount(userId),
      nextBefore:
        rows.length > limit && pageRows.length > 0
          ? pageRows[pageRows.length - 1].noticeId
          : null,
    };
  }

  /**
   * Marks the caller's own notices read — the listed ids or all of them. Ids of other users'
   * notices match no row and are ignored. Returns the caller's remaining unread count.
   */
  async markRead(
    userId: number,
    input: MarkReadInput,
  ): Promise<{ unreadCount: number }> {
    const ids = 'ids' in input ? input.ids : null;
    if (ids === null || ids.length > 0) {
      await this.db
        .update(budgetNoticeRecipients)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(budgetNoticeRecipients.userId, userId),
            isNull(budgetNoticeRecipients.readAt),
            ids === null
              ? undefined
              : inArray(budgetNoticeRecipients.noticeId, ids),
          ),
        );
    }
    return { unreadCount: await this.unreadCount(userId) };
  }
}
