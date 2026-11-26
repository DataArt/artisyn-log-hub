// AgentBook macOS build from Windows or Linux (`npm run build:macos` from agentbook/): no Mac needed.
// 1. Writes Info.plist and AgentBook.icns (from crates/app/images/icon-*.png) into
//    target/macos/stage/.
// 2. In the cargo-zigbuild Docker image (Zig as the linker, a macOS SDK inside), builds the app
//    crate for aarch64 + x86_64 and merges them (`universal2-apple-darwin`), assembles
//    AgentBook.app, signs it ad hoc with rcodesign (no Apple Developer ID: Gatekeeper still asks
//    once, see the README written next to the zip) and zips it with the Unix modes kept.
// Output: target/macos/AgentBook-<version>-macos.zip (AgentBook.app + README-macOS.txt).
// Writes only into agentbook/target and three named Docker volumes (ab-mac-rustup, ab-mac-cargo,
// ab-mac-target: toolchain, crate cache, build cache). Needs Docker. Exits non-zero on failure.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'target', 'macos');
const STAGE = path.join(OUT, 'stage');
// Docker Hub, not ghcr.io: the ghcr pull of this multi-GB image stalls on some networks.
const IMAGE = 'messense/cargo-zigbuild:0.24.1';
const RCODESIGN_VERSION = '0.29.0';
const BUNDLE_ID = 'com.artisyn.agentbook';
const TARGET = 'universal2-apple-darwin';

function fail(message) {
  process.stderr.write(`build-macos: ${message}\n`);
  process.exit(1);
}

function version() {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'version.mjs')], { encoding: 'utf8' }).trim();
}

// ICNS: 'icns' + total length, then (type, length incl. 8-byte header, PNG bytes) per size.
function icns() {
  const types = [
    [16, 'icp4'],
    [32, 'icp5'],
    [64, 'icp6'],
    [256, 'ic08'],
  ];
  const chunks = types.map(([size, type]) => {
    const png = fs.readFileSync(path.join(ROOT, 'crates', 'app', 'images', `icon-${size}.png`));
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

function infoPlist(ver) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>AgentBook</string>
  <key>CFBundleExecutable</key><string>AgentBook</string>
  <key>CFBundleIconFile</key><string>AgentBook</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>AgentBook</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${ver}</string>
  <key>CFBundleVersion</key><string>${ver}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
`;
}

const README = `AgentBook for macOS (unsigned test build)
=========================================

1. Unzip, move AgentBook.app to /Applications (or anywhere).
2. This build is signed ad hoc, not with an Apple Developer ID, so macOS refuses the first
   start. Either:
   - double-click AgentBook.app, press Done, then System Settings > Privacy & Security >
     "AgentBook was blocked" > Open Anyway; or
   - in Terminal: xattr -dr com.apple.quarantine /Applications/AgentBook.app
3. Needs Docker Desktop (or OrbStack / Colima with a Docker socket) running, and Claude Desktop.
4. The first start downloads Node.js and the Dev Container CLI into
   ~/Library/Application Support/AgentBook and builds the standard Equipment image.
5. Hidden variable values are kept in the login Keychain (service "AgentBook"); macOS may ask
   once to allow AgentBook to use it.
`;

// The commands run inside the image, joined with &&. Paths are container paths.
function containerScript(ver) {
  const zipName = `AgentBook-${ver}-macos.zip`;
  const rcodesignUrl =
    `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/` +
    `apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl.tar.gz`;
  return [
    'set -e',
    'rustup target add aarch64-apple-darwin x86_64-apple-darwin',
    `cargo zigbuild --release --locked -p agentbook --target ${TARGET}`,
    // rcodesign (ad hoc signing of the bundle) and zip, cached in the cargo volume.
    `if [ ! -x /usr/local/cargo/registry/bin/rcodesign ]; then mkdir -p /usr/local/cargo/registry/bin /tmp/rcs && ` +
      `curl -fsSL "${rcodesignUrl}" | tar -xz -C /tmp/rcs && ` +
      'cp /tmp/rcs/*/rcodesign /usr/local/cargo/registry/bin/rcodesign; fi',
    'command -v zip >/dev/null || (apt-get update -qq && apt-get install -y -qq zip >/dev/null)',
    'rm -rf /tmp/pkg && mkdir -p /tmp/pkg/AgentBook.app/Contents/MacOS /tmp/pkg/AgentBook.app/Contents/Resources',
    `install -m 755 /target/${TARGET}/release/AgentBook /tmp/pkg/AgentBook.app/Contents/MacOS/AgentBook`,
    'install -m 644 /out/stage/Info.plist /tmp/pkg/AgentBook.app/Contents/Info.plist',
    'install -m 644 /out/stage/AgentBook.icns /tmp/pkg/AgentBook.app/Contents/Resources/AgentBook.icns',
    'printf "APPL????" > /tmp/pkg/AgentBook.app/Contents/PkgInfo',
    'install -m 644 /out/stage/README-macOS.txt /tmp/pkg/README-macOS.txt',
    `/usr/local/cargo/registry/bin/rcodesign sign --code-signature-flags runtime /tmp/pkg/AgentBook.app`,
    'file /tmp/pkg/AgentBook.app/Contents/MacOS/AgentBook',
    `cd /tmp/pkg && rm -f "/out/${zipName}" && zip -qry "/out/${zipName}" AgentBook.app README-macOS.txt`,
    `ls -l "/out/${zipName}"`,
  ].join(' && ');
}

try {
  const ver = version();
  fs.mkdirSync(STAGE, { recursive: true });
  fs.writeFileSync(path.join(STAGE, 'Info.plist'), infoPlist(ver), 'utf8');
  fs.writeFileSync(path.join(STAGE, 'AgentBook.icns'), icns());
  fs.writeFileSync(path.join(STAGE, 'README-macOS.txt'), README, 'utf8');

  const args = [
    'run', '--rm',
    '-v', `${ROOT}:/src:ro`,
    '-v', `${OUT}:/out`,
    '-v', 'ab-mac-rustup:/usr/local/rustup',
    '-v', 'ab-mac-cargo:/usr/local/cargo/registry',
    '-v', 'ab-mac-target:/target',
    '-e', 'CARGO_TARGET_DIR=/target',
    // Header room for the code-signature load command rcodesign adds (Zig's linker leaves none).
    '-e', 'RUSTFLAGS=-C link-arg=-Wl,-headerpad_max_install_names',
    '-w', '/src',
    IMAGE,
    'bash', '-c', containerScript(ver),
  ];
  process.stdout.write(`build-macos: docker run ${IMAGE} (AgentBook ${ver}, ${TARGET})\n`);
  // MSYS_NO_PATHCONV keeps Git Bash from rewriting the container paths when run from it.
  const result = spawnSync('docker', args, { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (result.error) fail(`cannot run docker: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
  const zip = path.join(OUT, `AgentBook-${ver}-macos.zip`);
  if (!fs.existsSync(zip)) fail(`${zip} was not produced`);
  process.stdout.write(`build-macos: ${zip} (${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB)\n`);
  process.exit(0);
} catch (err) {
  fail(err.message);
}
