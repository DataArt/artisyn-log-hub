'use strict';

// Preloaded into a coverage stand (`node --require coverage-flush.cjs index.js`, impl-plan DD L1).
//
// NODE_V8_COVERAGE is written only when the process exits normally, but stopStand() ends the stand
// with a hard process-tree kill (taskkill /F on Windows, SIGKILL elsewhere), which would lose it.
// So stopStand() first creates STAND_COVERAGE_FLUSH_FILE; this poller sees it, calls
// v8.takeCoverage() — which writes the profile into NODE_V8_COVERAGE right away — and answers with
// `<flush file>.done`. No IPC channel is used: the server treats a process with `process.send` as a
// cluster worker.

const fs = require('fs');
const v8 = require('v8');

const flushFile = process.env.STAND_COVERAGE_FLUSH_FILE;

if (flushFile && process.env.NODE_V8_COVERAGE) {
  const timer = setInterval(() => {
    if (!fs.existsSync(flushFile)) return;
    clearInterval(timer);
    try {
      v8.takeCoverage();
      fs.writeFileSync(`${flushFile}.done`, 'ok\n', 'utf8');
    } catch (err) {
      fs.writeFileSync(`${flushFile}.done`, `error: ${err && err.message}\n`, 'utf8');
    }
  }, 200);
  timer.unref();
}
