/**
 * pdf-text.ts — minimal text extraction from a downloaded PDF, for e2e assertions.
 *
 * The report PDFs are produced by `@react-pdf/renderer`, which writes each visible
 * string into a Flate-compressed content stream as a text-showing operator:
 *
 * ```
 * BT /F1 8 Tf [<6e6f207072> -15 <6963696e67> 0] TJ ET     // "no pr" + "icing"
 * ```
 *
 * Two details of that shape drive this implementation:
 *  - the operands are **hex** strings, not `(literal)` ones (verified against a real
 *    `@react-pdf/renderer` v4 export), and the elements of one `TJ` array are kerning
 *    fragments of a single word — they must be joined with NO separator, or "pricing"
 *    comes back as "pr icing";
 *  - each laid-out line is its own operator, so consecutive operators ARE separated by
 *    whitespace — a cell that wraps ("no" / "pricing") must still read as "no pricing".
 *
 * Hence: concatenate within an operator, join across operators with a space, collapse
 * runs of whitespace. Match with a tolerant regexp (`/no\s+pricing/`), never with
 * exact spacing.
 *
 * Deliberately NOT a PDF parser: it knows nothing about pages, layout or reading order,
 * and only answers "does this document contain this phrase" — which is all an export
 * assertion needs, the on-page rendering being asserted through the DOM.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';

const STREAM = Buffer.from('stream');
const ENDSTREAM = Buffer.from('endstream');

/** Inflates every `stream … endstream` body, falling back to the raw bytes. */
function inflateStreams(buf: Buffer): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = buf.indexOf(STREAM, cursor);
    if (start === -1) break;
    // `indexOf('stream')` also matches the tail of `endstream`; skip those.
    if (
      start >= 3 &&
      buf.subarray(start - 3, start).toString('latin1') === 'end'
    ) {
      cursor = start + STREAM.length;
      continue;
    }
    let dataStart = start + STREAM.length;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const end = buf.indexOf(ENDSTREAM, dataStart);
    if (end === -1) break;
    const body = buf.subarray(dataStart, end);
    try {
      chunks.push(zlib.inflateSync(body).toString('latin1'));
    } catch {
      // Not a Flate stream (or not a stream at all) — keep the bytes as-is.
      chunks.push(body.toString('latin1'));
    }
    cursor = end + ENDSTREAM.length;
  }
  return chunks;
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '(': '(',
  ')': ')',
  '\\': '\\',
};

/** Decodes one `( … )` PDF string literal body. */
function decodeLiteral(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const next = body[i + 1] ?? '';
    if (next in ESCAPES) {
      out += ESCAPES[next];
      i += 2;
    } else if (next >= '0' && next <= '7') {
      let octal = '';
      i++;
      while (octal.length < 3 && body[i] >= '0' && body[i] <= '7') {
        octal += body[i];
        i++;
      }
      out += String.fromCharCode(parseInt(octal, 8));
    } else {
      out += next;
      i += 2;
    }
  }
  return out;
}

/** Decodes one `< … >` hex string body (WinAnsi ≈ latin1 for the characters we assert on). */
function decodeHex(body: string): string {
  const hex = body.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/** `[ … ] TJ` and `( … ) Tj` / `< … > Tj` — one entry per text-showing operator. */
const TEXT_OPERATOR = /(\[[^\]]*\]|\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)\s*(?:TJ|Tj)/g;
const STRING_TOKEN = /\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]*)>/g;

/** One string per text-showing operator in `content`, in stream order. */
function textRuns(content: string): string[] {
  const runs: string[] = [];
  for (const opMatch of content.matchAll(TEXT_OPERATOR)) {
    let run = '';
    for (const token of opMatch[1].matchAll(STRING_TOKEN)) {
      run +=
        token[1] !== undefined ? decodeLiteral(token[1]) : decodeHex(token[2]);
    }
    if (run.length > 0) runs.push(run);
  }
  return runs;
}

/** All rendered text of the PDF at `pdfPath`, whitespace-normalised. */
export function extractPdfText(pdfPath: string): string {
  const buf = fs.readFileSync(pdfPath);
  const runs = inflateStreams(buf).flatMap(textRuns);
  return runs.join(' ').replace(/\s+/g, ' ').trim();
}

/** Number of non-overlapping matches of `pattern` in `text`. */
export function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  return text.match(new RegExp(pattern.source, flags))?.length ?? 0;
}
