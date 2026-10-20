import { Transform } from 'stream';

const LEVEL_LABELS: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: ' INFO',
  40: ' WARN',
  50: 'ERROR',
  60: 'FATAL',
};

const SKIP = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'context']);
const MAX_VAL_LEN = 2000;

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:` +
    `${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}.` +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

export function formatLogbackLine(raw: string): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw + '\n';
  }

  const time = formatTimestamp(Number(o.time ?? Date.now()));
  const level = (LEVEL_LABELS[Number(o.level)] ?? '?????').padEnd(5);
  const ctx = (typeof o.context === 'string' ? o.context : '')
    .padEnd(20)
    .slice(0, 20);
  const msg = (typeof o.msg === 'string' ? o.msg : '').replace(/\n/g, '\\n');

  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.has(k)) continue;
    let s =
      typeof v === 'object' && v !== null
        ? JSON.stringify(v)
        : String(v).replace(/\n/g, '\\n');
    if (s.length > MAX_VAL_LEN) s = `${s.slice(0, MAX_VAL_LEN)}…`;
    parts.push(`${k}=${s}`);
  }

  const extra = parts.length ? `  ${parts.join('  ')}` : '';
  return `${time} ${level} --- [${ctx}] : ${msg}${extra}\n`;
}

export class LogbackTransform extends Transform {
  private buf = '';

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.buf += chunk.toString();
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.push(formatLogbackLine(line));
    }
    cb();
  }

  _flush(cb: () => void): void {
    if (this.buf.trim()) this.push(formatLogbackLine(this.buf));
    cb();
  }
}
