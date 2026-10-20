import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

interface ValidationError {
  file: string;
  line: number;
  text: string;
  reason: string;
}

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /CREATE\s+INDEX\s+CONCURRENTLY/i,
    reason:
      'CONCURRENTLY cannot run inside a transaction block. ' +
      "Drizzle's migrate() always wraps migrations in BEGIN/COMMIT. " +
      'Use CREATE INDEX IF NOT EXISTS (without CONCURRENTLY) instead.',
  },
];

export function validateMigrationFiles(migrationsFolder: string): void {
  let files: string[];
  try {
    files = readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    return; // folder existence is checked separately
  }

  const errors: ValidationError[] = [];

  for (const file of files) {
    const content = readFileSync(join(migrationsFolder, file), 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        if (pattern.test(lines[i])) {
          errors.push({ file, line: i + 1, text: lines[i].trim(), reason });
        }
      }
    }
  }

  if (errors.length > 0) {
    const details = errors
      .map((e) => `  ${e.file}:${e.line}  →  ${e.text}\n     ${e.reason}`)
      .join('\n');
    throw new Error(
      `Migration validation failed — forbidden SQL patterns found:\n${details}\n` +
        'Fix these migration files before starting the server.',
    );
  }
}
