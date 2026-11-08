# Making it look like 3D animation, not a web demo

Most of the "expensive" look comes from a few decisions. Work through them in this order; each one is cheap.

## Composition and camera

- **One hero, one idea per scene.** Dark, uncluttered background; the hero takes about a third to half of the frame
  height. Leave a clear area (usually the lower-left or lower-third) for the title.
- **Always move the camera, slowly.** A static camera reads as a screenshot. Good default: a slow push-in plus a
  gentle orbit (about 60-120 degrees over the whole clip) using `keys()` with `ease.inOutSine`.
- **Vary distance across the clip:** wide establishing shot, closer hero shot, then a gentle pull-out or a drift to a
  new angle for the end card. Three or four keyframes are enough.
- **Field of view:** 30-40 degrees looks cinematic and flatters products; 60+ exaggerates depth and feels like a game.
- **Frame the horizon low** (camera slightly above the floor) for a heroic look; look down from above for abstract/data scenes.
- Check the safe area: social UIs cover the bottom ~15% and top ~10% of vertical video.

## Pacing and easing

- Pick one easing family per clip. `inOutSine`/`inOutCubic` for camera, `outExpo`/`outCubic` for things appearing,
  `outBack` for a pop (use on scale only, once or twice per clip), `linear` only for continuous rotation.
- Stagger: elements that appear one after another (0.15-0.3 s apart) look designed; elements that appear together look accidental.
- The first 0.5 s should already show motion or a fade-in; the last 0.7 s should settle (fade out, or hold on the title).
- 6-10 s is plenty for a logo/title reveal; 10-20 s for a product showcase; each shot should last at least 2 s.
- Never hold a completely static frame for more than about a second; keep a slow drift going (particles, light sweep, camera creep).

## Lighting

- **Three sources.** One key light with a shadow (`DirectionalLight`, intensity ~2), two coloured rim lights from behind
  and the sides (`PointLight` intensity ~60-120 at 4-6 units, complementary colours such as magenta + cyan or orange + teal),
  and the image-based environment (`scene.environmentIntensity` 0.3-0.8) for reflections.
- Rim lights should **orbit slowly** (`position` from `cos/sin(t)`), which makes highlights slide across the metal.
- If everything looks flat: lower the environment, raise the rim lights, darken the background.
- If everything is blown out: lower `toneMappingExposure` (0.7-0.9) before touching individual lights.

## Materials

- Metal: `MeshPhysicalMaterial({ metalness: 1, roughness: 0.15-0.3, clearcoat: 1 })`. Metals need something to reflect,
  which is why the environment matters more than the lights.
- Glass-like: `transmission: 1, thickness: 0.5-2, roughness: 0.05, ior: 1.45` (slower to render; keep geometry simple).
- Matte plastic: `roughness: 0.6-0.8, metalness: 0`.
- Floor: dark and glossy (`color` ~0x080a12, `roughness` 0.2-0.35, `metalness` 0.8) gives a subtle reflection and grounds the hero.
- Emissive glow: `MeshBasicMaterial` with an HDR colour (`new THREE.Color(hex).multiplyScalar(4)`); bloom does the rest.
- Smooth surfaces need segments: `TorusKnotGeometry(1, .34, 320, 56)`, not 64x8, or facets show in reflections.

## Colour

- Choose a palette of three: a near-black base (blue-tinted black looks richer than pure black), one dominant accent, one
  contrasting accent. Keep brand colours for the hero or the title, not for everything.
- Fog (`FogExp2`, density 0.03-0.06) in the background colour adds depth for free.
- Bloom: `strength` 0.6-1.0, `radius` 0.5-0.8, `threshold` 0.8-0.9. Above ~1.2 strength everything turns into haze.

## Detail layers (add after the basics work)

- **Particles / dust:** 500-2000 `Points`, additive blending, size 0.02-0.05, seeded with `rng()`, rotating very slowly.
- **Light sweep:** animate a light or an emissive stripe across the hero once, around the title reveal.
- **Depth of field:** `BokehPass` from `three/addons/postprocessing/BokehPass.js` between RenderPass and bloom; animate `focus`
  toward the hero distance. Subtle (aperture ~0.0002) beats strong.
- **Film touches:** a small vignette and very light grain (`FilmPass`/custom shader, intensity <0.2) unify the image; skip them if the user wants a clean/corporate look.
- **Reveal effects:** scale from 0 with `outBack`; or animate `material.clippingPlanes` for a wipe; or scatter instances and
  lerp them to their targets with `seg()`.

## Text

- HTML overlay (see the starter): font size in `vh` so it scales with any resolution; uppercase with wide letter-spacing for
  titles; a soft `text-shadow` in the accent colour ties it to the scene.
- Fade in 0.5-1 s after the hero lands, hold at least 2 s, fade out before the clip ends. Keep text to 6 words or fewer per card.
- Use web-safe or locally bundled fonts. Google Fonts via `<link>` works only when the render machine is online, and the
  scene must wait for `document.fonts.ready` before `__ready`.

## Quality checklist before the final render

- [ ] Stills at the busiest frame and the title frame look right at full size
- [ ] No flickering shadows or edges at `--scale 2` (if shadows crawl, enlarge `shadow.camera` bounds or lower `mapSize` noise via `shadow.bias`)
- [ ] Title readable on its own, not hidden behind the hero at any point
- [ ] Duration and fps correct (`ffprobe`), file plays from the start without a black first frame
