# Blender path (photoreal, simulations)

Use this only when the brief needs path-traced realism or physics that a real-time engine cannot fake well. For logo
reveals, product spins, abstract motion graphics and fly-throughs the Three.js path is faster to iterate and good enough.

## Requirements
Blender 4.x on PATH (`blender --version`), ffmpeg. On the user's machine, Cycles can use an NVIDIA GPU through OptiX.
Blender is not available in every environment (it is not installed in the one this skill was written in); check
`blender --version` first and tell the user to install it from blender.org if it is missing.

## Run
```bash
blender -b -P templates/blender/render_blender.py -- --out frames --frames 240 --fps 30 --res 1920x1080 --samples 64
ffmpeg -framerate 30 -i frames/frame_%04d.png -c:v libx264 -crf 18 -pix_fmt yuv420p video.mp4
```
The script builds a hero object on a glossy floor, three coloured area lights and an orbiting camera. Treat it as a
template: copy it, replace the hero (import a `.glb`/`.fbx` with `bpy.ops.import_scene.gltf`), the materials and the
camera path. The first run should be a test: `--frames 2 --samples 16` and read the console output.

## Practical notes
- **Test small, render once:** 1 frame at 50% resolution and 16 samples to judge composition; then 2-3 frames at full quality; then the sequence.
- **Time budget:** frames x seconds-per-frame. A 10 s / 30 fps clip is 300 frames; at 10 s/frame that is 50 minutes. Cycles samples
  and resolution are the levers (denoising lets 32-64 samples look clean). EEVEE is far faster but its engine identifier changed
  across versions (`BLENDER_EEVEE_NEXT` in 4.2-4.4); if you switch, try both names in a `try/except TypeError`.
- **Render a PNG sequence, never a movie file:** a crash loses nothing, you can resume with `scene.frame_start`, and ffmpeg does the encode.
- **Resume after a crash:** pass `-s <start> -e <end> -a` on the command line, or set the frame range in the script.
- **Camera moves:** animate an empty (`pivot`) the camera is parented to, as the template does; keyframe default Bezier interpolation gives an eased move.
- **Colour:** use `AgX` (4.x) or `Filmic` view transform; "Standard" clips highlights.
- **Multi-scene videos:** render each scene's frames to its own folder, encode each with identical settings, join as in `SKILL.md`.
