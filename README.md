# cinematic-3d-video

A [Claude skill](https://docs.claude.com) that teaches Claude to make **3D-animation-style videos** (logo and title
reveals, product showcases, abstract motion graphics, camera fly-throughs) by writing a Three.js scene as code,
rendering it frame by frame in headless Chrome and encoding it with ffmpeg. A headless Blender path is included for
photoreal work.

Türkçe açıklama: [README.tr.md](README.tr.md)

```
scene.html (Three.js)  --window.seek(t)-->  scripts/render.mjs  -->  headless Chrome  -->  ffmpeg  -->  video.mp4
```

The renderer steps a virtual clock rather than recording in real time, so output is deterministic and heavy scenes
never stutter. It has **no npm dependencies**: Node 22+, ffmpeg and Chrome/Edge are all it needs.

## Install

**Claude Code** (skills live in a folder):

```bash
# macOS / Linux
git clone https://github.com/cumalibilgic/cinematic-3d-video ~/.claude/skills/cinematic-3d-video
# Windows (PowerShell)
git clone https://github.com/cumalibilgic/cinematic-3d-video "$env:USERPROFILE\.claude\skills\cinematic-3d-video"
```

**Claude.ai / desktop app:** zip the `cinematic-3d-video` folder (the zip must contain that folder with `SKILL.md`
inside) and upload it under *Settings, Capabilities, Skills*. The skill needs a session that can run Node, ffmpeg and
Chrome, so it works best in Claude Code or a desktop session with code execution.

## Requirements

| Tool | Version | Windows | macOS |
|---|---|---|---|
| Node.js | 22+ | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
| ffmpeg | any recent | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |
| Chrome or Edge | any recent | usually installed | usually installed |
| Blender (optional) | 4.x | blender.org | blender.org |

A GPU is not required but makes rendering much faster. The log prints which WebGL renderer was used.

## Quick start

```bash
# 1. prove the toolchain works (no downloads, 2 seconds of video)
node scripts/render.mjs templates/smoke-test.html --out smoke.mp4 --duration 2 --width 640 --height 360

# 2. copy the starter scene and look at a few frames
cp -r templates/starter my-video
node scripts/render.mjs my-video/index.html --stills 0,3,5.6,7.5 --out my-video/stills

# 3. render the full video (2x supersampling for smooth edges)
node scripts/render.mjs my-video/index.html --out my-video/video.mp4 --scale 2

# live preview in a browser tab (real-time loop)
node scripts/render.mjs my-video/index.html --serve
```

Or just ask Claude: *"Make a 10-second cinematic 3D intro for 'AURORA' with glowing rings and a slow camera orbit,
vertical 1080x1920."* The skill takes it from there.

## What is in the box

```
SKILL.md                    instructions Claude follows (workflow, scene rules, when to use Blender)
scripts/render.mjs          deterministic renderer: Chrome DevTools + ffmpeg, no dependencies
templates/smoke-test.html   dependency-free WebGL scene that checks the toolchain
templates/starter/          Three.js starter: glossy hero, rings, particles, bloom, camera path, HTML title
templates/blender/          headless Blender template (Cycles, GPU if available)
references/                 page contract, cinematography guide, troubleshooting, Blender notes
```

## The page contract in one paragraph

Any web page that defines `window.seek(t)` (draw the frame for time `t` in seconds, synchronously),
`window.__duration` and sets `window.__ready = true` can be rendered, whether it uses Three.js, plain WebGL, Canvas,
SVG or a GSAP timeline. Everything animated must be a pure function of `t`. See `references/contract.md`.

## Status and limitations

- The render pipeline and the animation helpers are tested (the smoke test renders and encodes end to end).
- The Three.js starter scene's *look* (light intensities, bloom strength) was tuned by reasoning rather than by eye;
  expect to adjust it on the first real render. Three.js itself loads from a CDN (pinned to r170) unless you vendor it.
- No motion blur, alpha-channel output or audio-reactive features yet.
- The Blender template targets Blender 4.x and was not run in the authoring environment; treat the first run as a test.

## License

MIT, see [LICENSE](LICENSE).
