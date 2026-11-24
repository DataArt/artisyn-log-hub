// PoC: on this OS, can we (a) rename a temp file over an existing final file that a reader has
// open, (b) unlink a file a reader has open, (c) utimes a file a reader has open?
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partcache-poc-'));
const final = path.join(dir, '1.json.gz');
fs.writeFileSync(final, Buffer.alloc(1024 * 1024, 1));
const results = {};
const fd = fs.openSync(final, 'r'); // simulate createReadStream holding the file
const tmp = path.join(dir, '.tmp-1-123.json.gz');
fs.writeFileSync(tmp, Buffer.alloc(10, 2));
try { fs.renameSync(tmp, final); results.renameOverOpen = 'ok'; } catch (e) { results.renameOverOpen = e.code; }
try { fs.utimesSync(final, new Date(), new Date(Date.now() - 86400e3)); results.utimesOpen = 'ok'; } catch (e) { results.utimesOpen = e.code; }
// a stream opened via createReadStream (libuv uses FILE_SHARE_DELETE on Windows)
const final2 = path.join(dir, '2.json.gz');
fs.writeFileSync(final2, Buffer.alloc(1024 * 1024, 3));
const rs = fs.createReadStream(final2, { highWaterMark: 1024 });
await new Promise((r) => rs.once('readable', r));
try { fs.unlinkSync(final2); results.unlinkWhileStreaming = 'ok'; } catch (e) { results.unlinkWhileStreaming = e.code; }
let bytes = 0;
try { for await (const c of rs) bytes += c.length; results.streamAfterUnlink = `read ${bytes + 1024}`; } catch (e) { results.streamAfterUnlink = e.code; }
const tmp3 = path.join(dir, '.tmp-3.json.gz');
fs.writeFileSync(tmp3, 'x');
const fd3 = fs.openSync(path.join(dir, '1.json.gz'), 'r');
try { fs.renameSync(tmp3, path.join(dir, '1.json.gz')); results.renameOverOpenFsOpen = 'ok'; } catch (e) { results.renameOverOpenFsOpen = e.code; }
fs.closeSync(fd3);
fs.closeSync(fd);
console.log(JSON.stringify({ platform: process.platform, node: process.version, ...results }));
console.log("temp dir left for manual cleanup (OS temp, prefix partcache-poc-)");
