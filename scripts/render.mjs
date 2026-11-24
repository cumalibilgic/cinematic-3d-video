#!/usr/bin/env node
/**
 * render.mjs - deterministic frame-by-frame renderer for web-based 3D scenes.
 *
 * Opens an HTML scene in headless Chrome/Edge, steps a virtual clock one frame at a time
 * (calling window.seek(t)), screenshots each frame over the DevTools protocol and pipes it
 * into ffmpeg. Output does not depend on how fast the machine is, so a heavy scene still
 * comes out smooth.
 *
 * Zero npm dependencies: needs Node 22+ (global WebSocket), ffmpeg on PATH, and Chrome or Edge.
 *
 * Usage
 *   node render.mjs --doctor                              check the local toolchain
 *   node render.mjs scene.html --out video.mp4 [options]      render a video
 *   node render.mjs scene.html --stills 0,2.5,5 --out stills  render PNG stills for a quick look
 *   node render.mjs scene.html --serve                        just serve the folder for live preview
 *   node render.mjs scene.html --stills 0,2,4 --sheet --out stills   also write a contact sheet (stills/sheet.png)
 *
 * Options
 *   --width 1920 --height 1080   output size in pixels (both must be even)
 *   --fps 30                     frames per second
 *   --duration 8                 seconds; default is window.__duration set by the scene
 *   --start 0 --end 4            render only a time range (seconds)
 *   --scale 1                    render at N x size and downscale (2 = 4x supersampling, smoother edges)
 *   --crf 18 --preset veryfast   x264 quality (lower = better) and speed
 *   --audio track.mp3            mux an audio file (cut to the video length)
 *   --png                        capture PNG instead of JPEG q92 (slower, lossless capture)
 *   --gl auto|gpu|software       WebGL backend. auto = GPU, falls back to software if there is no WebGL
 *   --timeout 60                 seconds to wait for the scene to set window.__ready
 *   --root dir                   folder served to the page (default: the scene's folder)
 *   --query "a=1&b"              append a query string to the scene URL (the page can read it from location.search)
 *   --verbose                    print the page's console.log output as well
 *   --blur 8 --shutter 0.5       motion blur: average N sub-frames spread over a shutter of 0.5 frame
 *   --alpha                      transparent background; out must end in .webm (VP9) or .mov (ProRes 4444)
 *   --workers 4                  render with N parallel Chrome instances (big win on software WebGL / many cores)
 *   --sheet                      with --stills: also write sheet.png, all stills in one image
 *   --no-cache                   do not cache remote files (CDN) on disk; default caches them so renders work offline
 *   --cache-dir dir              cache location (default ~/.cache/cinematic-3d-video)
 *
 * Audio: with --audio the loudness envelope (rms/low/mid/high, 60 per second, 0..1) is injected as
 * window.__audio before the page loads; see audio() in templates/starter/lib/math.js.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) o[a.slice(2)] = true;
      else { o[a.slice(2)] = next; i++; }
    } else o._.push(a);
  }
  return o;
}
// Throw instead of exiting immediately so `finally` blocks can close Chrome,
// the DevTools socket, the local server, and any temporary render files.
const die = (msg) => { throw new Error(msg); };
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref())]);
const num = (v, d) => (v === undefined || v === true ? d : Number(v));

// ---------------------------------------------------------------- static server
function startServer(root, port = 0) {
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.woff2': 'font/woff2',
    '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg',
    '.hdr': 'application/octet-stream', '.ktx2': 'application/octet-stream',
  };
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.resolve(path.join(base, pathname));
      if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
      let target = file;
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      if (!fs.existsSync(target)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(target).pipe(res);
    } catch { res.writeHead(500); res.end(); }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------- chrome
function which(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidates = path.extname(name) ? [name] : extensions.map((ext) => name + ext);
    for (const candidate of candidates) {
      const p = path.join(dir, candidate);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const c = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      c.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      c.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge']) {
      const p = which(n); if (p) c.push(p);
    }
  }
  return c.find((p) => fs.existsSync(p)) || null;
}

function runDoctor() {
  let failed = false;
  const report = (label, ok, detail) => {
    console.log(`${ok ? 'OK' : 'MISSING'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failed = true;
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  report('Node.js 22+', Number.isFinite(nodeMajor) && nodeMajor >= 22, `v${process.versions.node}`);
  report('Built-in WebSocket', typeof globalThis.WebSocket === 'function',
    typeof globalThis.WebSocket === 'function' ? 'available' : 'upgrade Node.js to 22 or newer');

  const ffmpegPath = which('ffmpeg');
  report('FFmpeg', Boolean(ffmpegPath), ffmpegPath || 'install FFmpeg and add it to PATH');

  const chromePath = findChrome();
  report('Chrome or Edge', Boolean(chromePath), chromePath || 'install Chrome/Edge or set CHROME_PATH');

  console.log(failed
    ? '\nToolchain is incomplete. Follow the install steps in README.md, then run --doctor again.'
    : '\nToolchain checks passed. Run the smoke-test render to verify WebGL and video encoding.');
  return !failed;
}

async function launchChrome(chromePath, { software, width, height }) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3v-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--ignore-gpu-blocklist',
    `--window-size=${width},${height}`, 'about:blank',
  ];
  if (software) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');

  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not expose a DevTools endpoint within 20 s')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (code ${code})`)); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  return { proc, wsUrl, userDir };
}

// ---------------------------------------------------------------- minimal DevTools client
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      } else this.listeners.forEach((l) => l(m));
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('DevTools connection closed'));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('Cannot connect to DevTools')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify(msg)); });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}


// ---------------------------------------------------------------- remote file cache
// Everything the page loads from another origin (Three.js on a CDN, fonts, models) is stored on disk the
// first time and served from there afterwards, so a scene keeps rendering offline and loads faster.
async function enableCache(cdp, S, sessionId, { dir, origin }) {
  fs.mkdirSync(dir, { recursive: true });
  const drop = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
  await S('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }, { urlPattern: 'http*', requestStage: 'Response' }] });
  cdp.on(async (m) => {
    if (m.sessionId !== sessionId || m.method !== 'Fetch.requestPaused') return;
    const { requestId, request, responseStatusCode, responseHeaders } = m.params;
    const proceed = () => (responseStatusCode === undefined
      ? S('Fetch.continueRequest', { requestId })
      : S('Fetch.continueResponse', { requestId }).catch(() => S('Fetch.continueRequest', { requestId })));
    try {
      const remote = request.method === 'GET' && /^https?:/.test(request.url) && !request.url.startsWith(origin);
      if (!remote) return await proceed();
      const key = path.join(dir, crypto.createHash('sha1').update(request.url).digest('hex'));
      if (responseStatusCode === undefined) {
        if (fs.existsSync(key + '.json') && fs.existsSync(key + '.bin')) {
          const meta = JSON.parse(fs.readFileSync(key + '.json', 'utf8'));
          return await S('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: meta.headers, body: fs.readFileSync(key + '.bin').toString('base64') });
        }
        return await proceed();
      }
      if (responseStatusCode === 200 && !fs.existsSync(key + '.bin')) {
        const r = await S('Fetch.getResponseBody', { requestId });
        const body = Buffer.from(r.body, r.base64Encoded ? 'base64' : 'utf8');
        const headers = (responseHeaders || []).filter((h) => !drop.has(h.name.toLowerCase()));
        if (!headers.some((h) => h.name.toLowerCase() === 'access-control-allow-origin')) headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
        fs.writeFileSync(key + '.bin', body);
        fs.writeFileSync(key + '.json', JSON.stringify({ url: request.url, headers }));
      }
      await proceed();
    } catch { try { await proceed(); } catch { /* request already finished */ } }
  });
}

