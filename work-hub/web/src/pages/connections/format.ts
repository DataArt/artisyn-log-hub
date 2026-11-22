// Display helpers of the Connections page. Nothing here names a provider: labels, page links and
// placeholders all come from `ProviderInfo` (Visual/UX notes).

import type {
  AuthMethod,
  ConnStatus,
  Connection,
  ProviderInfo,
} from "../../api/connections";

/** Auth radio labels, in the order they are offered. */
export const AUTH_LABEL: Record<AuthMethod, string> = {
  ssh_generated: "Generate a key in Work Hub",
  ssh_uploaded: "Use my own SSH key",
  pat: "Access token",
};

export const AUTH_ORDER: AuthMethod[] = [
  "ssh_generated",
  "ssh_uploaded",
  "pat",
];

export const isSsh = (m: AuthMethod) => m !== "pat";

export const STATUS_LABEL: Record<ConnStatus, string> = {
  untested: "Not tested",
  ok: "Connected",
  rejected: "Rejected by host",
  host_key: "Host key changed",
  failed: "Test failed",
};

/** `ok` → green, never tested → grey, anything else → red. */
export function statusTone(s: ConnStatus): "ok" | "bad" | "idle" {
  if (s === "ok") return "ok";
  if (s === "untested") return "idle";
  return "bad";
}

/** The base URL as the server will store it: trimmed, trailing `/` dropped. */
export function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** The connection base URL of a provider: the fixed one, else what the user typed. */
export function webOf(p: ProviderInfo, typed: string): string {
  return p.baseUrlFixed ?? normalizeBase(typed);
}

/** Fills `{web}` of a provider page template; `null` when there is no page or no base yet. */
export function fillWeb(tmpl: string | null, web: string): string | null {
  if (!tmpl) return null;
  if (tmpl.includes("{web}") && !web) return null;
  return tmpl.split("{web}").join(web);
}

/** The host of a URL (https or scp form), or `null` when it does not parse. */
export function hostOf(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    return new URL(s).hostname || null;
  } catch {
    const scp = /^[^@\s/]+@([^:\s/]+):/.exec(s);
    return scp ? scp[1] : null;
  }
}

export function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/** The Auth column: SSH key fingerprint, or `secret set ••••<hint> · updated <date>`. */
export function authSummary(c: Connection): string {
  if (isSsh(c.authMethod)) {
    return c.keyFingerprint ?? (c.secretSet ? "SSH key set" : "No key");
  }
  if (!c.secretSet) return "No token";
  const hint = c.secretHint ? `••••${c.secretHint}` : "••••";
  return `secret set ${hint} · updated ${shortDate(c.secretUpdatedAt)}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
