import type { Request } from 'express';

/** True when the request's `Accept-Encoding` admits gzip (not with `q=0`). */
export function acceptsGzip(req: Request): boolean {
  const raw = req.headers['accept-encoding'];
  const header = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  for (const token of header.split(',')) {
    const [name, ...params] = token.trim().toLowerCase().split(';');
    if (name.trim() !== 'gzip' && name.trim() !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q !== undefined && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}
