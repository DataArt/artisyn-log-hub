'use strict';

/**
 * Fixture tools of the tool-wrapper fidelity check (docs/knowledgebase/algorithms/tool-wrapper-fidelity.md,
 * "Fixture tools"). One source for both users:
 *   - `tool-wrap-fidelity.algo.test.js` writes them into its run dir when the verification project
 *     has no `bin/`;
 *   - `scripts/tool-wrap-check/create-check-project.mjs` writes them into
 *     `<repo>/../loghub-tool-wrap-check/bin/`.
 *
 * Every script is plain Bash with LF line endings (`zzc.cmd` is a Windows batch file with CRLF).
 * Not a test file (no `.test.js` suffix), so `hook/scripts/run-tests.js` does not run it.
 */

/** `printf` format writing the 256 bytes 0x00..0xFF as octal escapes. */
const ALL_BYTES_FORMAT = Array.from({ length: 256 }, (_, i) => `\\${i.toString(8).padStart(3, '0')}`).join('');

const HEADER = '# Log Hub tool-wrap fidelity fixture (generated; see docs/knowledgebase/algorithms/tool-wrapper-fidelity.md).';

/** @type {Record<string, { content: string, executable: boolean, windowsOnly?: boolean }>} */
const FIXTURE_TOOLS = {
  zz: {
    executable: true,
    content: [
      '#!/usr/bin/env bash',
      HEADER,
      '# zz [lines N | args A...]: N numbered lines (default 20000) or each argument in brackets;',
      '# then one stderr line; exit code from $ZZ_EXIT (default 0).',
      'mode=${1:-lines}',
      'case "$mode" in',
      '  args)',
      '    shift',
      '    for a in "$@"; do printf \'[%s]\\n\' "$a"; done',
      '    ;;',
      '  *)',
      '    n=${2:-20000}',
      '    i=1',
      '    while [ "$i" -le "$n" ]; do printf \'line %d of zz output\\n\' "$i"; i=$((i + 1)); done',
      '    ;;',
      'esac',
      'printf \'zz: %s done\\n\' "$mode" >&2',
      'exit "${ZZ_EXIT:-0}"',
      '',
    ].join('\n'),
  },
  zzbin: {
    executable: true,
    content: [
      '#!/usr/bin/env bash',
      HEADER,
      '# zzbin: writes the 256 bytes 0x00..0xFF once.',
      // Only escapes, no literal `%`: bash's printf emits an escaped `\045` as a plain `%`.
      `printf '${ALL_BYTES_FORMAT}'`,
      '',
    ].join('\n'),
  },
  zzin: {
    executable: true,
    content: [
      '#!/usr/bin/env bash',
      HEADER,
      '# zzin: copies each stdin line to stdout and, prefixed "err:", to stderr.',
      'while IFS= read -r l || [ -n "$l" ]; do',
      '  printf \'%s\\n\' "$l"',
      '  printf \'err:%s\\n\' "$l" >&2',
      'done',
      '',
    ].join('\n'),
  },
  zzsleep: {
    executable: true,
    content: [
      '#!/usr/bin/env bash',
      HEADER,
      '# zzsleep [S]: sleeps S seconds (default 30).',
      'sleep "${1:-30}"',
      '',
    ].join('\n'),
  },
  'zzc.cmd': {
    executable: false,
    windowsOnly: true,
    content: [
      '@echo off',
      'rem Log Hub tool-wrap fidelity fixture (generated). zzc: two lines, the arguments, one stderr line, exit 3.',
      'echo zzc line 1',
      'echo zzc line 2',
      'echo zzc args: %*',
      '>&2 echo zzc: stderr line',
      'exit /b 3',
      '',
    ].join('\r\n'),
  },
};

module.exports = { FIXTURE_TOOLS };
