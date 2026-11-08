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
 *   node render.mjs scene.html --out video.mp4 [options]      render a video
 *   node render.mjs scene.html --stills 0,2.5,5 --out stills  render PNG stills for a quick look
 *   node render.mjs scene.html --serve                        just serve the folder for live preview
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
 *   --verbose                    print the page's console.log output as well
 */
import { spawn } from 'node:child_process';
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
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, name);
    if (dir && fs.existsSync(p)) return p;
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

async function openSession(chromePath, { software, width, height, scale, verbose }) {
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
  const stills = o.stills && o.stills !== true ? String(o.stills).split(',').map(Number) : null;
  if (stills && stills.some(Number.isNaN)) die('--stills must be a comma-separated list of seconds, e.g. 0,2.5,5');
  const out = o.out && o.out !== true ? o.out : (stills ? 'stills' : 'out.mp4');
  const usePng = !!o.png;

  const chromePath = findChrome();
  if (!chromePath) die('Chrome/Edge not found. Install Google Chrome or set CHROME_PATH to its executable.');

  const { server, port } = await startServer(root);
  const url = `http://127.0.0.1:${port}/${rel}`;
  const sessionOpts = { width, height, scale, verbose: !!o.verbose };
  let session; let glName = null;
  const mode = o.gl && o.gl !== true ? o.gl : 'auto';
  try {
    session = await openSession(chromePath, { ...sessionOpts, software: mode === 'software' });
    glName = await evaluate(session.S, GL_PROBE);
    if (!glName && mode === 'auto') {
      await session.close();
      console.error('No hardware WebGL in headless Chrome, switching to software rendering (slower).');
      session = await openSession(chromePath, { ...sessionOpts, software: true });
      glName = await evaluate(session.S, GL_PROBE);
    }
    if (!glName) die('WebGL is not available in headless Chrome on this machine. Try --gl software.');
    console.error(`WebGL renderer: ${glName}`);

    const { S } = session;
    await S('Page.navigate', { url });
    const deadline = Date.now() + num(o.timeout, 60) * 1000;
    while (!(await evaluate(S, 'window.__ready === true'))) {
      if (Date.now() > deadline) die('The scene never set window.__ready = true. See references/contract.md (check the page console output above for errors).');
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await evaluate(S, 'typeof window.seek === "function"'))) die('The scene did not define window.seek(t). See references/contract.md.');

    const sceneDuration = await evaluate(S, 'window.__duration');
    const t0 = num(o.start, 0);
    const t1 = o.end !== undefined ? num(o.end, 0) : num(o.duration, undefined) !== undefined ? t0 + num(o.duration) : sceneDuration;
    if (!stills && !(t1 > t0)) die('Unknown duration: pass --duration, or have the scene set window.__duration.');

    const grab = async (t) => {
      await evaluate(S, `(async () => { window.seek(${t}); await Promise.race([new Promise(r => requestAnimationFrame(() => r())), new Promise(r => setTimeout(r, 500))]); })()`);
      const shot = await S('Page.captureScreenshot', usePng || stills ? { format: 'png' } : { format: 'jpeg', quality: 92 });
      return Buffer.from(shot.data, 'base64');
    };

    if (stills) {
      fs.mkdirSync(out, { recursive: true });
      for (const t of stills) {
        const file = path.join(out, `frame_${t.toFixed(2).padStart(6, '0')}s.png`);
        fs.writeFileSync(file, await grab(t));
        console.error('wrote ' + file);
      }
      return;
    }

    // ---- video
    const total = Math.max(1, Math.round((t1 - t0) * fps));
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const tmpOut = out.replace(/\.mp4$/i, '') + '.partial.mp4';
    const vf = [];
    if (scale !== 1) vf.push(`scale=${width}:${height}:flags=lanczos`);
    vf.push('format=yuv420p');
    const ffArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', usePng ? 'png' : 'mjpeg', '-i', '-'];
    if (o.audio && o.audio !== true) ffArgs.push('-i', o.audio);
    ffArgs.push('-vf', vf.join(','), '-r', String(fps), '-c:v', 'libx264', '-preset', String(o.preset && o.preset !== true ? o.preset : 'veryfast'),
      '-crf', String(num(o.crf, 18)), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (o.audio && o.audio !== true) ffArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    ffArgs.push(tmpOut);

    const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    let ffFailed = null;
    ff.on('error', (e) => { ffFailed = e.code === 'ENOENT' ? 'ffmpeg not found on PATH' : String(e); });
    ff.stdin.on('error', () => { /* surfaced through the exit code */ });
    const ffExit = new Promise((resolve) => ff.on('close', resolve));

    const started = Date.now();
    console.error(`Rendering ${total} frames (${t0}s to ${(t0 + total / fps).toFixed(2)}s) at ${width}x${height}${scale !== 1 ? ` (captured at ${scale}x)` : ''}, ${fps} fps`);
    for (let i = 0; i < total; i++) {
      if (ffFailed) break;
      const buf = await grab(t0 + i / fps);
      if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
      if (i % 10 === 9 || i === total - 1) {
        const rate = (i + 1) / ((Date.now() - started) / 1000);
        process.stderr.write(`\r  frame ${i + 1}/${total}  ${rate.toFixed(1)} fps  eta ${Math.max(0, Math.round((total - i - 1) / rate))}s   `);
      }
    }
    process.stderr.write('\n');
    ff.stdin.end();
    const code = await ffExit;
    if (ffFailed) die(ffFailed);
    if (code !== 0) { try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ } die(`ffmpeg exited with code ${code}`); }
    fs.renameSync(tmpOut, out);
    console.error(`Done: ${out}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } finally {
    if (session) await session.close();
    server.close();
  }
}

// Do not force process.exit(0): an active --serve HTTP server must keep the
// event loop alive until the user presses Ctrl+C. Setting exitCode on errors
// still lets Node drain/close resources created by the renderer.
main().catch((e) => {
  console.error('\nError: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