// ---------------------------------------------------------------- audio analysis
// Loudness envelope of the soundtrack so a scene can react to the music: rms plus three bands
// (low < 200 Hz, mid, high > 2 kHz), 60 samples per second, each scaled to 0..1.
function analyseAudio(file, seconds) {
  const sr = 8000, rate = 60, win = Math.round(sr / rate);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-t', String(seconds), '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) die(`could not decode the audio file: ${file}${r.stderr?.length ? '\n' + r.stderr : ''}`);
  const buf = r.stdout, frames = Math.floor(buf.length / 2 / win);
  const aLow = 1 - Math.exp(-2 * Math.PI * 200 / sr), aMid = 1 - Math.exp(-2 * Math.PI * 2000 / sr);
  const out = { rate, rms: [], low: [], mid: [], high: [] };
  let y1 = 0, y2 = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0, l = 0, m = 0, h = 0;
    for (let i = 0; i < win; i++) {
      const x = buf.readInt16LE((f * win + i) * 2) / 32768;
      y1 += aLow * (x - y1); y2 += aMid * (x - y2);
      const mi = y2 - y1, hi = x - y2;
      s += x * x; l += y1 * y1; m += mi * mi; h += hi * hi;
    }
    out.rms.push(Math.sqrt(s / win)); out.low.push(Math.sqrt(l / win)); out.mid.push(Math.sqrt(m / win)); out.high.push(Math.sqrt(h / win));
  }
  for (const k of ['rms', 'low', 'mid', 'high']) {
    const sorted = [...out[k]].sort((a, b) => a - b);
    const ref = sorted[Math.floor(sorted.length * 0.99)] || 1e-9; // 99th percentile: one click does not flatten the rest
    out[k] = out[k].map((v) => Math.round(Math.min(1, v / ref) * 1000) / 1000);
  }
  return out;
}

