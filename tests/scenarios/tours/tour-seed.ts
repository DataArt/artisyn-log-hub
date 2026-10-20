/**
 * tour-seed.ts — data set-up shared by several tours.
 *
 *  - `uploadHookStatusSession(...)` uploads a one-prompt session whose artisyn log carries a
 *    `hook-status` line with an issue (a failed upload), the way the hook reports its own state
 *    (as in S-HSTATE-03). The repository then has a Hook State page and an «Installed Hooks» entry.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import type { Pool } from 'pg';
import { promptSessionBodies, type PromptSession } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';

/** The non-uploadable log the hook status reports; the Hook State page lists it. */
export const HOOK_STATUS_FAILED_FILE = 'big-session.jsonl';

export async function uploadHookStatusSession(
  api: APIRequestContext,
  apiKey: string,
  session: PromptSession,
  queue: { db: Pool; userId: number },
): Promise<void> {
  const { artisyn, claude } = promptSessionBodies(session);
  const status = {
    type: 'hook-status',
    hookVersion: '0.0.1',
    timestamp: new Date().toISOString(),
    logTail: ['[info] uploading', '[error] upload failed: timeout'],
    nonUploadableLogs: [{ file: HOOK_STATUS_FAILED_FILE, reason: 'timeout after 10000ms (size=12.0MB)' }],
    recommendations: [],
  };
  for (const [type, body] of [
    ['artisyn', `${artisyn}${JSON.stringify(status)}\n`],
    ['claude', claude],
  ] as const) {
    const res = await api.post('/api/v2/logs', {
      params: { sessionId: session.sessionId, type },
      headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': apiKey },
      data: body,
    });
    expect(res.status(), `hook-status session ${type} log`).toBe(201);
  }
  await waitForQueueIdle(queue.db, queue.userId);
}
