// S-REPO-11. Import: a session conflict is settled by «the longer one wins»; a bootstrap import
// creates the repository and a team (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-11;
// no mode in the design → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). The «length» the merge compares is the
// number of lines of each log body (`jsonb_array_length`); turns are counted the same way here.
//
// Code facts that differ from the design text:
//   - a session is one global row: importing S1 into another repository of the same server links
//     the same log rows to it instead of creating a second copy, so «B with S1 in 3 turns» next to
//     «A with S1 in 5 turns» cannot exist. The «longer overwrites» case is reached the way it
//     happens in practice: the hook re-sends a shorter log of S1 (an upload replaces the body),
//     then a longer archive is imported;
//   - an import job reports only `processed`/`total`, no «skipped / overwritten» counters: the
//     outcome is read from the stored body (line count, `updated_at`);
//   - step 6: a bootstrap import by a user who already has a repository with
//     `meta.sourceRepoUrl` reuses it; a new repository is created for a user who has none;
//   - step 7: every bootstrap import resolves or creates the caller's team
//     `Imported: <repoUrl>` (`TeamsService.resolveOrCreateImportTeam`), whatever
//     `meta.sourceRepoContext` says; team names are unique across the server, so a second user's
//     team gets the suffix « (2)».
//
// Ownership conflicts (docs/knowledgebase/session-export-import.md): every import upload and
// confirm runs a pre-check as the importer (no admin bypass). Outside mode A an archive is refused
// with 409 `{ message, conflicts: [{ sessionId, reason }] }` when one of its sessions exists with
// another user's logs (`foreign-session`), names a registered other user as author
// (`foreign-author`) or hangs under another user's parent (`foreign-parent`); a refused staged
// upload can never be confirmed (404 with the same message). Mode A (`AUTH_MODE=none`) is
// single-user: there are no checks, no placeholder authors, and every imported session is
// reassigned to the importer — steps 5 and 7 assert that, steps 9-14 run in mode C only. An
// archive that repeats a session id is refused with 422 in every mode (step 15).
//
// Replaces:
//   - server/test/repository-export-import.spec.ts (7 of 8: «overwrites when longer», «leaves
//     untouched when shorter or equal», «bootstrap import», «retries numbered suffix», «404 other
//     user status»)
//   - server/src/logs/repository-export-import.service.spec.ts (merge part)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  bootstrapImport,
  confirmBootstrap,
  exportRepo,
  importZip,
  stageBootstrap,
  stageImport,
  uploadZip,
  type UploadSummary,
} from '../helpers/export-import';
import { ndjson } from '../helpers/ingest';
import { ownRepoId, promptSessionBodies, uploadPromptSession, type PromptSession } from '../helpers/prompt-session';
import { buildExportZip, buildZip } from '../helpers/zip';

interface ConflictBody {
  statusCode: number;
  message: string;
  conflicts: Array<{ sessionId: string; reason: 'foreign-session' | 'foreign-author' | 'foreign-parent' }>;
}

interface LogShape {
  claudeLines: number;
  artisynLines: number;
  updatedAt: string;
}

