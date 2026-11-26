#!/usr/bin/env node
// Local text-to-image generator: stable-diffusion.cpp (C++, CUDA) + FLUX.1-schnell (Apache 2.0).
// No Python. Runs in Docker (default, needs `docker run --gpus all`) or as a native Windows binary.
// Docs: docs/knowledgebase/local-image-generation.md
//
//   node scripts/imagegen.js setup [--native]
//   node scripts/imagegen.js gen --prompt "..." --out path/to/file.png [options]
//   node scripts/imagegen.js --help
//
// Models and binaries live in IMAGEGEN_HOME (default: <repo>/tmp/imagegen, gitignored).
// Output PNGs are stripped of text chunks (sd.cpp writes the prompt and model paths there) so no
// machine paths reach git; a sidecar <name>.json keeps prompt/seed/size/model name only.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const HOME = path.resolve(process.env.IMAGEGEN_HOME || path.join(REPO, 'tmp', 'imagegen'));
const MODELS = path.join(HOME, 'models');
const BIN = path.join(HOME, 'bin');
const DOCKER_IMAGE = process.env.IMAGEGEN_DOCKER_IMAGE || 'ghcr.io/leejet/stable-diffusion.cpp:master-cuda';
const SD_RELEASE = 'leejet/stable-diffusion.cpp';

const MODEL_FILES = {
  diffusion: {
    file: 'flux1-schnell-Q5_K_S.gguf',
    url: 'https://huggingface.co/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q5_K_S.gguf',
  },
  t5xxl: {
    file: 't5-v1_1-xxl-encoder-Q8_0.gguf',
    url: 'https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-Q8_0.gguf',
  },
  clipL: {
    file: 'clip_l.safetensors',
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
  },
  // The FLUX VAE; the black-forest-labs copy is behind a click-through, this Apache-2.0 repack is not.
  vae: {
    file: 'ae.safetensors',
    url: 'https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors',
  },
};

const PRESETS = {
  icon: { width: 1024, height: 1024 },
  about: { width: 1536, height: 896 },
  banner: { width: 1792, height: 576 },
  square: { width: 768, height: 768 },
};

const STYLES = {
  none: '',
  // "cute but serious" kawaii: a competent little character, not a sticker for toddlers.
  'kawaii-serious':
    'style: cute yet grown-up kawaii mascot illustration, calm self-assured expression, clean ' +
    'vector-like flat shading, soft rounded shapes, thick smooth dark outlines, gentle pastel palette ' +
    'with one confident accent colour, tidy and professional like a well-designed app mascot, ' +
    'high quality, centered, single character, plain off-white background, no text, no letters',
  kawaii:
    'super cute kawaii character illustration, chibi proportions, big shiny eyes, rosy blush, pastel ' +
    'colours, soft shading, thick rounded outlines, sticker style, plain light background, no text',
};

const HELP = `Local image generation (stable-diffusion.cpp + FLUX.1-schnell, no Python).

Usage:
  node scripts/imagegen.js setup [--native]     download models (~14 GB) and pull the Docker image
                                                (--native: also the Windows CUDA binary)
  node scripts/imagegen.js gen [options]        generate image(s)

gen options:
  --prompt <text>        what to draw (required)
  --out <file.png>       output file (required); with --count N files get -1..-N suffixes
  --preset <name>        ${Object.keys(PRESETS).map((k) => `${k} ${PRESETS[k].width}x${PRESETS[k].height}`).join(', ')}
  --width/--height <px>  explicit size, rounded down to a multiple of 64 (overrides --preset)
  --style <name>         prompt prefix: ${Object.keys(STYLES).join(', ')} (default kawaii-serious)
  --count <n>            number of variants (seeds seed, seed+1, ...) (default 1)
  --seed <n>             base seed (default random)
  --steps <n>            sampling steps (default 4, schnell is distilled for 1-4)
  --native | --docker    runner (default: docker if it sees a GPU and the image is pulled, else native)
  --no-meta              do not write the <name>.json sidecar

Env: IMAGEGEN_HOME (default <repo>/tmp/imagegen), IMAGEGEN_DOCKER_IMAGE.
`;

