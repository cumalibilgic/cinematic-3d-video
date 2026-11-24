#!/usr/bin/env node
/**
 * selftest.mjs - end-to-end checks for the renderer and the animation helpers.
 *
 *   node scripts/selftest.mjs            run everything (about 1 minute, software WebGL is fine)
 *
 * Uses only Node's built-in test runner, ffmpeg/ffprobe and Chrome. Needs no network and no npm packages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const render = path.join(here, 'render.mjs');
const smoke = path.join(root, 'templates', 'smoke-test.html');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3v-selftest-'));
const SIZE = ['--width', '320', '--height', '180'];

const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [render, ...args], { encoding: 'utf8', timeout: 180000, ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const ok = (args) => { const r = run(args); assert.equal(r.code, 0, r.out); return r.out; };
const probe = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,width,height,r_frame_rate', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const streams = JSON.parse(r.stdout).streams;
  return { video: streams.find((s) => s.codec_type === 'video'), audio: streams.find((s) => s.codec_type === 'audio') };
};
const hasEncoder = (name) => spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout.includes(name);
/** Raw RGBA of the first frame (decoding VP9 with libvpx keeps the alpha plane). */
const firstFrameRGBA = (file, w, h, decoder) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...(decoder ? ['-c:v', decoder] : []), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
  return (x, y) => [...r.stdout.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
};
const writeScene = (name, html) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'index.html'), html); return path.join(d, 'index.html'); };

test('toolchain doctor passes', () => { ok(['--doctor']); });

test('math helpers', async () => {
  const m = await import(pathToFileURL(path.join(root, 'templates', 'starter', 'lib', 'math.js')));
  for (const [name, fn] of Object.entries(m.ease)) { assert.ok(Math.abs(fn(0)) < 1e-9, `${name}(0)`); assert.ok(Math.abs(fn(1) - 1) < 1e-9, `${name}(1)`); }
  assert.equal(m.seg(0, 1, 2, m.ease.linear), 0);
  assert.equal(m.seg(2, 1, 2, m.ease.linear), 0.5);
  assert.equal(m.seg(9, 1, 2, m.ease.linear), 1);
  assert.deepEqual(m.keys([[0, [0, 10]], [2, [4, 20]]], 1, m.ease.linear), [2, 15]);
  assert.equal(m.keys([[0, 5], [2, 9]], -3), 5);
  assert.equal(m.keys([[0, 5], [2, 9]], 99), 9);
  const a = m.rng(42), b = m.rng(42);
  for (let i = 0; i < 100; i++) { const v = a(); assert.equal(v, b()); assert.ok(v >= 0 && v < 1); }
  assert.deepEqual(m.audio(1), { rms: 0, low: 0, mid: 0, high: 0 }); // no window.__audio: silence
  globalThis.window = { __audio: { rate: 10, rms: [0, 1], low: [0, 1], mid: [0, 1], high: [0, 1] } };
  assert.equal(m.audio(0.05).rms, 0.5);
  assert.equal(m.audio(99).low, 1);
  delete globalThis.window;
});

test('video render: size, fps, frame count', () => {
  const f = path.join(tmp, 'plain.mp4');
  ok([smoke, '--out', f, '--duration', '1', ...SIZE]);
  const { video } = probe(f);
  assert.equal(video.nb_read_frames, '30');
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.r_frame_rate, '30/1');
  assert.ok(!fs.existsSync(f + '.work'), 'work folder cleaned up');
});

test('--start/--end renders only that range', () => {
  const f = path.join(tmp, 'range.mp4');
  ok([smoke, '--out', f, '--start', '0.5', '--end', '1', '--fps', '20', ...SIZE]);
  assert.equal(probe(f).video.nb_read_frames, '10');
});

test('--blur keeps the frame count', () => {
  const f = path.join(tmp, 'blur.mp4');
  ok([smoke, '--out', f, '--duration', '1', '--blur', '4', ...SIZE]);
  assert.equal(probe(f).video.nb_read_frames, '30');
});

test('--workers matches a single-worker render', () => {
  const one = path.join(tmp, 'w1.mp4'), many = path.join(tmp, 'w3.mp4');
  ok([smoke, '--out', one, '--duration', '1', ...SIZE]);
  ok([smoke, '--out', many, '--duration', '1', '--workers', '3', ...SIZE]);
  assert.equal(probe(many).video.nb_read_frames, '30');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', one, '-i', many, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const avg = Number(/average:([\d.]+|inf)/.exec(r.stderr)?.[1].replace('inf', '99'));
  assert.ok(avg > 40, `frames differ between worker counts (PSNR ${avg})`);
});

