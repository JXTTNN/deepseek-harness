"""
dsh-engine3d —— DeepSeek Harness 3D geometry engine

MIT-licensed, pure Python, offline by design.
All operations run locally, no network access, no API keys, no cost.

Exported symbols:
    build(kind, params)          -> trimesh.Trimesh   # primitive factory
    encode_mesh(mesh, fmt)       -> str (base64)      # GLB/OBJ/PLY/ST
    callEngine3d(request_dict) -> dict              # CLI bridge entry
"""

from .primitives import (
    build as build,
    box,
    sphere,
    cylinder,
    cone,
    torus,
    extrude_polygon,
)

__all__ = [
    'build',
    'box',
    'sphere',
    'cylinder',
    'cone',
    'torus',
    'extrude_polygon',
]

__version__ = '0.1.0'