async function openSession(chromePath, { software, width, height, scale, verbose, alpha, cache, audio }) {
  const chrome = await launchChrome(chromePath, { software, width, height });
  const cdp = await CDP.connect(chrome.wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (method, params) => cdp.send(method, params, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');
  await S('Log.enable');
  await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  if (alpha) await S('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  if (audio) await S('Page.addScriptToEvaluateOnNewDocument', { source: `window.__audio = ${JSON.stringify(audio)};` });
  if (cache) await enableCache(cdp, S, sessionId, cache);
  const urls = new Map();
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    // Failed script/module/asset loads (e.g. the CDN is unreachable) are the most common reason a scene never becomes ready.
    if (m.method === 'Network.requestWillBeSent') urls.set(m.params.requestId, m.params.request.url);
    else if (m.method === 'Network.loadingFailed' && !m.params.canceled) console.error(`\n[load failed] ${urls.get(m.params.requestId) || ''} (${m.params.errorText})`);
    else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400 && !m.params.response.url.endsWith('/favicon.ico')) console.error(`\n[load failed] ${m.params.response.url} (HTTP ${m.params.response.status})`);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !(m.params.entry.url || '').endsWith('/favicon.ico')) console.error('\n[page log]', m.params.entry.text, m.params.entry.url || '');
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.error('\n[page error]', d.exception?.description || d.text);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (m.params.type === 'error') console.error('\n[page console.error]', text);
      else if (m.params.type === 'warning' && verbose) console.error('[page warn]', text);
      else if (verbose) console.error('[page]', text);
    }
  });
  const close = async () => {
    cdp.close();
    chrome.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(chrome.userDir, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
  };
  return { S, close };
}