test('stills and contact sheet', () => {
  const d = path.join(tmp, 'stills');
  ok([smoke, '--stills', '0,0.5,1', '--sheet', '--out', d, ...SIZE]);
  assert.deepEqual(fs.readdirSync(d).sort(), ['frame_000.00s.png', 'frame_000.50s.png', 'frame_001.00s.png', 'sheet.png']);
});

test('--alpha writes a transparent WebM', { skip: !hasEncoder('libvpx-vp9') }, () => {
  const f = path.join(tmp, 'alpha.webm');
  ok([smoke, '--out', f, '--duration', '0.5', '--alpha', '--query', 'alpha', ...SIZE]);
  const px = firstFrameRGBA(f, 320, 180, 'libvpx-vp9');
  assert.equal(px(2, 2)[3], 0, 'corner is transparent');
  assert.equal(px(160, 90)[3], 255, 'centre of the cube is opaque');
});

test('--alpha rejects an mp4 output', () => {
  const r = run([smoke, '--out', path.join(tmp, 'x.mp4'), '--alpha', ...SIZE]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /webm|mov/);
});

test('too-short viewports are rejected instead of hanging', () => {
  const r = run([smoke, '--out', path.join(tmp, 'tiny.mp4'), '--width', '320', '--height', '120']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /at least 160/);
});

test('--audio: envelope reaches the page and the track is muxed (and offset by --start)', () => {
  const wav = path.join(tmp, 'a.wav');
  // 1 s of silence followed by 1 s of a loud tone
  const g = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-f', 'lavfi', '-i', 'sine=f=440:d=1',
    '-filter_complex', '[0]atrim=0:1[s];[s][1]concat=n=2:v=0:a=1', wav]);
  assert.equal(g.status, 0, String(g.stderr));
  const scene = writeScene('audio', `<!doctype html><meta charset=utf-8><body style="margin:0"><canvas id=c></canvas><script>
    const c = document.getElementById('c'); c.width = innerWidth; c.height = innerHeight; const g = c.getContext('2d');
    window.__duration = 2;
    window.seek = (t) => { const A = window.__audio; const lvl = A ? A.rms[Math.min(A.rms.length - 1, Math.floor(t * A.rate))] : 0.5;
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height * lvl); };
    window.seek(0); window.__ready = true;</script>`);
  const f = path.join(tmp, 'audio.mp4');
  ok([scene, '--out', f, '--audio', wav, ...SIZE]);
  assert.ok(probe(f).audio, 'audio stream present');
  const quiet = firstFrameRGBA(f, 320, 180);
  assert.equal(quiet(160, 5)[0], 0, 'silent start: nothing drawn');
  const g2 = path.join(tmp, 'audio_start1.mp4');
  ok([scene, '--out', g2, '--audio', wav, '--start', '1', ...SIZE]);
  assert.ok(firstFrameRGBA(g2, 320, 180)(160, 5)[0] > 200, 'starting at 1 s lands on the loud part');
});

test('remote files are cached, so a second render works offline', async () => {
  // The "CDN" runs in its own process: spawnSync below blocks this one's event loop, so it could not answer requests.
  const remote = spawn(process.execPath, ['-e', `require('http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }); r.end("export const color = '#ff8800';"); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = Number(await new Promise((res) => remote.stdout.once('data', res)));
  const scene = writeScene('cdn', `<!doctype html><meta charset=utf-8><body style="margin:0"><canvas id=c></canvas><script type=module>
    import { color } from 'http://127.0.0.1:${port}/lib.js';
    const c = document.getElementById('c'); c.width = innerWidth; c.height = innerHeight; const g = c.getContext('2d');
    window.__duration = 1; window.seek = () => { g.fillStyle = color; g.fillRect(0, 0, c.width, c.height); };
    window.seek(0); window.__ready = true;</script>`);
  const cacheDir = path.join(tmp, 'cache');
  const args = (name) => [scene, '--out', path.join(tmp, name), '--duration', '0.2', '--cache-dir', cacheDir, ...SIZE];
  ok(args('cdn1.mp4'));
  assert.ok(fs.readdirSync(cacheDir).length >= 2, 'cache populated');
  remote.kill();
  await new Promise((res) => remote.once('exit', res));
  ok(args('cdn2.mp4')); // remote is gone now
  const r = run([scene, '--out', path.join(tmp, 'cdn3.mp4'), '--duration', '0.2', '--no-cache', '--timeout', '3', ...SIZE]);
  assert.notEqual(r.code, 0, 'without the cache the render fails');
  assert.match(r.out, /load failed/);
  const px = firstFrameRGBA(path.join(tmp, 'cdn2.mp4'), 320, 180);
  assert.ok(px(160, 90)[0] > 200 && px(160, 90)[2] < 60, 'orange from the cached module');
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