test('@S-REPO-11 import conflicts: the longer log wins; bootstrap import creates a repository and a team @mode-a @mode-c', async ({
  api,
  db,
  stand,
  users,
}) => {
  test.setTimeout(180_000);
  /** Mode A (AUTH_MODE=none): no ownership checks, imported sessions are reassigned to the importer. */
  const singleUser = stand.authMode === 'none';
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/merge`;
  const owner = await users.user('user', { label: 'r11-owner' });
  const regular = await users.user('user', { label: 'r11-other' });
  const ownerKey = await createApiKey(owner.api);
  const queue = { db, userId: owner.id };
  const s1 = (turns: number): PromptSession => ({ sessionId: `r11-${run}-s1`, prompt: `merge me ${run}`, repoUrl, turns });

  /** Line counts of S1's claude and artisyn logs, and the claude log's last write. */
  const logShape = async (sessionId: string): Promise<LogShape> => {
    const { rows } = await db.query<{ log_type: string; lines: number; updated_at: Date }>(
      `SELECT l.log_type, jsonb_array_length(l.body) AS lines, l.updated_at
         FROM logs l JOIN sessions s ON s.id = l.session_id
        WHERE s.session_id = $1 AND l.log_type IN ('claude', 'artisyn')`,
      [sessionId],
    );
    const byType = new Map(rows.map((r) => [r.log_type, r]));
    return {
      claudeLines: Number(byType.get('claude')?.lines ?? 0),
      artisynLines: Number(byType.get('artisyn')?.lines ?? 0),
      updatedAt: new Date(byType.get('claude')!.updated_at).toISOString(),
    };
  };
  const turnsOf = async (sessionId: string) => (await logShape(sessionId)).claudeLines / 2;
  const listRepos = async (user: ScenarioUser) =>
    (await (await user.api.get('/api/v1/repositories')).json()) as Array<{ id: number; repoUrl: string }>;
  const teamsOf = async (user: ScenarioUser) =>
    (await (await user.api.get('/api/v1/teams')).json()) as Array<{ id: number; name: string }>;
  /** Distinct `logs.user_id` of a session, sorted. */
  const logUserIds = async (sessionId: string): Promise<number[]> => {
    const { rows } = await db.query<{ user_id: number }>(
      `SELECT DISTINCT l.user_id FROM logs l JOIN sessions s ON s.id = l.session_id
        WHERE s.session_id = $1 ORDER BY l.user_id`,
      [sessionId],
    );
    return rows.map((r) => Number(r.user_id));
  };
  const sessionIdsOf = async (user: ScenarioUser, repoId: number) =>
    ((await (await user.api.get(`/api/v1/repositories/${repoId}/sessions`)).json()) as Array<{ sessionId: string }>).map(
      (s) => s.sessionId,
    );

  const { repoA, z1, z2 } = await test.step('setup: S1 with 3 turns → archive Z1; S1 grows to 5 turns → archive Z2', async () => {
    await uploadPromptSession(api, ownerKey.key, s1(3), queue);
    const repoA = await ownRepoId(owner.api, repoUrl);
    const { zip: z1 } = await exportRepo(owner.api, repoA);
    await uploadPromptSession(api, ownerKey.key, s1(5), queue);
    expect(await turnsOf(s1(5).sessionId)).toBe(5);
    const { zip: z2 } = await exportRepo(owner.api, repoA);
    return { repoA, z1, z2 };
  });
  const sid = s1(1).sessionId;

  await test.step('2. Importing the shorter Z1 into A leaves S1 with 5 turns, untouched', async () => {
    const before = await logShape(sid);
    const status = await importZip(owner.api, repoA, z1);
    expect(status).toMatchObject({ status: 'done', processed: 1, total: 1 });
    expect(await logShape(sid)).toEqual(before);
    expect(before.claudeLines).toBe(10);
    expect(before.artisynLines).toBe(10);
  });

  await test.step('3. The hook re-sends a 3-turn S1; importing the longer Z2 overwrites it back to 5 turns', async () => {
    await uploadPromptSession(api, ownerKey.key, s1(3), queue);
    expect(await turnsOf(sid)).toBe(3);
    await importZip(owner.api, repoA, z2);
    const after = await logShape(sid);
    expect(after.claudeLines).toBe(10);
    expect(after.artisynLines).toBe(10);
  });

  await test.step('4. Importing Z2 again (equal length) does not rewrite the log', async () => {
    const before = await logShape(sid);
    await importZip(owner.api, repoA, z2);
    expect(await logShape(sid)).toEqual(before);
    const summary = (await (await owner.api.get(`/api/v1/repositories/${repoA}/summary`)).json()) as { sessionCount: number };
    expect(summary.sessionCount).toBe(1);
  });

  await test.step('5. An author unknown to the server: placeholder user with their e-mail (mode A: the importer), the importer owns the repo', async () => {
    const ghostEmail = `ghost-${run}@arrakis.test`;
    const ghostSession = `r11-${run}-ghost`;
    await importZip(
      owner.api,
      repoA,
      buildExportZip({ sourceRepoUrl: repoUrl, sessions: [{ sessionId: ghostSession, prompt: `ghost ${run}`, repoUrl, userEmail: ghostEmail }] }),
    );
    const { rows } = await db.query<{ id: number }>('SELECT id FROM users WHERE email = $1', [ghostEmail]);
    expect(rows).toHaveLength(singleUser ? 0 : 1);
    const sessions = (await (await owner.api.get(`/api/v1/repositories/${repoA}/sessions`)).json()) as Array<{
      sessionId: string;
      userEmail?: string;
      userId: number | null;
    }>;
    const ghost = sessions.find((s) => s.sessionId === ghostSession);
    if (singleUser) expect(ghost).toMatchObject({ userEmail: owner.email, userId: owner.id });
    else expect(ghost).toMatchObject({ userEmail: ghostEmail, userId: rows[0].id });
    const repoOwner = await db.query<{ user_id: number }>('SELECT user_id FROM repositories WHERE id = $1', [repoA]);
    expect(repoOwner.rows[0].user_id).toBe(owner.id);
    expect((await listRepos(owner)).map((r) => r.id)).toContain(repoA);
  });

  const importTeamName = `Imported: ${repoUrl}`;

  await test.step('6. Bootstrap by OWNER (has the repository): the same repository A and team `Imported: <url>`, twice', async () => {
    const first = await bootstrapImport(owner.api, z1);
    const second = await bootstrapImport(owner.api, z1);
    expect(first.repoId).toBe(repoA);
    expect(second.repoId).toBe(repoA);
    expect(second.teamId).toBe(first.teamId);
    const team = (await teamsOf(owner)).find((t) => t.id === first.teamId);
    expect(team?.name).toBe(importTeamName);
    expect(await turnsOf(sid)).toBe(5);
  });

  const regularRepoId = await test.step('7. Bootstrap by REGULAR (no repository): a new personal repository, reused on repeat; team name gets « (2)»; OWNER’s S1 → 409 (mode A: reassigned to REGULAR)', async () => {
    expect((await listRepos(regular)).map((r) => r.repoUrl)).not.toContain(repoUrl);
    const regSession = `r11-${run}-reg`;
    const own = buildExportZip({
      sourceRepoUrl: repoUrl,
      sessions: [{ sessionId: regSession, prompt: `regular ${run}`, repoUrl, userEmail: regular.email }],
    });
    const first = await bootstrapImport(regular.api, own);
    const second = await bootstrapImport(regular.api, own);
    expect(first.repoId).not.toBe(repoA);
    expect(second.repoId).toBe(first.repoId);
    expect((await listRepos(regular)).filter((r) => r.repoUrl === repoUrl).map((r) => r.id)).toEqual([first.repoId]);
    expect(await sessionIdsOf(regular, first.repoId)).toEqual([regSession]);
    const team = (await teamsOf(regular)).find((t) => t.id === first.teamId);
    expect(team?.name).toBe(`${importTeamName} (2)`);
    expect(second.teamId).toBe(first.teamId);

    const before = await logShape(sid);
    if (singleUser) {
      const imported = await bootstrapImport(regular.api, z1);
      expect(imported.repoId).toBe(first.repoId);
      expect(await logUserIds(sid)).toEqual([regular.id]);
    } else {
      const res = await uploadZip(regular.api, '/api/v1/repositories/bootstrap-import/upload', z1);
      expect(res.status()).toBe(409);
      const body = (await res.json()) as ConflictBody;
      expect(body.conflicts).toEqual(
        expect.arrayContaining([
          { sessionId: sid, reason: 'foreign-session' },
          { sessionId: sid, reason: 'foreign-author' },
        ]),
      );
      expect(body.message).toContain(sid);
      expect(await logShape(sid)).toEqual(before);
      expect(await logUserIds(sid)).toEqual([owner.id]);
    }
    return first.repoId;
  });

  await test.step('8. REGULAR cannot confirm OWNER’s staged bootstrap upload nor read OWNER’s job → 404 / 403', async () => {
    const staged = await stageBootstrap(owner.api, z1);
    expect((await regular.api.post(`/api/v1/repositories/bootstrap-import/${staged.uploadToken}/confirm`, { data: {} })).status()).toBe(404);
    const { jobId } = await confirmBootstrap(owner.api, staged.uploadToken);
    expect((await regular.api.get(`/api/v1/repositories/bootstrap-import/${jobId}/status`)).status()).toBe(404);
    expect((await regular.api.get(`/api/v1/repositories/${repoA}/import/${jobId}/status`)).status()).toBe(403);
  });

  await test.step('9. Mode C: REGULAR imports a longer S1 of their own into their repository → 409 foreign-session, nothing changes', async () => {
    if (singleUser) return;
    const snapshot = async () =>
      (
        await db.query<{ id: number; parent_session_id: string | null; workflow_run_id: string | null }>(
          'SELECT id, parent_session_id, workflow_run_id FROM sessions WHERE session_id = $1',
          [sid],
        )
      ).rows;
    const sessionRow = await snapshot();
    const before = await logShape(sid);
    const archive = buildExportZip({
      sourceRepoUrl: repoUrl,
      sessions: [{ sessionId: sid, prompt: `merge me ${run}`, repoUrl, turns: 7, userEmail: regular.email }],
    });
    const res = await stageImport(regular.api, regularRepoId, archive);
    expect(res.status()).toBe(409);
    const body = (await res.json()) as ConflictBody;
    expect(body.conflicts).toEqual([{ sessionId: sid, reason: 'foreign-session' }]);
    expect(await logShape(sid)).toEqual(before);
    expect(await logUserIds(sid)).toEqual([owner.id]);
    expect(await snapshot()).toEqual(sessionRow);
    expect(await sessionIdsOf(regular, regularRepoId)).not.toContain(sid);
  });

  await test.step('10. Mode C: OWNER’s hook takes a session after REGULAR staged it → confirm 409, a second confirm 404 with the same message', async () => {
    if (singleUser) return;
    const race: PromptSession = { sessionId: `r11-${run}-race`, prompt: `race ${run}`, repoUrl };
    const staged = await stageImport(
      regular.api,
      regularRepoId,
      buildExportZip({ sourceRepoUrl: repoUrl, sessions: [{ ...race, userEmail: regular.email }] }),
    );
    expect(staged.status()).toBe(201);
    const { uploadToken } = (await staged.json()) as UploadSummary;
    await uploadPromptSession(api, ownerKey.key, race, queue);

    const confirmPath = `/api/v1/repositories/${regularRepoId}/import/${uploadToken}/confirm`;
    const first = await regular.api.post(confirmPath, { data: {} });
    expect(first.status()).toBe(409);
    const conflict = (await first.json()) as ConflictBody;
    expect(conflict.conflicts).toEqual([{ sessionId: race.sessionId, reason: 'foreign-session' }]);
    const again = await regular.api.post(confirmPath, { data: {} });
    expect(again.status()).toBe(404);
    expect(((await again.json()) as { message: string }).message).toBe(conflict.message);
    expect(await logUserIds(race.sessionId)).toEqual([owner.id]);
  });

  const sessionRowCount = async (sessionId: string) =>
    Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM sessions WHERE session_id = $1', [sessionId])).rows[0].n);
  const userCount = async () => Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM users')).rows[0].n);

  await test.step('11. Mode C: REGULAR imports a new session authored as OWNER → 409 foreign-author, nothing is created', async () => {
    if (singleUser) return;
    const spoof = `r11-${run}-spoof`;
    const usersBefore = await userCount();
    const res = await stageImport(
      regular.api,
      regularRepoId,
      buildExportZip({ sourceRepoUrl: repoUrl, sessions: [{ sessionId: spoof, prompt: `spoof ${run}`, repoUrl, userEmail: owner.email }] }),
    );
    expect(res.status()).toBe(409);
    expect(((await res.json()) as ConflictBody).conflicts).toEqual([{ sessionId: spoof, reason: 'foreign-author' }]);
    expect(await sessionRowCount(spoof)).toBe(0);
    expect(await userCount()).toBe(usersBefore);
  });

  await test.step('12. Mode C: REGULAR imports a new child session of OWNER’s S1 → 409 foreign-parent, no child row', async () => {
    if (singleUser) return;
    const child = `r11-${run}-child`;
    const res = await stageImport(
      regular.api,
      regularRepoId,
      buildExportZip({
        sourceRepoUrl: repoUrl,
        sessions: [{ sessionId: child, prompt: `child ${run}`, repoUrl, userEmail: regular.email, parentSessionId: sid }],
      }),
    );
    expect(res.status()).toBe(409);
    expect(((await res.json()) as ConflictBody).conflicts).toEqual([{ sessionId: child, reason: 'foreign-parent' }]);
    expect(await sessionRowCount(child)).toBe(0);
  });

  await test.step('13. Mode C: OWNER imports a longer S1 authored by an unknown e-mail → body overwritten, S1 stays OWNER’s, no placeholder', async () => {
    if (singleUser) return;
    const ghost2 = `r11-${run}-ghost2@arrakis.test`;
    const status = await importZip(
      owner.api,
      repoA,
      buildExportZip({ sourceRepoUrl: repoUrl, sessions: [{ sessionId: sid, prompt: `merge me ${run}`, repoUrl, turns: 7, userEmail: ghost2 }] }),
    );
    expect(status).toMatchObject({ status: 'done', processed: 1, total: 1 });
    expect((await logShape(sid)).claudeLines).toBe(14);
    expect(await logUserIds(sid)).toEqual([owner.id]);
    expect((await db.query('SELECT id FROM users WHERE email = $1', [ghost2])).rows).toHaveLength(0);
  });

  await test.step('14. Mode C: the author e-mail is OWNER’s in upper case with spaces → still 409 foreign-author', async () => {
    if (singleUser) return;
    const spoof = `r11-${run}-spoof-case`;
    const res = await stageImport(
      regular.api,
      regularRepoId,
      buildExportZip({
        sourceRepoUrl: repoUrl,
        sessions: [{ sessionId: spoof, prompt: `spoof case ${run}`, repoUrl, userEmail: `  ${owner.email.toUpperCase()} ` }],
      }),
    );
    expect(res.status()).toBe(409);
    expect(((await res.json()) as ConflictBody).conflicts).toEqual([{ sessionId: spoof, reason: 'foreign-author' }]);
    expect(await sessionRowCount(spoof)).toBe(0);
  });

  await test.step('15. An archive with the same session twice → 422 in every mode, nothing is created', async () => {
    const dup: PromptSession = { sessionId: `r11-${run}-dup`, prompt: `dup ${run}`, repoUrl };
    const res = await stageImport(
      regular.api,
      regularRepoId,
      buildExportZip({
        sourceRepoUrl: repoUrl,
        sessions: [
          { ...dup, userEmail: regular.email },
          { ...dup, userEmail: regular.email },
        ],
      }),
    );
    expect(res.status()).toBe(422);
    expect(((await res.json()) as { message: string }).message).toContain(dup.sessionId);
    expect(await sessionRowCount(dup.sessionId)).toBe(0);
  });

  await test.step('16. Importing an archive whose artisyn.jsonl carries snapshot lines (DD-14) stores the snapshot and binds the session', async () => {
    const snapSid = `r11-${run}-snap`;
    const snapSession: PromptSession = { sessionId: snapSid, prompt: `snap ${run}`, repoUrl };
    const bodies = promptSessionBodies(snapSession);
    const snapshotId = randomBytes(32).toString('hex');
    const artisynWithSnapshot =
      bodies.artisyn +
      ndjson([
        { type: 'harness-snapshot-ref', snapshotId },
        {
          type: 'harness-snapshot',
          snapshotId,
          schemaVersion: 1,
          perToolDetailSupported: true,
          skills: [],
          agents: [],
          mcpServers: [],
          systemContext: null,
        },
      ]);
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = new Date(at.getTime() + 60_000);
    const zip = buildZip([
      {
        name: 'meta.json',
        data: JSON.stringify({
          formatVersion: 1,
          createdAt: new Date().toISOString(),
          sourceHost: 'scenario-suite',
          sourceRepoUrl: repoUrl,
          sourceRepoContext: { type: 'personal' },
          sessionCount: 1,
          approxUncompressedBytes: bodies.claude.length + artisynWithSnapshot.length,
        }),
      },
      {
        name: `sessions/${snapSid}/session.json`,
        data: JSON.stringify({
          sessionId: snapSid,
          parentSessionId: null,
          workflowRunId: null,
          firstPrompt: snapSession.prompt,
          startTime: at.toISOString(),
          endTime: end.toISOString(),
          gitBranch: 'main',
          stats: null,
          logs: { claude: { userEmail: owner.email }, artisyn: { userEmail: owner.email } },
        }),
      },
      { name: `sessions/${snapSid}/claude.jsonl`, data: bodies.claude },
      { name: `sessions/${snapSid}/artisyn.jsonl`, data: artisynWithSnapshot },
    ]);

    const status = await importZip(owner.api, repoA, zip);
    expect(status).toMatchObject({ status: 'done', processed: 1, total: 1 });

    const snap = await db.query<{ snapshot_id: string }>(
      'SELECT snapshot_id FROM harness_snapshots WHERE user_id = $1 AND snapshot_id = $2',
      [owner.id, snapshotId],
    );
    expect(snap.rows, 'the importer owns a harness_snapshots row for this id').toHaveLength(1);
    const bound = await db.query<{ harness_snapshot_id: string | null }>(
      'SELECT harness_snapshot_id FROM sessions WHERE session_id = $1',
      [snapSid],
    );
    expect(bound.rows[0]?.harness_snapshot_id, 'the imported session is bound to it').toBe(snapshotId);
  });
});
