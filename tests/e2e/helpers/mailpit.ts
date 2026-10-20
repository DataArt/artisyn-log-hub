/**
 * mailpit.ts — reads real captured emails from a local Mailpit SMTP catcher
 * (docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit),
 * for the e2e specs that are actually *about* the email-confirmation/
 * password-reset flow — verifying the real send-and-format path end to end
 * (subject, body, link origin/hash-prefix), not just that a DB row exists.
 *
 * Not used by the generic "get a session" bootstrap (ensureUser() in
 * auth.ts, or the equivalent server-side helper) — those stay DB-read.
 *
 * Required local prerequisite for the two specs that import this file —
 * not started automatically, the same way the DB itself is an assumed
 * already-running prerequisite rather than something the test suite
 * provisions.
 */

export const MAILPIT_BASE_URL = process.env.MAILPIT_BASE_URL ?? 'http://localhost:8025';

/**
 * True when Mailpit's HTTP API answers within `timeoutMs`. Used only by the
 * globalSetup "Skipped scenarios" summary — the Mailpit specs themselves do
 * not probe, they fail loudly if Mailpit is missing.
 */
export async function isMailpitReachable(timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_BASE_URL}/api/v1/info`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface MailpitMessageSummary {
  ID: string;
}

interface MailpitSearchResponse {
  messages: MailpitMessageSummary[];
}

interface MailpitMessage {
  Text: string;
}

/**
 * Polls Mailpit's search API for the most recent message to `email`, then
 * fetches its full body. Polls rather than assuming instant delivery — the
 * relay/catcher round trip is not necessarily synchronous with the HTTP
 * response that triggered it.
 */
export async function findLatestMessageTo(
  email: string,
  { timeoutMs = 10_000, pollIntervalMs = 250 }: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const query = encodeURIComponent(`to:${email}`);

  while (Date.now() < deadline) {
    const searchRes = await fetch(
      `${MAILPIT_BASE_URL}/api/v1/search?query=${query}`,
    );
    if (searchRes.ok) {
      const search = (await searchRes.json()) as MailpitSearchResponse;
      if (search.messages.length > 0) {
        const messageRes = await fetch(
          `${MAILPIT_BASE_URL}/api/v1/message/${search.messages[0].ID}`,
        );
        if (messageRes.ok) {
          const message = (await messageRes.json()) as MailpitMessage;
          return message.Text;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `No Mailpit message found for ${email} within ${timeoutMs}ms — ` +
      `is Mailpit running (docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit)?`,
  );
}

/** Extracts the `token` query param from a link inside an email body. */
export function extractTokenFromEmailBody(body: string): string {
  const match = /token=([^\s&]+)/.exec(body);
  if (!match) {
    throw new Error(`No token= param found in email body:\n${body}`);
  }
  return match[1];
}
