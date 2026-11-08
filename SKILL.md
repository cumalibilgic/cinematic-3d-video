---
name: cinematic-3d-video
description: Create advanced 3D-animation-style videos (product turntables, logo and title reveals, abstract motion graphics, camera fly-throughs, short cinematic scenes, social clips) by writing a Three.js scene, rendering it frame by frame in headless Chrome and encoding it with ffmpeg; a headless Blender path covers photoreal work. Use this skill whenever the user asks for a 3D video, 3D animation, motion-graphics clip, intro/outro, logo or title reveal, product showcase, camera fly-through, "cinematic" render, or any MP4 made from code, even if they never mention Three.js, WebGL, Blender or ffmpeg.
---

# Cinematic 3D video

Claude cannot generate video pixels directly, but it can write a 3D scene as code, render it one frame at a
time and encode the frames. This skill is that pipeline.

```
scene (HTML + Three.js)  -- window.seek(t) -->  scripts/render.mjs  -->  headless Chrome screenshots  -->  ffmpeg  -->  MP4
```

`render.mjs` steps a virtual clock instead of recording in real time. The result is the same on every machine,
and a heavy scene cannot stutter; it just renders more slowly. That is why a scene must be a pure function of time
(see "Scene rules").

## 1. Check the tools first

```bash
node -v        # 22 or newer (render.mjs uses the built-in WebSocket)
ffmpeg -version
```

Chrome, Edge or Chromium must be installed (found automatically; set `CHROME_PATH` to override). Three.js is loaded
from a CDN by the scene, so the machine that renders needs internet access unless Three.js is vendored (see
`references/troubleshooting.md`). If a tool is missing, tell the user exactly what to install and stop guessing at
workarounds. Blender is only needed for the photoreal path.

Run the dependency-free smoke test once when a machine is new. It proves Chrome, WebGL and ffmpeg all work, so any
later problem is in the scene and not the setup:

```bash
node <skill-dir>/scripts/render.mjs <skill-dir>/templates/smoke-test.html --out smoke.mp4 --duration 2 --width 640 --height 360
```

## 2. Workflow

1. **Pin down the brief** in one or two sentences: subject, mood, length, aspect ratio, any text, audio. When the
   user leaves things open, choose defaults and say what you chose: 1920x1080, 30 fps, 8-12 s, dark background,
   one hero object, one camera move, one title. Vertical (TikTok/Reels/Shorts) is 1080x1920. Asking more than one
   short question before starting is rarely worth it; a first render is the best question.
2. **Start from the starter.** Copy `templates/starter/` into the working directory (`cp -r`) and edit `index.html`.
   It already has the renderer, tone mapping, studio reflections, bloom, shadows, seeded particles, a camera path,
   an HTML title overlay and the timeline hook. Replace the hero object, palette, camera path and text; keep the plumbing.
3. **Look at stills before rendering video.** Render a handful of frames at full size at the busiest moments and
   open them (Read the PNGs):
   ```bash
   node <skill-dir>/scripts/render.mjs my-video/index.html --stills 0,2,4,6,7.5 --out my-video/stills
   ```
   Fix composition, exposure, colour and text legibility here. A still takes a second or two; a full render takes minutes.
4. **Render once.** Pick the settings, then render the whole video:
   ```bash
   node <skill-dir>/scripts/render.mjs my-video/index.html --out my-video/video.mp4 --width 1920 --height 1080 --fps 30 --scale 2
   ```
   `--scale 2` renders at 2x and downsamples, which removes shimmering edges (worth it for the final render only).
   Long renders belong in the background with progress polled, so the user is never left staring at a silent terminal.
5. **Verify the file, not the log.** `ffprobe` for duration, size and fps; pull two or three frames out of the MP4
   (`ffmpeg -ss 3 -i video.mp4 -frames:v 1 check.png`) and look at them. Then hand over the MP4 plus the scene
   folder so the user can tweak it.
6. **Revisions** change the scene and re-render. Use `--start`/`--end` to re-render only a range while iterating on one moment.

## 3. Scene rules (and why)

- **Everything animated is a pure function of `t` seconds**, set inside `update(t)`. No `Math.random()` (use the
  seeded `rng()`), no `Date.now()`, no `clock.getDelta()`, no accumulating state between frames. The renderer may
  call `seek` with any time in any order, and a preview in the browser must match the video exactly.
- **The page contract** is `window.seek(t)` (draw synchronously), `window.__duration` (seconds) and
  `window.__ready = true` once assets are loaded. `installTimeline()` in `lib/stage.js` does all three. Details in
  `references/contract.md`.
- **HDR colours above 1.0 make things glow.** Bloom only picks up pixels brighter than its threshold, so emissive
  parts use `new THREE.Color(hex).multiplyScalar(3..6)`; ordinary surfaces stay below the threshold.
- **Text is HTML/CSS** over the canvas (the screenshot includes the page). It is crisp at any resolution, needs no
  font files, and animates with plain style changes inside `update(t)`.
- **Load assets with `await` before setting `__ready`** (GLTF models, textures, fonts). A frame rendered before an
  asset arrives is a permanent glitch in the video.
- **Keep one light story**: a key light, one or two coloured rim lights, and image-based reflections. Reflective
  materials (metal, glass, clearcoat) on a dark, slightly reflective floor are what read as "3D animation" rather than
  "web demo". `references/cinematography.md` has the recipes for camera moves, pacing, easing, lighting and colour.

## 4. Several scenes, audio, other formats

- **Multi-scene videos:** render each scene to its own MP4 with identical size, fps and encoder settings, then join
  without re-encoding: write a `list.txt` with `file 'a.mp4'` lines and run
  `ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`. Put crossfades inside a scene's own timeline (the last second
  of one scene and first second of the next both fade through black/colour) rather than blending finished files,
  which would encode everything twice.
- **Audio:** `--audio track.mp3` muxes it in and trims to the video. To change only the sound later:
  `ffmpeg -i video.mp4 -i new.mp3 -map 0:v -map 1:a -c:v copy -shortest out.mp4`.
- **GIF / WebM / smaller copy:** re-encode the finished MP4 with ffmpeg; never re-render for a format change.
- **Changing one scene** means re-rendering that scene's file (and the next one only if a crossfade lives in it).

## 5. When to use Blender instead

Use Blender (`references/blender.md`, `templates/blender/render_blender.py`) only when the brief needs what a real-time
engine cannot fake well: path-traced glass and caustics, volumetric light, subsurface skin, fluid/cloth/smoke
simulation, or fully photoreal product shots. It is much slower per frame and needs Blender 4+ installed; for
everything else Three.js gets to a good result in a fraction of the time and iterates faster.

## Reference files

| File | Read it when |
|---|---|
| `references/contract.md` | writing a scene from scratch, loading models/textures, or debugging "never set `__ready`" |
| `references/cinematography.md` | making the result look good: camera, light, materials, easing, pacing, colour, text, particles |
| `references/troubleshooting.md` | black frames, slow renders, CDN/offline setup, Windows/macOS/Linux quirks, odd sizes |
| `references/blender.md` | photoreal or simulation work |
| `scripts/render.mjs` | all options: `node scripts/render.mjs --help` |
