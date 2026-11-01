'use strict';

/**
 * Drop malformed lines from an NDJSON body just before it is uploaded.
 *
 * WHY this exists: a session's `.jsonl` is appended to by several independent hook processes
 * (`telemetry-hook`, `lifecycle-hook`; `guardrail-hook` before 2.19.0), with no lock and no temp+rename. A hook
 * killed mid-`appendFileSync` — Claude Code enforces a hook timeout — or two large concurrent
 * appends interleaving leave a permanently broken line in the middle of the file. The server's
 * ingest is all-or-nothing (`parseNdjsonLines()` throws on the first bad line), so one torn record
 * makes that whole session un-ingestable *forever*: every later upload re-sends the same bad byte
 * and fails again, and each failure leaves another `failed` row in the server's upload queue. On
 * the dev instance that turned 7 corrupted sessions into 50 stuck queue rows over nine days.
 *
 * Dropping the line here trades one lost telemetry event for the rest of the session, which is the
 * right trade: a single event never moves aggregate statistics, whereas losing the session does.
 *
 * This is deliberately NOT a silent trim (the concern `send-logs-hook.js` records about the old
 * otel trailing-line trim): every dropped line is reported to the caller, which writes it to the
 * local `hook.log` with its line number, byte length and parse error, so the corruption stays
 * visible and diagnosable instead of being quietly papered over.
 */

const NEWLINE = 0x0a;

/** How much of a dropped line to keep for the log message. Deliberately short: the line can carry
 *  a full user prompt or tool input, and `hook.log`'s tail is itself uploaded (`hook-status`
 *  event's `logTail`). Enough to recognise a truncation or a splice, not enough to re-publish the
 *  payload. */
const SNIPPET_CHARS = 120;

/**
 * Split `body` on `\n` and drop every non-blank line that is not parseable JSON.
 *
 * Byte-preserving by construction: kept lines are re-emitted as the original buffer slices,
 * newline included, and a body with nothing to drop is returned as the very same Buffer object
 * (no copy, no re-encode) so the overwhelmingly common healthy case stays byte-identical to not
 * calling this at all. Blank lines are kept as-is — the server skips them.
 *
 * @param {Buffer} body raw NDJSON bytes as read from disk
 * @returns {{ body: Buffer, dropped: Array<{ lineNo: number, bytes: number, reason: string,
 *   snippet: string }>, lines: number }} `body` is the sanitized payload to upload (possibly
 *   empty, if every line was malformed — the caller decides what to do with that); `lines` is the
 *   number of lines scanned, for the "dropped 1 of 4213" style log message.
 */
function sanitizeNdjson(body) {
  const dropped = [];
  const kept = [];
  let lineNo = 0;
  let offset = 0;

  while (offset < body.length) {
    const nl = body.indexOf(NEWLINE, offset);
    // `end` excludes the newline (that's what gets parsed); `next` includes it (that's what gets
    // re-emitted), so a final line without a trailing newline stays without one.
    const end = nl === -1 ? body.length : nl;
    const next = nl === -1 ? body.length : nl + 1;
    lineNo++;

    const text = body.toString('utf8', offset, end).trim();
    if (text.length === 0) {
      kept.push(body.subarray(offset, next));
      offset = next;
      continue;
    }

    let reason = null;
    try {
      JSON.parse(text);
    } catch (err) {
      reason = err.message;
    }

    if (reason === null) {
      kept.push(body.subarray(offset, next));
    } else {
      dropped.push({
        lineNo,
        bytes: end - offset,
        reason,
        // JSON.stringify escapes the embedded newlines/quotes a spliced line is full of, keeping
        // the log entry on one line.
        snippet: JSON.stringify(text.slice(0, SNIPPET_CHARS)),
      });
    }

    offset = next;
  }

  if (dropped.length === 0) return { body, dropped, lines: lineNo };
  return { body: Buffer.concat(kept), dropped, lines: lineNo };
}

/**
 * Render `sanitizeNdjson()`'s `dropped` list as `hook.log` lines.
 *
 * One summary line plus one detail line per dropped record, capped so a wholesale-corrupt file
 * cannot flood a 100 KB rotating log with thousands of entries.
 *
 * @param {string} manifestKey the `namespace/file` label the upload logs everywhere else
 * @param {{ dropped: Array<{ lineNo: number, bytes: number, reason: string, snippet: string }>,
 *   lines: number }} result as returned by {@link sanitizeNdjson}
 * @param {number} [maxDetailLines] how many per-line details to emit before summarising the rest
 * @returns {string[]} messages to pass to `hookLog(..., 'warn', msg, ...)`, empty when nothing was
 *   dropped
 */
function formatDroppedLines(manifestKey, result, maxDetailLines = 5) {
  const { dropped, lines } = result;
  if (dropped.length === 0) return [];

  const messages = [
    `${manifestKey}: dropped ${dropped.length} malformed JSON line(s) of ${lines} before upload`
    + ' — the log file has a torn/interleaved record; the rest of the session was uploaded',
  ];

  for (const d of dropped.slice(0, maxDetailLines)) {
    messages.push(
      `${manifestKey}: dropped line ${d.lineNo} (${d.bytes} bytes): ${d.reason} | ${d.snippet}`,
    );
  }
  if (dropped.length > maxDetailLines) {
    messages.push(`${manifestKey}: ... and ${dropped.length - maxDetailLines} more dropped line(s)`);
  }

  return messages;
}

module.exports = { sanitizeNdjson, formatDroppedLines, SNIPPET_CHARS };
