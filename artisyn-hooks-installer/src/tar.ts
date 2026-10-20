import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal tar stream parser for hooks.tar.gz archives.
 * Handles ustar and GNU tar 512-byte header formats.
 * Skips entries with path traversal components.
 */
export function extractTarGz(buffer: Buffer, destDir: string): void {
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    offset += 512;

    // All-zero block signals end of archive
    if (isZeroBlock(header)) {
      break;
    }

    const name = readString(header, 0, 100);
    if (!name) {
      break;
    }

    const sizeStr = readString(header, 124, 12);
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);

    // Advance past file data (rounded up to 512-byte blocks)
    const dataOffset = offset;
    const blocks = Math.ceil(size / 512);
    offset += blocks * 512;

    // Only extract regular files (type '0' or '\0')
    if (typeflag !== '0' && typeflag !== '\0') {
      continue;
    }

    // Path traversal guard — skip any entry with '..' component
    const parts = name.split('/');
    if (parts.some(p => p === '..')) {
      console.error(`Skipping path-traversal entry: ${name}`);
      continue;
    }

    const destPath = resolveDestPath(name, destDir);
    if (!destPath) {
      continue;
    }

    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    const data = buffer.slice(dataOffset, dataOffset + size);
    fs.writeFileSync(destPath, data);
  }
}

/**
 * Read a single entry's raw content from a decompressed tar buffer without extracting to disk.
 * Returns null if the entry is not found.
 */
export function readTarEntry(buffer: Buffer, entryName: string): Buffer | null {
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    offset += 512;

    if (isZeroBlock(header)) {
      break;
    }

    const name = readString(header, 0, 100);
    if (!name) {
      break;
    }

    const sizeStr = readString(header, 124, 12);
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);

    const dataOffset = offset;
    const blocks = Math.ceil(size / 512);
    offset += blocks * 512;

    if ((typeflag === '0' || typeflag === '\0') && name === entryName) {
      return buffer.slice(dataOffset, dataOffset + size);
    }
  }

  return null;
}

/**
 * Map tar entry name to destination path inside destDir.
 *
 * Archive layout (repo-root-relative): every entry name is a path relative to the
 * repo root, not to `.claude/`, e.g.
 *   .artisyn/marketplace/.claude-plugin/marketplace.json
 *   .artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json
 *   .artisyn/marketplace/plugins/log-hub-hooks/hooks/hooks.json
 *   .artisyn/marketplace/plugins/log-hub-hooks/scripts/<file>.js (+ scripts/version.json)
 *   .artisyn/marketplace/plugins/log-hub-hooks/config-template/log-hub.json
 * Callers must pass the repo root as `destDir` (not `.claude/`) so these paths land correctly.
 *
 * Entries that would resolve outside destDir are rejected.
 */
function resolveDestPath(name: string, destDir: string): string | null {
  const resolved = path.resolve(destDir, name);
  const base = path.resolve(destDir);

  // Ensure resolved path stays inside destDir
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    console.error(`Skipping entry outside target dir: ${name}`);
    return null;
  }

  return resolved;
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.slice(offset, offset + length);
  const nullIdx = slice.indexOf(0);
  return slice.slice(0, nullIdx < 0 ? length : nullIdx).toString('utf8');
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}
