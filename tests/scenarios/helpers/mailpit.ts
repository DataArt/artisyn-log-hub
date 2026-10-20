/**
 * mailpit.ts — reads real captured emails from the Mailpit SMTP catcher the mode-B stand sends to
 * (SMTP_HOST/SMTP_PORT ← MAILPIT_SMTP; HTTP API ← MAILPIT_URL, impl-plan DD C2).
 *
 * Copied from tests/e2e/helpers/mailpit.ts; the e2e `MAILPIT_BASE_URL` variable is `MAILPIT_URL`
 * here, the name the scenario runner and its README use. Start Mailpit with
 * `docker compose -f tests/scenarios/docker-compose.yml up -d`; the runner's preflight refuses
 * to run mode B without it.
 */
import { DEFAULT_MAILPIT_URL } from '../modes';

export const MAILPIT_URL = (process.env.MAILPIT_URL || DEFAULT_MAILPIT_URL).replace(/\/+$/, '');

/** True when Mailpit's HTTP API answers within `timeoutMs`. */
export async function isMailpitReachable(timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_URL}/api/v1/info`, {
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
  Subject: string;
  Text: string;
  HTML: string;
}

export interface CapturedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Polls Mailpit's search API for the most recent message to `email`, then fetches it in full.
 * Polls rather than assuming instant delivery: the SMTP round trip is not synchronous with the
 * HTTP response that triggered it.
 */
export async function findLatestEmailTo(
  email: string,
  { timeoutMs = 10_000, pollIntervalMs = 250 }: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<CapturedEmail> {
  const deadline = Date.now() + timeoutMs;
  const query = encodeURIComponent(`to:"${email}"`);

  while (Date.now() < deadline) {
    const searchRes = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`);
    if (searchRes.ok) {
      const search = (await searchRes.json()) as MailpitSearchResponse;
      if (search.messages.length > 0) {
        const messageRes = await fetch(`${MAILPIT_URL}/api/v1/message/${search.messages[0].ID}`);
        if (messageRes.ok) {
          const message = (await messageRes.json()) as MailpitMessage;
          return { subject: message.Subject, text: message.Text, html: message.HTML };
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `No Mailpit message found for ${email} within ${timeoutMs}ms at MAILPIT_URL=${MAILPIT_URL} — ` +
      'is Mailpit running (docker compose -f tests/scenarios/docker-compose.yml up -d)?',
  );
}

async function searchMessageIds(email: string): Promise<string[]> {
  const query = encodeURIComponent(`to:"${email}"`);
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`);
  if (!res.ok) throw new Error(`Mailpit search for ${email} failed (${res.status}) at MAILPIT_URL=${MAILPIT_URL}`);
  const search = (await res.json()) as MailpitSearchResponse;
  return search.messages.map((m) => m.ID);
}

async function fetchMessage(id: string): Promise<CapturedEmail> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`Mailpit message ${id} could not be read (${res.status})`);
  const message = (await res.json()) as MailpitMessage;
  return { subject: message.Subject, text: message.Text, html: message.HTML };
}

/**
 * Every message to `email`, newest first. Waits until at least `atLeast` messages arrived (the
 * SMTP round trip is asynchronous), then for `settleMs` more, so a message that should NOT have
 * been sent has had the time to show up before the caller counts.
 */
export async function listEmailsTo(
  email: string,
  {
    atLeast = 0,
    settleMs = 750,
    timeoutMs = 10_000,
    pollIntervalMs = 250,
  }: { atLeast?: number; settleMs?: number; timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<CapturedEmail[]> {
  const deadline = Date.now() + timeoutMs;
  let ids = await searchMessageIds(email);
  while (ids.length < atLeast) {
    if (Date.now() >= deadline) {
      throw new Error(`Expected at least ${atLeast} Mailpit messages for ${email} within ${timeoutMs}ms, got ${ids.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    ids = await searchMessageIds(email);
  }
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    ids = await searchMessageIds(email);
  }
  return Promise.all(ids.map(fetchMessage));
}

/** The first `http(s)://…` link in an email body that contains `marker` (e.g. `#/confirm-email?token=`). */
export function extractLinkFromEmailBody(body: string, marker: string): string {
  for (const match of body.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    if (match[0].includes(marker)) return match[0];
  }
  throw new Error(`No link containing "${marker}" found in email body:\n${body}`);
}

/** Text body of the most recent message to `email` (see {@link findLatestEmailTo}). */
export async function findLatestMessageTo(
  email: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<string> {
  return (await findLatestEmailTo(email, options)).text;
}

/** Extracts the `token` query param from a link inside an email body. */
export function extractTokenFromEmailBody(body: string): string {
  const match = /token=([^\s&"'<>]+)/.exec(body);
  if (!match) {
    throw new Error(`No token= param found in email body:\n${body}`);
  }
  return match[1];
}
