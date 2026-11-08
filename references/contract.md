# The page contract

`scripts/render.mjs` can render **any** web page that follows this contract. The starter uses Three.js, but plain
WebGL, Canvas 2D, SVG, GSAP/anime.js timelines, regl or Babylon work the same way (`templates/smoke-test.html` is a
dependency-free WebGL example).

| Name | Required | Meaning |
|---|---|---|
| `window.seek(t)` | yes | Draw the frame for time `t` (seconds, float) **synchronously**, then return. |
| `window.__ready = true` | yes | Set once everything is loaded and `seek(0)` would show a complete frame. |
| `window.__duration` | no | Length in seconds. Without it pass `--duration`. |
| `?live` in the URL | convention | Play as a real-time loop in a normal browser tab (`render.mjs scene.html --serve` prints the link). |

## What the renderer does

1. Serves the scene's folder on a local HTTP port (so ES modules, `fetch` and model/texture loading work; `file://` would not).
2. Opens the page in headless Chrome at `width x height` with `deviceScaleFactor = --scale`.
3. Waits for `window.__ready === true`.
4. For each frame `i`: `seek(start + i/fps)`, waits one animation frame so the compositor has the new pixels,
   captures a JPEG (q92, or PNG with `--png`) and writes it to ffmpeg's stdin.
5. ffmpeg encodes H.264 (`yuv420p`, `+faststart`) into a `.partial.mp4` that is renamed only when ffmpeg exits cleanly,
   so a stopped render never leaves a file that looks finished.

## Writing `seek(t)` correctly

- Pure function of `t`: the same `t` always gives the same image. Derive positions, rotations, opacity, light
  intensity and camera from `t` with helpers like `seg()` and `keys()` (`templates/starter/lib/math.js`).
- Canvas/WebGL contexts need `preserveDrawingBuffer: true`; the screenshot is taken after `seek` returns, and without
  it some drivers present an empty buffer.
- Render with `devicePixelRatio` (e.g. `renderer.setPixelRatio(devicePixelRatio)`); `--scale 2` relies on it for supersampling.
- Size the canvas from `innerWidth/innerHeight`, not hard-coded numbers, so any `--width/--height` works.
- Anything asynchronous (GLTFLoader, TextureLoader, `document.fonts.ready`) must finish before `__ready = true`:
  ```js
  const gltf = await new GLTFLoader().loadAsync('./models/hero.glb');
  await document.fonts.ready;
  window.__ready = true;
  ```
- Physics or particle simulations that depend on the previous frame are not allowed. Either express them in closed
  form of `t`, or precompute the whole simulation into an array before `__ready` and index it by `t`.
- CSS animations and `setTimeout` do not follow the virtual clock. Drive DOM styles from `update(t)`.

## Debugging

`render.mjs` prints page exceptions, `console.error`, failed loads (e.g. an unreachable CDN) and 404s. Use `--verbose`
for `console.log` too. If the scene never becomes ready you get an error pointing back to this contract.
Add `?live` and open the served URL in a real browser to use the dev tools.
