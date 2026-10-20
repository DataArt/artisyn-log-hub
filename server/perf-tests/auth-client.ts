import { loadConfig } from './config';
import { IdCollector } from './types';

const config = loadConfig();
const BASE = config.baseUrl;

export class AuthClient {
  private sessionCookie: string | null = null;
  private apiKey: string | null = null;
  private apiKeyId: string | null = null;
  private _userId: string | null = null;
  private _authMode: string | null = null;
  private idCollector: IdCollector | null = null;

  async setup(collector?: IdCollector): Promise<void> {
    this.idCollector = collector ?? null;
    await this._ensureUser();
    await this._ensureApiKey();
  }

  async teardown(): Promise<void> {
    if (this.apiKeyId) {
      const res = await this.fetch(`/api/v1/api-keys/${this.apiKeyId}`, {
        method: 'DELETE',
      });
      if (res.status !== 204) {
        console.warn(
          `  Warning: failed to delete API key ${this.apiKeyId} (${res.status})`,
        );
      }
    }
  }

  /**
   * Reads the server's active auth mode from `GET /api/v1/auth/config`. The
   * password endpoints (`signup`/`login`) are gated by `AllowedAuthModes` and
   * 404 under any other mode, so the harness has to branch on this rather than
   * assume a password-based server.
   */
  private async _fetchAuthMode(): Promise<string | null> {
    const res = await fetch(`${BASE}/api/v1/auth/config`);
    if (!res.ok) {
      throw new Error(
        `Could not read auth config: ${res.status} ${await res.text()}`,
      );
    }
    const data = (await res.json()) as { mode?: string };
    return data.mode ?? null;
  }

  private async _ensureUser(): Promise<void> {
    const mode = await this._fetchAuthMode();
    this._authMode = mode;
    if (mode === 'none') {
      await this._identify();
      return;
    }
    await this._ensureUserWithPassword();
  }

  /**
   * `AUTH_MODE=none` (identify-only): a single email POST both auto-provisions
   * the user and logs in, so there is no signup step and no password. The route
   * is localhost-only, which the default `baseUrl` already satisfies.
   *
   * Deliberately does NOT set `userWasCreated`: identify is idempotent
   * auto-provisioning, so it cannot report whether this run created the row or
   * reused one from a previous run. Leaving one reusable user behind is a much
   * better failure mode than `DELETE FROM users` on a row we did not create.
   */
  private async _identify(): Promise<void> {
    const res = await fetch(`${BASE}/api/v1/auth/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: config.testUser.email }),
    });
    if (!res.ok) {
      throw new Error(`Identify failed: ${res.status} ${await res.text()}`);
    }
    this._captureSessionCookie(res);
    const data = (await res.json()) as Record<string, string>;
    this._userId = data.id;
  }

  private async _ensureUserWithPassword(): Promise<void> {
    if (await this._tryLogin()) return;

    const signupRes = await fetch(`${BASE}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.testUser.email,
        password: config.testUser.password,
        passwordConfirm: config.testUser.password,
      }),
    });
    if (!signupRes.ok) {
      throw new Error(
        `Signup failed: ${signupRes.status} ${await signupRes.text()}`,
      );
    }

    if (this.idCollector) {
      this.idCollector.userWasCreated = true;
    }

    if (!(await this._tryLogin())) {
      throw new Error('Login failed after signup');
    }
  }

  private async _tryLogin(): Promise<boolean> {
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.testUser.email,
        password: config.testUser.password,
      }),
    });
    if (!res.ok) return false;
    this._captureSessionCookie(res);
    const data = (await res.json()) as Record<string, string>;
    this._userId = data.id;
    return true;
  }

  /** Both `login` and `identify` establish the session the same way. */
  private _captureSessionCookie(res: Response): void {
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/connect\.sid=([^;]+)/);
    if (match) this.sessionCookie = `connect.sid=${match[1]}`;
  }

  private async _ensureApiKey(): Promise<void> {
    const res = await fetch(`${BASE}/api/v1/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.sessionCookie || '',
      },
      body: JSON.stringify({ name: `perf-key-${Date.now()}` }),
    });
    if (!res.ok) throw new Error(`Failed to create API key: ${res.status}`);
    const data = (await res.json()) as Record<string, string>;
    this.apiKey = data.key;
    this.apiKeyId = data.id;
  }

  get apiKeyHeader(): Record<string, string> {
    return { 'X-API-Key': this.apiKey || '' };
  }

  get userId(): string | null {
    return this._userId;
  }

  /**
   * The server's active auth mode, as resolved during {@link setup}. `null` before setup runs.
   *
   * Exposed so a scenario can hit the endpoint that actually exists: `signup`/`login` are gated
   * by `AllowedAuthModes` and 404 under `none`, which silently turned the `auth:login` scenario
   * into a 500-for-500 failure measuring nothing but a 404.
   */
  get authMode(): string | null {
    return this._authMode;
  }

  fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      ...init,
      headers: { Cookie: this.sessionCookie || '', ...(init?.headers || {}) },
    });
  }

  fetchJson(path: string, method: string, body?: unknown): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.sessionCookie || '',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }
}
