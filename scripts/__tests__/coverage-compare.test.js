'use strict';

// Pure logic of scripts/scenarios/coverage-compare.mjs (impl-plan DD L1, L2): which files are
// measured, how istanbul maps from different tools merge by line, the groups of the comparison,
// mutation scores from a Stryker report, and the CLI arguments. No coverage run happens here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before } = require('node:test');

let cc;

before(async () => {
  cc = await import('../scenarios/coverage-compare.mjs');
});

const ROOT = path.resolve('/repo');

/** An istanbul file entry with one statement per [line, hits] pair. */
function fileCov(file, lineHits) {
  const statementMap = {};
  const s = {};
  lineHits.forEach(([line, hits], i) => {
    statementMap[i] = { start: { line, column: 0 }, end: { line, column: 5 } };
    s[i] = hits;
  });
  return { path: file, statementMap, s };
}

describe('measured files and groups', () => {
  test('only product sources under the three roots, never tests', () => {
    assert.equal(cc.isMeasured('server/src/logs/cost.sql.ts'), true);
    assert.equal(cc.isMeasured('server/src/logs/cost.sql.spec.ts'), false);
    assert.equal(cc.isMeasured('server/test/helpers/x.ts'), false);
    assert.equal(cc.isMeasured('client/src/viewer/__tests__/unit/a.test.ts'), false);
    assert.equal(cc.isMeasured('client/src/viewer/pages/A.tsx'), true);
    assert.equal(cc.isMeasured('hook/.claude/telemetry_tool/upload-logs.js'), true);
    assert.equal(cc.isMeasured('hook/.claude/telemetry_tool/__tests__/upload-logs.test.js'), false);
    assert.equal(cc.isMeasured(null), false);
  });

  test('groups by first directory, root files in "(root)"', () => {
    assert.equal(cc.groupOf('server/src/logs/change-surface/m.ts'), 'server/src/logs');
    assert.equal(cc.groupOf('server/src/main.ts'), 'server/src/(root)');
    assert.equal(cc.groupOf('client/src/viewer/pages/repository/A.tsx'), 'client/src/viewer/pages');
    assert.equal(cc.groupOf('client/src/main.tsx'), 'client/src/(other)');
    assert.equal(cc.groupOf('hook/.claude/telemetry_tool/a.js'), 'hook/.claude/telemetry_tool');
  });

  test('toRepoPath rejects files outside the repo', () => {
    assert.equal(cc.toRepoPath(path.join(ROOT, 'server', 'src', 'a.ts'), ROOT), 'server/src/a.ts');
    assert.equal(cc.toRepoPath(path.resolve('/elsewhere/a.ts'), ROOT), null);
  });
});

describe('line merge', () => {
  test('a line is covered when any source ran a statement on it; totals are a union', () => {
    const file = path.join(ROOT, 'server', 'src', 'logs', 'a.ts');
    const jest = { [file]: fileCov(file, [[1, 1], [2, 0], [3, 0]]) };
    const stand = { [file]: fileCov(file, [[2, 4], [3, 0], [4, 0], [4, 2]]) };
    const s = cc.summarizeCoverage(cc.mergeCoverageMaps([jest, stand], ROOT));
    assert.deepEqual(s.files['server/src/logs/a.ts'], { lines: 4, covered: 3, pct: 75 });
    assert.deepEqual(s.groups['server/src/logs'], { files: 1, lines: 4, covered: 3, pct: 75 });
    assert.deepEqual(s.total, { lines: 4, covered: 3, pct: 75 });
  });

  test('test files and foreign paths in a report are ignored', () => {
    const spec = path.join(ROOT, 'server', 'src', 'a.spec.ts');
    const foreign = path.resolve('/elsewhere/x.ts');
    const merged = cc.mergeCoverageMaps(
      [{ [spec]: fileCov(spec, [[1, 1]]), [foreign]: fileCov(foreign, [[1, 1]]) }],
      ROOT,
    );
    assert.equal(merged.size, 0);
  });

  test('compare report flags groups and files whose coverage fell', () => {
    const base = {
      generatedAt: 'b',
      total: { pct: 80 },
      groups: { 'server/src/logs': { pct: 80, lines: 10 } },
      files: { 'server/src/logs/a.ts': { pct: 80, covered: 8, lines: 10 } },
    };
    const now = {
      generatedAt: 'n',
      total: { pct: 50 },
      groups: { 'server/src/logs': { pct: 50, lines: 10 } },
      files: { 'server/src/logs/a.ts': { pct: 50, covered: 5, lines: 10 } },
    };
    const md = cc.coverageCompareMarkdown(base, now);
    assert.match(md, /`server\/src\/logs` ↓ \| 80\.00% \| 50\.00% \| -30\.00/);
    assert.match(md, /Files whose coverage fell \(1\)/);
  });
});

