import { isLocalRepoIdentity } from './local-repo-identity';

/**
 * Normalizes a repository URL to a canonical HTTPS form.
 *
 * Rules:
 *  - SSH Azure DevOps   : git@ssh.dev.azure.com:v3/org/project/repo → https://dev.azure.com/org/project/_git/repo
 *  - Legacy Azure SSH   : user@vs-ssh.visualstudio.com:v3/org/project/repo → https://dev.azure.com/org/project/_git/repo
 *  - SSH (any host)     : git@<host>:<path>[.git]  → https://<host>/<path>
 *  - HTTP → HTTPS (all hosts)
 *  - Strip embedded credentials (all hosts)
 *  - Strip trailing .git suffix (all hosts)
 *  - Strip trailing slashes (all hosts)
 *  - Lowercase the host (all hosts)
 *  - git:// on any host → return verbatim (undefined semantics)
 *  - URLs that fail URL parsing → return verbatim
 *
 * The result is a fixed point: normalizing it again returns it unchanged. That matters because a
 * bare Windows path (`D:\a\b`, what the hook reports for a git repo with no remote) parses as the
 * non-special scheme `d:`, where the URL parser leaves backslashes alone — one pass yields
 * `https://\a\b`. Feeding that back in re-parses it under `https`, which IS special and does
 * rewrite `\` to `/`, giving `https://a/b`. Ingest used to store the one-pass form while
 * `RepoBackfillService` (bootstrap) stored the two-pass form, so every upload re-created a
 * duplicate `repositories` row that only merged at the next server restart — and until it did,
 * new sessions attached to the duplicate and vanished from the real repo's session list.
 *
 * Local paths no longer reach this function raw: ingest and the startup migration first turn
 * them into an `<email>/<path>` identity (`local-repo-identity.ts`), which is returned unchanged
 * here. That check runs first — before the scp-style `git@host:path` rule — so an identity such
 * as `muaddib@arrakis.test/C:/work/p` is never mistaken for an SSH remote.
 */
export function normalizeRepoUrl(raw: string): string {
  if (isLocalRepoIdentity(raw)) return raw;
  // Bounded rather than `while` — a pathological input must not spin here.
  let current = normalizeRepoUrlOnce(raw);
  for (let i = 0; i < 3; i++) {
    const next = normalizeRepoUrlOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function normalizeRepoUrlOnce(raw: string): string {
  // --- SSH Azure DevOps: git@ssh.dev.azure.com:v3/<org>/<project>/<repo> ---
  const sshAzure = raw.match(
    /^git@ssh\.dev\.azure\.com:v3\/(.+?)\/(.+?)\/(.+)$/,
  );
  if (sshAzure) {
    const [, org, project, repo] = sshAzure;
    return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
  }

  // --- Legacy Azure SSH: <user>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo> ---
  const legacyAzureSsh = raw.match(
    /^[^@]+@vs-ssh\.visualstudio\.com:v3\/(.+?)\/(.+?)\/(.+)$/,
  );
  if (legacyAzureSsh) {
    const [, org, project, repo] = legacyAzureSsh;
    return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
  }

  // --- SSH generic (GitHub, GitLab, self-hosted on-prem): git@<host>:<path>[.git] ---
  const sshGeneric = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshGeneric) {
    const [, host, path] = sshGeneric;
    return `https://${host.toLowerCase()}/${path}`;
  }

  // --- Standard URL parsing ---
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Malformed — return verbatim
    return raw;
  }

  const host = parsed.hostname.toLowerCase();

  // --- git:// protocol on any host → verbatim ---
  if (parsed.protocol === 'git:') {
    return raw;
  }

  // Strip .git suffix and trailing slash (applies to all HTTP/HTTPS hosts,
  // including self-hosted GitLab/Gitea/Bitbucket instances)
  let pathname = parsed.pathname.replace(/\.git$/, '');
  pathname = pathname.replace(/\/$/, '');

  return `https://${host}${pathname}`;
}
