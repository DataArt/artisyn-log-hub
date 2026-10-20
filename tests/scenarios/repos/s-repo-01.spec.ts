// S-REPO-01. One project uploaded with different remote URLs is one repository
// (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-01; no mode in the design → A and C,
// DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). Hosts are neutral (`*.arrakis.test`,
// DD 2) instead of the design's github.com; the rules under test do not depend on the host.
//
// Code facts that differ from the design text:
//   - step 6, Azure: the SSH form the normalizer knows is `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`
//     (→ `https://dev.azure.com/<org>/<project>/_git/<repo>`); the design's `git@dev.azure.com:v3/...`
//     is not an Azure SSH URL and would only take the generic scp-style rule;
//   - step 6, bare path: a local path no longer becomes `https://_work/...` (the design's open
//     question G15). Ingest stores the per-user identity `<email>/<path>` with forward slashes and
//     an upper-case drive (docs/knowledgebase/repo-identity.md §3), which the step pins.
//
// Replaces:
//   (server/src/logs/repo-url-normalizer.spec.ts became the table test of
//   docs/knowledgebase/algorithms/repo-url-normalization.md, design «Что теряем»)
//   - server/test/repo-backfill.spec.ts (8, except «DI wiring»)
//   - server/test/logs.e2e-spec.ts (the repository fragments)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { uploadPromptSession, type PromptSession } from '../helpers/prompt-session';

interface RepoRow {
  id: number;
  repoUrl: string;
}

test('@S-REPO-01 one project with different remote URLs is one repository @mode-a @mode-c', async ({ api, db, users }) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const user = await users.user('user', { label: 'repo01' });
  const key = await createApiKey(user.api);
  const queue = { db, userId: user.id };

  const project = `https://git.arrakis.test/acme/proj-${run}`;
  const spellings = [
    `git@git.arrakis.test:acme/proj-${run}.git`,
    `https://git.arrakis.test/acme/proj-${run}`,
    `https://git.arrakis.test/acme/proj-${run}.git`,
    `http://GIT.Arrakis.Test/acme/proj-${run}/`,
    `https://scn:secret-token-${run}@git.arrakis.test/acme/proj-${run}.git`,
  ];
  const projectSessions: PromptSession[] = spellings.map((repoUrl, i) => ({
    sessionId: `repo01-${run}-s${i + 1}`,
    prompt: `spelling ${i + 1} ${run}`,
    repoUrl,
  }));
  const other: PromptSession = {
    sessionId: `repo01-${run}-s6`,
    prompt: `other project ${run}`,
    repoUrl: `git@gitlab.arrakis.test:grp/other-${run}.git`,
  };
  const azure: PromptSession = {
    sessionId: `repo01-${run}-s7`,
    prompt: `azure ${run}`,
    repoUrl: `git@ssh.dev.azure.com:v3/arrakis/proj-${run}/repo-${run}`,
  };
  const localPath: PromptSession = {
    sessionId: `repo01-${run}-s8`,
    prompt: `no remote ${run}`,
    repoUrl: `c:\\work\\x-${run}\\`,
  };

  const myRepos = async () => {
    const res = await user.api.get('/api/v1/repositories');
    expect(res.status()).toBe(200);
    return ((await res.json()) as RepoRow[]).filter((r) => r.repoUrl.includes(run));
  };
  const projectRepoId = async () => {
    const repo = (await myRepos()).find((r) => r.repoUrl === project);
    expect(repo, `repository ${project}`).toBeDefined();
    return repo!.id;
  };
  const sessionIds = async (repoId: number) => {
    const res = await user.api.get(`/api/v1/repositories/${repoId}/sessions`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as Array<{ sessionId: string }>).map((s) => s.sessionId).sort();
  };
  const summary = async (repoId: number) => {
    const res = await user.api.get(`/api/v1/repositories/${repoId}/summary`);
    expect(res.status()).toBe(200);
    return (await res.json()) as { sessionCount: number; userCount: number };
  };

  await test.step('1. Upload S1..S6: five spellings of proj-<run> and one other project', async () => {
    for (const s of [...projectSessions, other]) await uploadPromptSession(api, key.key, s, queue);
  });

  await test.step('2. GET /repositories: proj-<run> once, in canonical https form, without credentials', async () => {
    const repos = await myRepos();
    expect(repos.map((r) => r.repoUrl).sort()).toEqual([`https://gitlab.arrakis.test/grp/other-${run}`, project].sort());
    for (const r of repos) {
      expect(r.repoUrl).not.toContain('secret-token');
      expect(r.repoUrl).not.toMatch(/\.git$|\/$/);
    }
  });

  await test.step('3–4. Summary and session list: the five spellings are five sessions of one user', async () => {
    const repoId = await projectRepoId();
    expect(await summary(repoId)).toEqual({ sessionCount: 5, userCount: 1 });
    expect(await sessionIds(repoId)).toEqual(projectSessions.map((s) => s.sessionId).sort());
  });

  await test.step('5. Uploading S1 again with the same body creates neither a repository nor a session', async () => {
    await uploadPromptSession(api, key.key, projectSessions[0], queue);
    expect(await myRepos()).toHaveLength(2);
    const repoId = await projectRepoId();
    expect(await summary(repoId)).toEqual({ sessionCount: 5, userCount: 1 });
    expect(await sessionIds(repoId)).toHaveLength(5);
  });

  await test.step('6. Azure SSH → dev.azure.com/_git; a bare Windows path → the uploader’s own local identity', async () => {
    await uploadPromptSession(api, key.key, azure, queue);
    await uploadPromptSession(api, key.key, localPath, queue);
    const urls = (await myRepos()).map((r) => r.repoUrl);
    expect(urls).toHaveLength(4);
    expect(urls).toContain(`https://dev.azure.com/arrakis/proj-${run}/_git/repo-${run}`);
    expect(urls).toContain(`${user.email}/C:/work/x-${run}`);
    for (const url of urls) expect(url).not.toContain('token');
  });
});