describe('mutation', () => {
  const report = (statuses) => ({
    projectRoot: path.join(ROOT, 'server'),
    files: { 'src/logs/cost.sql.ts': { mutants: statuses.map((status) => ({ status })) } },
  });

  test('score counts killed + timeout over every detectable mutant; errors are excluded', () => {
    const s = cc.summarizeMutation(
      report(['Killed', 'Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError']),
      ROOT,
    );
    const m = s.modules['server/src/logs/cost.sql.ts'];
    assert.equal(m.mutants, 5);
    assert.equal(m.excluded, 1);
    assert.equal(m.score, 60);
    assert.equal(m.coveredScore, 75);
    assert.equal(s.total.score, 60);
  });

  test('a module below its baseline is a regression', () => {
    const base = cc.summarizeMutation(report(['Killed', 'Killed']), ROOT);
    const worse = cc.summarizeMutation(report(['Killed', 'Survived']), ROOT);
    assert.deepEqual(cc.mutationCompareMarkdown(base, worse).regressions, ['server/src/logs/cost.sql.ts']);
    assert.deepEqual(cc.mutationCompareMarkdown(base, base).regressions, []);
  });
});

describe('CLI', () => {
  test('parseArgs needs exactly one action and validates --kind', () => {
    assert.deepEqual(cc.parseArgs(['--compare', '--coverage-dir=tmp/x']), {
      kind: 'coverage',
      action: 'compare',
      coverageDir: 'tmp/x',
      report: null,
      baseline: null,
      out: null,
    });
    assert.equal(cc.parseArgs(['--kind', 'mutation', '--save-baseline']).kind, 'mutation');
    assert.throws(() => cc.parseArgs([]), /--save-baseline or --compare/);
    assert.throws(() => cc.parseArgs(['--compare', '--save-baseline']), /exactly one/);
    assert.throws(() => cc.parseArgs(['--save-baseline', '--kind', 'x']), /unknown --kind/);
    assert.throws(() => cc.parseArgs(['--bogus']), /unknown argument/);
  });

  test('save then compare round-trips through files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-compare-test-'));
    const write = process.stdout.write;
    try {
      const file = path.join(dir, 'server', 'src', 'a.ts');
      fs.mkdirSync(path.join(dir, 'cov', 'server'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cov', 'server', 'coverage-final.json'),
        JSON.stringify({ [file]: fileCov(file, [[1, 1], [2, 0]]) }),
      );
      process.stdout.write = () => true;
      assert.equal(cc.main(['--save-baseline', '--coverage-dir', 'cov', '--baseline', 'base.json'], dir), 0);
      assert.equal(
        cc.main(['--compare', '--coverage-dir', 'cov', '--baseline', 'base.json', '--out', 'cmp.md'], dir),
        0,
      );
      process.stdout.write = write;
      const base = JSON.parse(fs.readFileSync(path.join(dir, 'base.json'), 'utf8'));
      assert.deepEqual(base.total, { lines: 2, covered: 1, pct: 50 });
      assert.deepEqual(base.sources, ['cov/server/coverage-final.json']);
      assert.match(fs.readFileSync(path.join(dir, 'cmp.md'), 'utf8'), /Files whose coverage fell \(0\)/);
    } finally {
      process.stdout.write = write;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
