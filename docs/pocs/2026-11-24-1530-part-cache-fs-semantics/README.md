---
type: "PoC"
title: "Part cache file-system semantics (rename / unlink / utimes on open files)"
description: "Checks how rename over an existing file, unlink and utimes behave while a reader holds the file open — the operations the session-part disk cache relies on."
---

# PoC: part cache file-system semantics

Task: [2026-11-24-session-parts-disk-cache](../../tasks/todo/2026-11-24-session-parts-disk-cache/requirements.md)
(FR-5 atomic fill, FR-6 old revisions, FR-7 last-read mtime, FR-8 sweep, FR-9 deleted data).

## Question

While one request streams a cache file (`fs.createReadStream`) or holds it open:

1. Does `fs.rename(tmp, final)` succeed when `final` already exists (another cluster worker filled
   it first)?
2. Can the file be unlinked (sweep / FR-6 / FR-9), and does the open stream still read every byte?
3. Can its mtime be set with `fs.utimes` (FR-7)?

## How to run

```
node poc.mjs
```

It writes into a fresh `partcache-poc-*` folder under the OS temp dir and leaves it there for
manual cleanup.

## Result

Windows 11, Node 26:

| Operation while the file is open | Result |
|---|---|
| `rename(tmp, final)` with `final` existing and open | **`EPERM`** |
| `unlink(final)` while a `createReadStream` reads it | ok; the stream still reads all bytes |
| `utimes(final)` | ok |

On Linux (the release image) `rename` atomically replaces an open file and `unlink` of an open file
is always allowed, so Windows is the only constraint.

Conclusions for the plan:

- The fill never needs to replace an existing final file: files are immutable per revision, so the
  writer skips the write when the final file already exists, and treats a rename failing with
  `EPERM` / `EEXIST` / `EBUSY` while the final file exists as success (drop the temp file).
- Sweep / FR-6 / FR-9 deletions are safe while a hit is streaming the same file.
- `utimes` on a file being served is fine.
