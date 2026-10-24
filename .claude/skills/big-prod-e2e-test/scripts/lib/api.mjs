// Cookie-jar HTTP client for the stand's REST API plus the ingestion-readiness poll.
import { INGEST_POLL_MS, INGEST_TIMEOUT_MS, TELEMETRY_WAIT_MS } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

export class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  captureCookies(res) {
    for (const line of setCookieHeaders(res.headers)) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** Raw request: resolves { status, body, text } and never throws on HTTP status. */
  async request(method, urlPath, body) {
    const headers = { Accept: 'application/json' };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}${urlPath}`, { method, headers, body: payload, redirect: 'manual' });
    this.captureCookies(res);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  }

  async login(email, password) {
    const res = await this.request('POST', '/api/v1/auth/login', { email, password });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`login as ${email} failed: HTTP ${res.status} ${res.text.slice(0, 300)}`);
    }
    if (this.cookies.size === 0) {
      throw new Error(`login as ${email} returned no session cookie`);
    }
    return res.body;
  }

  /** GET returning parsed JSON; throws on a non-2xx status (error carries `.status`). */
  async getJson(urlPath) {
    const res = await this.request('GET', urlPath);
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`GET ${urlPath} failed: HTTP ${res.status} ${res.text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.body;
  }

  /** The caller's repository whose repoUrl equals `storedUrl`, or null. */
  async findRepoByUrl(storedUrl) {
    const repos = await this.getJson('/api/v1/repositories');
    if (!Array.isArray(repos)) return null;
    return repos.find((r) => r && r.repoUrl === storedUrl) || null;
  }

  /** Session logs; resolves { status, body } so a 404 (not ingested yet) is not an error. */
  async getSessionLogs(rid, sid) {
    const res = await this.request(
      'GET',
      `/api/v1/repositories/${encodeURIComponent(rid)}/sessions/${encodeURIComponent(sid)}/logs`,
    );
    return { status: res.status, body: res.body };
  }

  /** The repository's session list (`GET /api/v1/repositories/:rid/sessions`); throws on non-2xx. */
  async getSessions(rid) {
    const body = await this.getJson(`/api/v1/repositories/${encodeURIComponent(rid)}/sessions`);
    return Array.isArray(body) ? body : [];
  }

  /**
   * Polls the session list until the session's `costBreakdown.telemetryCost` is non-null (FR-5:
   * the OTEL cost arrives after the transcript). Never rejects: a timeout resolves
   * { telemetryCost: null, timedOut: true, last } so the cost judgement ends `skipped`.
   */
  async waitForTelemetry({ rid, sid, pollMs = INGEST_POLL_MS, timeoutMs = TELEMETRY_WAIT_MS }) {
    if (rid == null || !sid) return { telemetryCost: null, timedOut: true, last: 'rid and sid are required' };
    const deadline = Date.now() + timeoutMs;
    let last = 'no response yet';
    for (;;) {
      try {
        const list = await this.getSessions(rid);
        const row = list.find((r) => r && r.sessionId === sid);
        const cost = row?.costBreakdown?.telemetryCost;
        if (cost != null) return { telemetryCost: Number(cost) };
        last = row ? 'telemetryCost is null' : 'session not listed';
      } catch (err) {
        last = err.message;
      }
      if (Date.now() + pollMs > deadline) return { telemetryCost: null, timedOut: true, last };
      await sleep(pollMs);
    }
  }

  /**
   * Polls until the session's logs return 200 with `main` and at least `expectedSubagents`
   * subagents. Pass `rid`, or `storedUrl` to look the repo up on each poll until it appears.
   * Resolves { rid, logs }; rejects with an error whose message starts with "not ingested".
   */
  async waitForIngestion({
    rid = null,
    storedUrl = null,
    sid,
    expectedSubagents = 0,
    pollMs = INGEST_POLL_MS,
    timeoutMs = INGEST_TIMEOUT_MS,
  }) {
    if (!sid) throw new Error('waitForIngestion: sid is required');
    if (rid == null && !storedUrl) throw new Error('waitForIngestion: rid or storedUrl is required');
    const deadline = Date.now() + timeoutMs;
    let repoId = rid;
    let last = 'no response yet';
    for (;;) {
      try {
        if (repoId == null) {
          const repo = await this.findRepoByUrl(storedUrl);
          if (repo) repoId = repo.id;
          else last = `repo ${storedUrl} not listed yet`;
        }
        if (repoId != null) {
          const { status, body } = await this.getSessionLogs(repoId, sid);
          if (status === 200 && body && Array.isArray(body.main)) {
            const count = Array.isArray(body.subagents) ? body.subagents.length : 0;
            if (count >= expectedSubagents) return { rid: repoId, logs: body };
            last = `subagents ${count}/${expectedSubagents}`;
          } else {
            last = `logs HTTP ${status}`;
          }
        }
      } catch (err) {
        last = err.message;
      }
      if (Date.now() + pollMs > deadline) {
        const err = new Error(`not ingested: session ${sid} after ${Math.round(timeoutMs / 1000)}s (${last})`);
        err.code = 'NOT_INGESTED';
        err.rid = repoId;
        throw err;
      }
      await sleep(pollMs);
    }
  }
}

export function createApiClient(baseUrl) {
  return new ApiClient(baseUrl);
}