async function evaluate(S, expression) {
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

const GL_PROBE = `(() => {
  const c = document.createElement('canvas');
  const g = c.getContext('webgl2') || c.getContext('webgl');
  if (!g) return null;
  const e = g.getExtension('WEBGL_debug_renderer_info');
  return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
})()`;

// ---------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const scene = o._[0];
  if (o.doctor) {
    if (!runDoctor()) process.exitCode = 1;
    return;
  }
  if (o.help || !scene) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '')); return; }
  if (!fs.existsSync(scene)) die(`scene file not found: ${scene}`);

  const root = path.resolve(o.root && o.root !== true ? o.root : path.dirname(scene));
  const rel = path.relative(root, path.resolve(scene)).split(path.sep).join('/');
  if (rel.startsWith('..')) die('the scene must live inside --root');

  if (o.serve) {
    const { port } = await startServer(root, num(o.port, 5173));
    console.log(`Serving ${root}\nLive preview (real-time loop): http://localhost:${port}/${rel}?live\nCtrl+C to stop.`);
    return;
  }

  const width = num(o.width, 1920), height = num(o.height, 1080), fps = num(o.fps, 30), scale = num(o.scale, 1);
  if (width % 2 || height % 2) die('--width and --height must be even numbers (required by yuv420p/H.264)');
  // Headless Chrome stops answering screenshot requests when the viewport is shorter than about 160 px.
  if (height < 160) die('--height must be at least 160 (shorter viewports make headless Chrome hang). Render larger and downscale the file with ffmpeg if you need a tiny video.');
  const stills = o.stills && o.stills !== true ? String(o.stills).split(',').map(Number) : null;
  if (stills && stills.some(Number.isNaN)) die('--stills must be a comma-separated list of seconds, e.g. 0,2.5,5');
  const alpha = !!o.alpha;
  const out = o.out && o.out !== true ? o.out : (stills ? 'stills' : alpha ? 'out.webm' : 'out.mp4');
  const ext = path.extname(out).toLowerCase();
  if (!stills && alpha && !['.webm', '.mov'].includes(ext)) die('--alpha needs an output ending in .webm (VP9) or .mov (ProRes 4444), e.g. --out logo.webm');
  const usePng = !!o.png || alpha;
  const blur = Math.max(1, Math.round(num(o.blur, 1)));
  const shutter = num(o.shutter, 0.5);
  const workers = Math.max(1, Math.round(num(o.workers, 1)));
  const audioFile = o.audio && o.audio !== true ? o.audio : null;
  if (audioFile && !fs.existsSync(audioFile)) die(`audio file not found: ${audioFile}`);

  const chromePath = findChrome();
  if (!chromePath) die('Chrome/Edge not found. Install Google Chrome or set CHROME_PATH to its executable.');

  const { server, port } = await startServer(root);
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/${rel}${o.query && o.query !== true ? '?' + String(o.query).replace(/^\?/, '') : ''}`;
  const cache = o.cache === false || o['no-cache'] ? null
    : { dir: o['cache-dir'] && o['cache-dir'] !== true ? path.resolve(o['cache-dir']) : path.join(os.homedir(), '.cache', 'cinematic-3d-video'), origin };

  const mode = o.gl && o.gl !== true ? o.gl : 'auto';
  const sessions = [];
  const workDir = stills ? null : `${path.resolve(out)}.work`;
  try {
    let software = mode === 'software';
    const open = async (sw, audio) => {
      const s = await openSession(chromePath, { width, height, scale, verbose: !!o.verbose, alpha, cache, audio, software: sw });
      sessions.push(s);
      return s;
    };
    const closeAll = async () => { while (sessions.length) await sessions.pop().close(); };

    // The audio envelope needs the video length, which comes from the scene, so the first page load is a probe
    // of the WebGL backend only; real sessions are opened after the duration is known.
    let probe = await open(software);
    let glName = await evaluate(probe.S, GL_PROBE);
    if (!glName && mode === 'auto') {
      await closeAll();
      console.error('No hardware WebGL in headless Chrome, switching to software rendering (slower).');
      software = true;
      probe = await open(true);
      glName = await evaluate(probe.S, GL_PROBE);
    }
    if (!glName) die('WebGL is not available in headless Chrome on this machine. Try --gl software.');
    console.error(`WebGL renderer: ${glName}`);

    const prepare = async (S) => {
      await S('Page.navigate', { url });
      const deadline = Date.now() + num(o.timeout, 60) * 1000;
      while (!(await evaluate(S, 'window.__ready === true'))) {
        if (Date.now() > deadline) die('The scene never set window.__ready = true. See references/contract.md (check the page console output above for errors).');
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!(await evaluate(S, 'typeof window.seek === "function"'))) die('The scene did not define window.seek(t). See references/contract.md.');
    };

    await prepare(probe.S);
    const sceneDuration = await evaluate(probe.S, 'window.__duration');
    const t0 = num(o.start, 0);
    const t1 = o.end !== undefined ? num(o.end, 0) : num(o.duration, undefined) !== undefined ? t0 + num(o.duration) : sceneDuration;
    if (!stills && !(t1 > t0)) die('Unknown duration: pass --duration, or have the scene set window.__duration.');

    let audio = null;
    if (audioFile && !stills) {
      audio = analyseAudio(audioFile, t1 + 1);
      console.error(`Audio envelope: ${audio.rms.length} samples (${audio.rate}/s) injected as window.__audio`);
      await closeAll();
      probe = await open(software, audio);
      await prepare(probe.S);
    } else if (audioFile && stills) {
      const a = analyseAudio(audioFile, Math.max(...stills) + 1);
      await closeAll();
      probe = await open(software, a);
      await prepare(probe.S);
    }

    const grab = async (S, t) => {
      await evaluate(S, `(async () => { window.seek(${t}); await Promise.race([new Promise(r => requestAnimationFrame(() => r())), new Promise(r => setTimeout(r, 500))]); })()`);
      const shot = await withTimeout(S('Page.captureScreenshot', usePng || stills ? { format: 'png' } : { format: 'jpeg', quality: 92 }),
        60000, `Chrome did not return a screenshot for t=${t}s within 60 s (is the scene stuck, or the viewport too small?)`);
      return Buffer.from(shot.data, 'base64');
    };

    // ---- stills (+ optional contact sheet)
    if (stills) {
      fs.mkdirSync(out, { recursive: true });
      const files = [];
      for (const t of stills) {
        const file = path.join(out, `frame_${t.toFixed(2).padStart(6, '0')}s.png`);
        fs.writeFileSync(file, await grab(probe.S, t));
        files.push(file);
        console.error('wrote ' + file);
      }
      if (o.sheet && files.length > 1) {
        const cols = Math.min(files.length, files.length > 4 ? 3 : 2);
        const rows = Math.ceil(files.length / cols);
        const cellW = Math.min(width, Math.floor(1920 / cols / 2) * 2), cellH = Math.round(cellW * height / width / 2) * 2;
        const args = ['-y', '-hide_banner', '-loglevel', 'error'];
        files.forEach((f) => args.push('-i', f));
        const prep = files.map((_, i) => `[${i}:v]scale=${cellW}:${cellH},drawtext=text='${stills[i]}s':x=8:y=8:fontsize=${Math.round(cellH / 14)}:fontcolor=white:box=1:boxcolor=black@0.5[v${i}]`);
        // drawtext needs a font build of ffmpeg; fall back to a plain sheet if it is missing
        const layout = files.map((_, i) => `${(i % cols) * cellW}_${Math.floor(i / cols) * cellH}`).join('|');
        const build = (labels) => [...args, '-filter_complex',
          (labels ? prep : files.map((_, i) => `[${i}:v]scale=${cellW}:${cellH}[v${i}]`)).join(';') + ';' +
          files.map((_, i) => `[v${i}]`).join('') + `xstack=inputs=${files.length}:layout=${layout}:fill=black[o]`,
          '-map', '[o]', '-frames:v', '1', path.join(out, 'sheet.png')];
        let r = spawnSync('ffmpeg', build(true));
        if (r.status !== 0) r = spawnSync('ffmpeg', build(false));
        if (r.status !== 0) console.error('could not build the contact sheet: ' + r.stderr);
        else console.error(`wrote ${path.join(out, 'sheet.png')} (${cols}x${rows})`);
      }
      return;
    }

    // ---- video
    const total = Math.max(1, Math.round((t1 - t0) * fps));
    const nWorkers = Math.min(workers, total);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const crf = num(o.crf, 18);
    const preset = o.preset && o.preset !== true ? String(o.preset) : 'veryfast';

    const encoder = () => {
      if (alpha && ext === '.webm') return { vf: 'format=yuva420p', args: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', String(Math.max(crf + 6, 24)), '-b:v', '0', '-auto-alt-ref', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'] };
      if (alpha) return { vf: 'format=yuva444p10le', args: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'] };
      return { vf: 'format=yuv420p', args: ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] };
    };

    let done = 0;
    const started = Date.now();
    const progress = () => {
      const rate = done / ((Date.now() - started) / 1000);
      process.stderr.write(`\r  frame ${done}/${total}  ${rate.toFixed(1)} fps  eta ${Math.max(0, Math.round((total - done) / rate))}s   `);
    };

    // Motion blur: capture `blur` sub-frames around each frame time and let ffmpeg average them (tmix),
    // keeping every blur-th result. The shutter is centred on the frame time.
    const renderChunk = async (S, i0, i1, file) => {
      const enc = encoder();
      const vf = [];
      if (blur > 1) vf.push(`tmix=frames=${blur}`, `select='eq(mod(n,${blur}),${blur - 1})'`, 'setpts=PTS-STARTPTS');
      if (scale !== 1) vf.push(`scale=${width}:${height}:flags=lanczos`);
      vf.push(enc.vf);
      const ffArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps * blur), '-c:v', usePng ? 'png' : 'mjpeg', '-i', '-',
        '-vf', vf.join(','), '-r', String(fps), ...enc.args, file];
      const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
      let ffFailed = null;
      ff.on('error', (e) => { ffFailed = e.code === 'ENOENT' ? 'ffmpeg not found on PATH' : String(e); });
      ff.stdin.on('error', () => { /* surfaced through the exit code */ });
      const ffExit = new Promise((resolve) => ff.on('close', resolve));
      for (let i = i0; i < i1 && !ffFailed; i++) {
        for (let j = 0; j < blur; j++) {
          const t = t0 + i / fps + (blur > 1 ? ((j + 0.5) / blur - 0.5) * shutter / fps : 0);
          const buf = await grab(S, t);
          if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
        }
        done++;
        if (done % 10 === 0 || done === total) progress();
      }
      ff.stdin.end();
      const code = await ffExit;
      if (ffFailed) die(ffFailed);
      if (code !== 0) die(`ffmpeg exited with code ${code}`);
    };

    // Extra Chrome instances for --workers; each renders one contiguous block of frames.
    const pool = [probe];
    for (let k = 1; k < nWorkers; k++) { const s = await open(software, audio); await prepare(s.S); pool.push(s); }
    console.error(`Rendering ${total} frames (${t0}s to ${(t0 + total / fps).toFixed(2)}s) at ${width}x${height}${scale !== 1 ? ` (captured at ${scale}x)` : ''}, ${fps} fps`
      + `${blur > 1 ? `, motion blur x${blur}` : ''}${nWorkers > 1 ? `, ${nWorkers} workers` : ''}${alpha ? ', alpha' : ''}`);

    const per = Math.ceil(total / nWorkers);
    const parts = pool.map((_, k) => path.join(workDir, `part${k}${alpha ? ext : '.mp4'}`));
    await Promise.all(pool.map((s, k) => renderChunk(s.S, k * per, Math.min(total, (k + 1) * per), parts[k])));
    process.stderr.write('\n');

    let video = parts[0];
    if (parts.length > 1) {
      const list = path.join(workDir, 'list.txt');
      fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      video = path.join(workDir, `merged${alpha ? ext : '.mp4'}`);
      const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(alpha ? [] : ['-movflags', '+faststart']), video]);
      if (r.status !== 0) die('could not join the rendered parts: ' + r.stderr);
    }
    if (audioFile) {
      const final = path.join(workDir, `final${alpha ? ext : '.mp4'}`);
      const ac = ext === '.webm' ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k'];
      const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-ss', String(t0), '-i', audioFile, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...ac, '-shortest', ...(ext === '.mp4' ? ['-movflags', '+faststart'] : []), final]);
      if (r.status !== 0) die('could not add the audio track: ' + r.stderr);
      video = final;
    }
    fs.renameSync(video, out);
    console.error(`Done: ${out}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } finally {
    for (const s of sessions) await s.close();
    server.close();
    if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// Do not force process.exit(0): an active --serve HTTP server must keep the
// event loop alive until the user presses Ctrl+C. Setting exitCode on errors
// still lets Node drain/close resources created by the renderer.
main().catch((e) => {
  console.error('\nError: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
