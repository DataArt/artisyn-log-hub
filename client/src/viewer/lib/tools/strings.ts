export function trunc(s: string | undefined | null, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  ) {
    return String(v);
  }
  return JSON.stringify(v);
}

export function lineCount(s: string): number {
  return s.split('\n').length;
}

export function fileCount(s: string): number {
  return s.split('\n').filter(Boolean).length;
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path;
}