function log(msg) {
  process.stderr.write(`[imagegen] ${msg}\n`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

function download(url, dest) {
  if (fs.existsSync(dest)) {
    log(`have ${path.basename(dest)}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const size = remoteSize(url);
  log(`downloading ${path.basename(dest)} (${(size / 1e9).toFixed(2)} GB)`);
  // Hugging Face throttles per connection, so big files go as PARTS ranges fetched in parallel
  // (curl ships with Windows 10+, macOS and Linux). A finished part is kept across reruns.
  const parts = size > 256 * 1024 * 1024 ? 12 : 1;
  const step = Math.ceil(size / parts);
  const curlArgs = ['--parallel', '--parallel-max', String(parts)];
  const files = [];
  for (let i = 0; i < parts; i++) {
    const from = i * step;
    const to = Math.min(size, from + step) - 1;
    const file = `${dest}.part${i}`;
    files.push({ file, len: to - from + 1 });
    if (fs.existsSync(file) && fs.statSync(file).size === to - from + 1) continue;
    if (curlArgs.length > 3) curlArgs.push('--next');
    curlArgs.push('-L', '--fail', '--retry', '5', '-s', '-r', `${from}-${to}`, '-o', file, url);
  }
  if (curlArgs.length > 3) run('curl', curlArgs);
  const out = fs.openSync(`${dest}.part`, 'w');
  try {
    const buf = Buffer.alloc(16 * 1024 * 1024);
    for (const p of files) {
      if (fs.statSync(p.file).size !== p.len) throw new Error(`${p.file} is incomplete; rerun setup`);
      const fd = fs.openSync(p.file, 'r');
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) fs.writeSync(out, buf, 0, n);
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(out);
  }
  if (fs.statSync(`${dest}.part`).size !== size) throw new Error(`${path.basename(dest)} size mismatch`);
  fs.renameSync(`${dest}.part`, dest);
  for (const p of files) fs.rmSync(p.file);
}

function remoteSize(url) {
  const head = execFileSync('curl', ['-sIL', '--fail', url], { encoding: 'utf8', timeout: 60000 });
  const lens = [...head.matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
  const size = lens[lens.length - 1];
  if (!size) throw new Error(`cannot get the size of ${url}`);
  return size;
}

function dockerImagePresent() {
  try {
    return spawnSync('docker', ['image', 'inspect', DOCKER_IMAGE], { stdio: 'ignore', timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
}

function dockerHasGpu() {
  try {
    const r = spawnSync('docker', ['info', '--format', '{{json .Runtimes}}'], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 && /nvidia/.test(r.stdout);
  } catch {
    return false;
  }
}

function nativeBinary() {
  const name = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
  const alt = process.platform === 'win32' ? 'sd.exe' : 'sd';
  for (const n of [name, alt]) {
    const p = path.join(BIN, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function setupNative() {
  if (process.platform !== 'win32') {
    throw new Error('--native setup downloads the Windows CUDA build only; on Linux/macOS use Docker or build sd.cpp');
  }
  const rel = JSON.parse(
    execFileSync('curl', ['-sL', '--fail', `https://api.github.com/repos/${SD_RELEASE}/releases/latest`], {
      encoding: 'utf8',
    }),
  );
  const assets = rel.assets.filter(
    (a) => /bin-win-cuda12-x64\.zip$/.test(a.name) || /^cudart-sd-bin-win-cu12-x64\.zip$/.test(a.name),
  );
  if (assets.length < 2) throw new Error(`release ${rel.tag_name} has no Windows CUDA 12 assets`);
  fs.mkdirSync(BIN, { recursive: true });
  for (const a of assets) {
    const zip = path.join(HOME, 'downloads', a.name);
    download(a.browser_download_url, zip);
    // Windows' own bsdtar unpacks zip; a GNU tar earlier on PATH (Git Bash) reads "D:" as a host.
    run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', BIN]);
  }
  fs.writeFileSync(path.join(BIN, 'release.txt'), `${rel.tag_name}\n`, 'utf8');
  if (!nativeBinary()) throw new Error(`no sd-cli.exe / sd.exe found in ${BIN} after unpacking`);
  log(`native sd.cpp ${rel.tag_name} ready`);
}

function setup(args) {
  for (const m of Object.values(MODEL_FILES)) download(m.url, path.join(MODELS, m.file));
  if (args.native) setupNative();
  if (!args.native || dockerHasGpu()) {
    try {
      run('docker', ['pull', DOCKER_IMAGE]);
    } catch (e) {
      log(`docker pull failed (${e.message}); use --native`);
    }
  }
  log(`setup done; models in ${MODELS}`);
}

function round64(n) {
  return Math.max(256, Math.floor(Number(n) / 64) * 64);
}

// Drops tEXt/zTXt/iTXt chunks: sd.cpp stores the full command line (absolute model paths) there.
function stripPngText(file) {
  const buf = fs.readFileSync(file);
  const sig = buf.subarray(0, 8);
  if (sig.toString('hex') !== '89504e470d0a1a0a') return;
  const parts = [sig];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const end = off + 12 + len;
    if (!['tEXt', 'zTXt', 'iTXt'].includes(type)) parts.push(buf.subarray(off, end));
    off = end;
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

function generate(args) {
  const prompt = typeof args.prompt === 'string' ? args.prompt : null;
  const outArg = typeof args.out === 'string' ? args.out : null;
  if (!prompt || !outArg) throw new Error('gen needs --prompt and --out (see --help)');
  const preset = PRESETS[args.preset || 'square'];
  if (!preset) throw new Error(`unknown preset ${args.preset}`);
  const width = round64(args.width || preset.width);
  const height = round64(args.height || preset.height);
  const styleName = args.style || 'kawaii-serious';
  if (!(styleName in STYLES)) throw new Error(`unknown style ${styleName}`);
  const fullPrompt = [prompt, STYLES[styleName]].filter(Boolean).join(', ');
  const count = Math.max(1, parseInt(args.count || '1', 10));
  const steps = parseInt(args.steps || '4', 10);
  const baseSeed = args.seed !== undefined ? parseInt(args.seed, 10) : Math.floor(Math.random() * 2147483647);

  for (const m of Object.values(MODEL_FILES)) {
    if (!fs.existsSync(path.join(MODELS, m.file))) throw new Error(`model ${m.file} missing; run: node scripts/imagegen.js setup`);
  }
  let runner = args.native ? 'native' : args.docker ? 'docker' : null;
  if (!runner) runner = dockerHasGpu() && dockerImagePresent() ? 'docker' : 'native';
  const bin = runner === 'native' ? nativeBinary() : null;
  if (runner === 'native' && !bin) throw new Error('native binary missing; run: node scripts/imagegen.js setup --native');

  const outAbs = path.resolve(outArg);
  const ext = path.extname(outAbs) || '.png';
  const stem = outAbs.slice(0, outAbs.length - path.extname(outAbs).length);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'work'), { recursive: true });
  const work = fs.mkdtempSync(path.join(HOME, 'work', 'run-'));

  try {
    for (let i = 0; i < count; i++) {
      const seed = baseSeed + i;
      const target = count === 1 ? `${stem}${ext}` : `${stem}-${i + 1}${ext}`;
      const modelDir = runner === 'docker' ? '/models' : MODELS;
      const outDir = runner === 'docker' ? '/out' : work;
      const j = runner === 'docker' ? path.posix.join : path.join;
      const sdArgs = [
        '--diffusion-model', j(modelDir, MODEL_FILES.diffusion.file),
        '--t5xxl', j(modelDir, MODEL_FILES.t5xxl.file),
        '--clip_l', j(modelDir, MODEL_FILES.clipL.file),
        '--vae', j(modelDir, MODEL_FILES.vae.file),
        '-p', fullPrompt,
        '--cfg-scale', '1.0',
        '--sampling-method', 'euler',
        '--steps', String(steps),
        '-W', String(width),
        '-H', String(height),
        '-s', String(seed),
        '--backend', 'te=cpu',
        '--vae-tiling',
        '-o', j(outDir, 'out.png'),
      ];
      log(`${runner}: ${width}x${height} seed ${seed} -> ${path.relative(process.cwd(), target)}`);
      const t0 = Date.now();
      if (runner === 'docker') {
        run('docker', [
          'run', '--rm', '--gpus', 'all',
          '-v', `${MODELS}:/models:ro`,
          '-v', `${work}:/out`,
          DOCKER_IMAGE, ...sdArgs,
        ]);
      } else {
        run(bin, sdArgs, { cwd: BIN });
      }
      const produced = path.join(work, 'out.png');
      if (!fs.existsSync(produced)) throw new Error('sd.cpp finished without writing an image');
      stripPngText(produced);
      fs.copyFileSync(produced, target);
      fs.rmSync(produced);
      if (!args['no-meta']) {
        const meta = {
          prompt, style: styleName, fullPrompt, seed, steps, width, height,
          model: MODEL_FILES.diffusion.file, generator: 'stable-diffusion.cpp (scripts/imagegen.js)',
          seconds: Math.round((Date.now() - t0) / 1000),
        };
        fs.writeFileSync(`${target.slice(0, target.length - ext.length)}.json`, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (cmd === 'setup') setup(args);
  else if (cmd === 'gen') generate(args);
  else throw new Error(`unknown command ${cmd} (see --help)`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`imagegen error: ${err.message}\n`);
  process.exit(1);
}
