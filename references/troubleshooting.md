# Troubleshooting

## The renderer says the scene "never set window.__ready"
Look at the lines printed above that message: page exceptions, `[load failed]` lines and 404s explain it almost every time.
- `[load failed] https://cdn.jsdelivr.net/...`: the machine is offline or blocks the CDN. Vendor Three.js (below).
- A module `import` that cannot be resolved: the import map in `index.html` is missing a `three/addons/` entry or has a typo.
- An error thrown inside your scene code before `installTimeline(...)` ran: fix it; the page never reaches the end of the script.
- A `GLTFLoader`/texture request that 404s: the file is outside the served folder. Put assets next to `index.html` (or pass `--root`).

## Offline / vendored Three.js
```bash
cd my-video && npm init -y && npm i three@0.170.0
```
Then in `index.html` change the import map to:
```json
{ "imports": { "three": "./node_modules/three/build/three.module.js", "three/addons/": "./node_modules/three/examples/jsm/" } }
```
`render.mjs` serves the scene's folder, so this works unchanged. Commit nothing from `node_modules`.

## Black, empty or flickering frames
- Missing `preserveDrawingBuffer: true` on the WebGL renderer (the starter sets it).
- `seek()` is asynchronous. It must draw before it returns.
- The first frame is black: `installTimeline` calls `seek(0)` once; custom scenes must do the same before `__ready = true`.
- Lights/shadows flicker between frames: something depends on previous state or on `Math.random()`/real time.

## Very slow rendering
- The log line `WebGL renderer: ... SwiftShader` means software rendering (no GPU access). That is 10-50x slower. On a
  normal desktop with a GPU it should show your graphics card (`ANGLE (NVIDIA ... RTX ...)`). If it does not, update the
  GPU driver, close other Chrome headless instances, or try `--gl gpu` to see the real error instead of silently falling back.
- Lower the cost per frame: `--scale 1` while iterating, shadow `mapSize` 1024, fewer particles, lower bloom resolution.
- `--crf 18 --preset veryfast` is the default; slower presets cost minutes for tiny gains. For small files raise `--crf` (23-28).
- Time budget: `frames x seconds-per-frame`. Measure with `--stills` or a 2-second `--start/--end` range first.

## Odd sizes and formats
- `--width` and `--height` must be even (H.264 `yuv420p`).
- 4K: `--width 3840 --height 2160` works if the GPU has the memory; first test a still at that size.
- Vertical: `--width 1080 --height 1920`. Make the scene respond to aspect ratio (`camera.aspect = w/h` is set from `innerWidth/innerHeight`; widen the FOV or pull the camera back for portrait).
- Transparent background / alpha video is not supported by this pipeline. Render on a flat colour and key it, or render PNG stills.

## Platform notes
- **Windows:** Chrome and Edge are found automatically. Use PowerShell or CMD with backslashes
  (`node scripts\render.mjs templates\starter\index.html --out video.mp4`). Install tools with
  `winget install OpenJS.NodeJS.LTS` and `winget install Gyan.FFmpeg`, then open a new terminal.
- **macOS:** `brew install node ffmpeg`; Chrome is found under `/Applications`.
- **Linux/containers:** install `google-chrome` or `chromium`; running as root adds `--no-sandbox` automatically. Without a
  GPU the renderer falls back to SwiftShader (works, slowly).
- Set `CHROME_PATH` to use a specific browser binary.

## ffmpeg
- `ffmpeg not found on PATH`: install it and reopen the terminal.
- Output plays but is huge: raise `--crf`. Output looks soft: lower `--crf` (16-18) and use `--scale 2`.
- The MP4 will not play on a phone: the pipeline already uses `yuv420p` and `+faststart`; check the file with `ffprobe` and re-render only if the size/fps differ from what you asked for.
