"""Run in background Blender with --python render.py -- scene.py output-dir."""
import math
import os
import sys
from pathlib import Path
import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scene import parse_scene

source_path, dest = sys.argv[sys.argv.index("--") + 1:]
try:
    seconds, sky, objects = parse_scene(Path(source_path).read_text(encoding="utf-8"))
except ValueError as exc:
    print("REA_ERROR " + str(exc), flush=True)
    raise SystemExit(2)

def rgb(code):
    return tuple((int(code[i:i+2], 16) / 255) ** 2.2 for i in (1, 3, 5)) + (1,)

def aim(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat('-Z', 'Y').to_euler()

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.world = bpy.data.worlds.new("Sky")
scene.world.color = (0.22, 0.22, 0.22)
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 3
scene.cycles.max_bounces = 2
scene.cycles.use_denoising = False
scene.render.threads_mode = 'FIXED'
scene.render.threads = 1
scene.render.resolution_x = 384
scene.render.resolution_y = 216
scene.render.resolution_percentage = 100
scene.render.fps = 12
scene.frame_end = seconds * scene.render.fps
ops = bpy.ops.mesh
makers = {'cube': ops.primitive_cube_add, 'sphere': ops.primitive_uv_sphere_add, 'torus': ops.primitive_torus_add,
          'cone': ops.primitive_cone_add, 'cylinder': ops.primitive_cylinder_add, 'crystal': ops.primitive_ico_sphere_add}
bounds = []
for kind, loc, scale, color, spin, move, tilt in objects:
    makers[kind](location=loc)
    obj = bpy.context.object
    obj.scale = scale
    mat = bpy.data.materials.new(kind)
    mat.diffuse_color = rgb(color)
    obj.data.materials.append(mat)
    if kind in ('sphere','torus','cylinder'):
        for poly in obj.data.polygons:
            poly.use_smooth = True
    if kind == 'cube':
        bevel = obj.modifiers.new("Beveled edges", 'BEVEL')
        bevel.width = .13
        bevel.segments = 3
        obj.modifiers.new("Edge normals", 'WEIGHTED_NORMAL')
    for f, amount in ((1, 0), (scene.frame_end, 1)):
        obj.location = tuple(a + b * amount for a, b in zip(loc, move))
        obj.rotation_euler = tuple(math.radians(a + b * amount) for a, b in zip(tilt, spin))
        obj.keyframe_insert(data_path='location', frame=f)
        obj.keyframe_insert(data_path='rotation_euler', frame=f)
        bounds.append((Vector(obj.location), max(scale)*1.6))
center = Vector(tuple((min(p[i]-s for p,s in bounds)+max(p[i]+s for p,s in bounds))/2 for i in range(3)))
radius = max((p-center).length + s for p,s in bounds)
base = min(p.z-s for p,s in bounds)
ops.primitive_plane_add(size=200, location=(0,0,base))
floor = bpy.data.materials.new("Backdrop")
floor.diffuse_color = rgb(sky)
bpy.context.object.data.materials.append(floor)
bpy.ops.object.camera_add(location=center+Vector((5,-8,4.5)).normalized()*radius*4.9)
cam=bpy.context.object
aim(cam,center)
scene.camera=cam
cam.data.lens=42
for offset,power in [((-3,-4,6),135),((2,3,4),195)]:
    bpy.ops.object.light_add(type='AREA',location=center+Vector(offset)*radius)
    light=bpy.context.object
    light.data.energy=power*radius**2
    light.data.shape='DISK'
    light.data.size=3*radius
    aim(light,center)
scene.render.image_settings.file_format='PNG'
scene.render.image_settings.color_mode='RGB'
scene.render.filepath=os.path.join(dest,'frame-')
print('REA_TOTAL', scene.frame_end, flush=True)
def frame_done(s):
    print('REA_FRAME', s.frame_current, flush=True)
bpy.app.handlers.render_write.append(frame_done)
bpy.ops.render.render(animation=True)
