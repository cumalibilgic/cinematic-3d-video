"""
Headless Blender scene: glossy hero object, orbiting camera, area lights, Cycles (GPU if available) -> PNG frames.

    blender -b -P render_blender.py -- --out frames --frames 240 --fps 30 --res 1920x1080 --samples 64

Then encode:
    ffmpeg -framerate 30 -i frames/frame_%04d.png -c:v libx264 -crf 18 -pix_fmt yuv420p video.mp4

Written against Blender 4.x. It has NOT been run in the environment where this skill was authored (no Blender there),
so treat the first run as a test: render 1-2 frames (--frames 2) and read Blender's console output.
This is a starting point; replace the hero, materials, lights and camera path with what the brief needs.
"""
import argparse
import math
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--out", default="frames")
ap.add_argument("--frames", type=int, default=240)
ap.add_argument("--fps", type=int, default=30)
ap.add_argument("--res", default="1920x1080")
ap.add_argument("--samples", type=int, default=64)
ap.add_argument("--orbit-degrees", type=float, default=120)
args = ap.parse_args(argv)
res_x, res_y = (int(v) for v in args.res.lower().split("x"))

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def look_at(obj, target):
    c = obj.constraints.new("TRACK_TO")
    c.target = target
    c.track_axis = "TRACK_NEGATIVE_Z"
    c.up_axis = "UP_Y"


# ---- hero ------------------------------------------------------------------------------------
bpy.ops.mesh.primitive_monkey_add(size=2.2, location=(0, 0, 1.2))
hero = bpy.context.active_object
bpy.ops.object.shade_smooth()
sub = hero.modifiers.new("Subdivision", "SUBSURF")
sub.levels = 2
sub.render_levels = 3
mat = bpy.data.materials.new("HeroMetal")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.55, 0.65, 1.0, 1.0)
bsdf.inputs["Metallic"].default_value = 1.0
bsdf.inputs["Roughness"].default_value = 0.18
hero.data.materials.append(mat)

# ---- floor -----------------------------------------------------------------------------------
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
floor = bpy.context.active_object
fmat = bpy.data.materials.new("Floor")
fmat.use_nodes = True
fb = fmat.node_tree.nodes["Principled BSDF"]
fb.inputs["Base Color"].default_value = (0.02, 0.025, 0.04, 1.0)
fb.inputs["Metallic"].default_value = 0.8
fb.inputs["Roughness"].default_value = 0.25
floor.data.materials.append(fmat)

# ---- world -----------------------------------------------------------------------------------
world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (0.01, 0.012, 0.02, 1.0)
bg.inputs[1].default_value = 1.0

# ---- lights (area lights aimed at the hero) --------------------------------------------------
for name, loc, energy, color in (
    ("Key", (4, -4, 6), 900, (1.0, 1.0, 1.0)),
    ("RimMagenta", (-5, 3, 3), 700, (1.0, 0.18, 0.58)),
    ("RimCyan", (5, 4, 2.5), 700, (0.18, 0.89, 1.0)),
):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = 3
    data.color = color
    light = link(bpy.data.objects.new(name, data))
    light.location = loc
    look_at(light, hero)

# ---- camera on an orbiting pivot ---------------------------------------------------------------
pivot = link(bpy.data.objects.new("Pivot", None))
pivot.location = (0, 0, 1.2)
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 60
cam = link(bpy.data.objects.new("Camera", cam_data))
cam.parent = pivot
cam.location = (0, -7.5, 0.8)
look_at(cam, hero)
scene.camera = cam

scene.frame_start, scene.frame_end = 1, args.frames
pivot.rotation_euler = (0, 0, 0)
pivot.keyframe_insert("rotation_euler", frame=1)
pivot.rotation_euler = (0, 0, math.radians(args.orbit_degrees))
pivot.keyframe_insert("rotation_euler", frame=args.frames)  # default Bezier interpolation = eased orbit

hero.rotation_euler = (0, 0, 0)
hero.keyframe_insert("rotation_euler", frame=1)
hero.rotation_euler = (0, 0, math.radians(90))
hero.keyframe_insert("rotation_euler", frame=args.frames)

# ---- render settings ---------------------------------------------------------------------------
r = scene.render
r.resolution_x, r.resolution_y, r.resolution_percentage = res_x, res_y, 100
r.fps = args.fps
r.engine = "CYCLES"
scene.cycles.samples = args.samples
scene.cycles.use_denoising = True
for transform in ("AgX", "Filmic"):  # AgX in 4.x, Filmic in 3.x
    try:
        scene.view_settings.view_transform = transform
        break
    except TypeError:
        continue

prefs = bpy.context.preferences.addons["cycles"].preferences
for kind in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
    try:
        prefs.compute_device_type = kind
    except TypeError:
        continue
    prefs.get_devices()
    gpus = [d for d in prefs.devices if d.type != "CPU"]
    if gpus:
        for d in prefs.devices:
            d.use = d.type != "CPU"
        scene.cycles.device = "GPU"
        print("Cycles GPU:", kind, [d.name for d in gpus])
        break
else:
    print("No GPU device found for Cycles; rendering on CPU")

r.image_settings.file_format = "PNG"
r.filepath = args.out.rstrip("/\\") + "/frame_"
bpy.ops.render.render(animation=True)
print("Frames written to", args.out)
