#!/usr/bin/env node
// Minimal, dependency-free ZIP writer. scripts/release-kit.js uses it to pack the install kit
// (artisyn-log-hub-<version>.zip, a handful of small text files) for the GitHub Release;
// scripts/local-release-bundle.js uses it to pack the offline per-architecture test bundles.
//
// Why hand-rolled rather than a library or a shell tool: the repo deliberately keeps its build
// scripts on Node built-ins only, and the obvious shell alternatives are all host-specific
// (PowerShell's Compress-Archive is Windows-only, `zip` is absent on Windows, and `tar -a`
// speaks zip only via bsdtar). This runs the same everywhere.
//
// Entries are STORED, not deflated. The install kit is a few KiB of text, so compression would
// save next to nothing, and a local bundle is ~99% one `docker save` tar whose image layers are
// already compressed. STORED keeps the writer small and streaming.
const fs = require('fs');
const path = require('path');

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_STORE = 0;
const VERSION_NEEDED = 20;
const ZIP32_MAX = 0xffffffff;

// Read in chunks so a ~100 MB image tar is never held in memory in full.
const CHUNK_SIZE = 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf, seed) {
  let c = seed ^ -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return c ^ -1;
}

// ZIP stores mtimes as a packed MS-DOS date/time pair with 2-second resolution and a 1980 epoch.
function dosDateTime(mtime) {
  const year = mtime.getFullYear();
  if (year < 1980) {
    return { time: 0, date: (1 << 5) | 1 };
  }
  return {
    time: (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | Math.floor(mtime.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate(),
  };
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL_HEADER_SIG, 0);
  head.writeUInt16LE(VERSION_NEEDED, 4);
  head.writeUInt16LE(0, 6); // flags
  head.writeUInt16LE(METHOD_STORE, 8);
  head.writeUInt16LE(entry.time, 10);
  head.writeUInt16LE(entry.date, 12);
  head.writeUInt32LE(entry.crc >>> 0, 14);
  head.writeUInt32LE(entry.size, 18); // compressed === uncompressed when stored
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([head, name]);
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
  head.writeUInt16LE(VERSION_NEEDED, 4); // version made by
  head.writeUInt16LE(VERSION_NEEDED, 6);
  head.writeUInt16LE(0, 8); // flags
  head.writeUInt16LE(METHOD_STORE, 10);
  head.writeUInt16LE(entry.time, 12);
  head.writeUInt16LE(entry.date, 14);
  head.writeUInt32LE(entry.crc >>> 0, 16);
  head.writeUInt32LE(entry.size, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30); // extra field length
  head.writeUInt16LE(0, 32); // file comment length
  head.writeUInt16LE(0, 34); // disk number start
  head.writeUInt16LE(0, 36); // internal attributes
  head.writeUInt32LE(0, 38); // external attributes
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

function endOfCentralDirectory(count, size, offset) {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(size, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return eocd;
}

// Every file under dir, depth-first, as ZIP entry names: forward slashes, prefixed with the
// folder's own name so unzipping produces one directory instead of scattering files.
function collectFiles(dir, prefix) {
  const files = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolute = path.join(dir, item.name);
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      files.push(...collectFiles(absolute, name));
    } else if (item.isFile()) {
      files.push({ absolute, name });
    }
  }
  return files;
}

// Copies one file into the open archive at `position`, returning its CRC.
//
// Every write here passes an explicit position rather than relying on the descriptor's implicit
// one. Mixing the two is not safe: a positioned write leaves the file offset untouched on
// platforms where Node maps it to pwrite(2) but not everywhere, so an implicitly positioned
// write following the CRC patch below could land at the wrong offset.
function writeStoredFile(zipFd, absolute, size, position) {
  const buffer = Buffer.alloc(CHUNK_SIZE);
  const srcFd = fs.openSync(absolute, 'r');
  try {
    let crc = 0;
    let copied = 0;
    let read = fs.readSync(srcFd, buffer, 0, CHUNK_SIZE, null);
    while (read > 0) {
      crc = crc32(buffer.subarray(0, read), crc);
      fs.writeSync(zipFd, buffer, 0, read, position + copied);
      copied += read;
      read = fs.readSync(srcFd, buffer, 0, CHUNK_SIZE, null);
    }
    if (copied !== size) {
      throw new Error(`size changed while archiving ${absolute} (${size} -> ${copied})`);
    }
    return crc;
  } finally {
    fs.closeSync(srcFd);
  }
}

// Packs dir into destZip. No ZIP64 support: the format's 32-bit size fields cap an entry and
// the archive at 4 GiB, which a release is nowhere near — but fail loudly rather than write a
// silently truncated archive if that ever stops being true.
function zipDir(dir, destZip) {
  const prefix = path.basename(dir);
  const files = collectFiles(dir, prefix);
  if (files.length === 0) {
    throw new Error(`nothing to archive: ${dir} is empty`);
  }

  const entries = [];
  let offset = 0;
  const zipFd = fs.openSync(destZip, 'w');
  try {
    for (const file of files) {
      const stat = fs.statSync(file.absolute);
      if (stat.size > ZIP32_MAX) {
        throw new Error(`${file.name} is larger than 4 GiB, which needs ZIP64 support`);
      }
      const { time, date } = dosDateTime(stat.mtime);
      const entry = {
        name: file.name, size: stat.size, time, date, offset, crc: 0,
      };

      // The CRC is only known after the bytes are read, so the header goes down as a
      // placeholder and gets patched in place once the copy is done.
      const placeholder = localHeader(entry);
      fs.writeSync(zipFd, placeholder, 0, placeholder.length, offset);
      entry.crc = writeStoredFile(zipFd, file.absolute, stat.size, offset + placeholder.length);
      const crcField = Buffer.alloc(4);
      crcField.writeUInt32LE(entry.crc >>> 0, 0);
      fs.writeSync(zipFd, crcField, 0, 4, offset + 14);

      offset += placeholder.length + stat.size;
      entries.push(entry);
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const entry of entries) {
      const head = centralHeader(entry);
      fs.writeSync(zipFd, head, 0, head.length, centralOffset + centralSize);
      centralSize += head.length;
    }
    const eocd = endOfCentralDirectory(entries.length, centralSize, centralOffset);
    fs.writeSync(zipFd, eocd, 0, eocd.length, centralOffset + centralSize);

    if (centralOffset + centralSize + eocd.length > ZIP32_MAX) {
      throw new Error(`${destZip} exceeds 4 GiB, which needs ZIP64 support`);
    }
  } finally {
    fs.closeSync(zipFd);
  }

  return fs.statSync(destZip).size;
}

module.exports = { zipDir };
