"""
engine3d.primitives — Source-level embedded 3D geometry generation.

Pure-Python procedural generators (no API, no network, no limits, MIT trimesh
dependency). This replaces keyed cloud generators (Meshy/Tripo) for the
*structural* part of the 3D pipeline: parametric solids, extrusions, and
boolean-ready meshes. Cloud text/image→mesh remains an optional accelerator
layer on top of these primitives.

The TS plugin calls these via a small stdin/stdout JSON bridge (engine3d.cli),
so the agent gets a free, offline 3D primitive backend out of the box.
"""

from __future__ import annotations

from typing import Any, Optional

import numpy as np

try:
    import trimesh
except ModuleNotFoundError:  # graceful degrade with a clear, actionable error
    trimesh = None  # type: ignore[assignment]


def _require_trimesh() -> None:
    if trimesh is None:
        raise RuntimeError(
            "engine3d requires `trimesh` (pip install trimesh). It is a pure-Python/"
            "NumPy MIT-licensed library with no network access or API keys."
        )


def box(dimensions: list[float] | None = None, center: list[float] | None = None) -> "trimesh.Trimesh":
    """Axis-aligned box. `dimensions` = [dx, dy, dz]; `center` = [x, y, z]."""
    _require_trimesh()
    dims = dimensions or [1.0, 1.0, 1.0]
    box_mesh = trimesh.creation.box(extents=dims)
    if center:
        box_mesh.apply_translation(center)
    return box_mesh


def sphere(radius: float = 1.0, subdivisions: int = 3, center: Optional[list[float]] = None) -> "trimesh.Trimesh":
    """UV sphere via icosphere subdivision. `subdivisions` 1..5 (~80..5120 faces)."""
    _require_trimesh()
    mesh = trimesh.creation.icosphere(subdivisions=max(1, min(subdivisions, 5)), radius=radius)
    if center:
        mesh.apply_translation(center)
    return mesh


def cylinder(radius: float = 0.5, height: float = 1.0, sections: int = 32, center: Optional[list[float]] = None) -> "trimesh.Trimesh":
    """Z-up cylinder. `sections` controls circular resolution."""
    _require_trimesh()
    mesh = trimesh.creation.cylinder(radius=radius, height=height, sections=sections)
    if center:
        mesh.apply_translation(center)
    return mesh


def cone(radius: float = 0.5, height: float = 1.0, sections: int = 32, center: Optional[list[float]] = None) -> "trimesh.Trimesh":
    """Z-up cone."""
    _require_trimesh()
    mesh = trimesh.creation.cone(radius=radius, height=height, sections=sections)
    if center:
        mesh.apply_translation(center)
    return mesh


def torus(major_radius: float = 1.0, minor_radius: float = 0.25, major_sections: int = 48, minor_sections: int = 12) -> "trimesh.Trimesh":
    """Torus (donut) mesh."""
    _require_trimesh()
    return trimesh.creation.torus(major_radius=major_radius, minor_radius=minor_radius,
                                  major_sections=major_sections, minor_sections=minor_sections)


def extrude_polygon(polygon_2d: "trimesh.path.polygons.Polygon", height: float = 1.0,
                    transform: Optional[list[list[float]]] = None) -> "trimesh.Trimesh":
    """Extrude a 2D shapely polygon into a solid prism.

    Uses trimesh.creation.extrude_polygon. If `transform` (4x4 matrix) given,
    applied post-extrusion.
    """
    _require_trimesh()
    mesh = trimesh.creation.extrude_polygon(polygon_2d, height=height)
    if transform is not None:
        mesh.apply_transform(np.asarray(transform, dtype=float))
    return mesh


# Registry so the CLI/TS bridge can dispatch by name.
_PRIMITIVES = {
    "box": box,
    "sphere": sphere,
    "cylinder": cylinder,
    "cone": cone,
    "torus": torus,
}


def build(kind: str, params: dict[str, Any] | None = None) -> "trimesh.Trimesh":
    """Dispatch a primitive by name. `kind` ∈ {box,sphere,cylinder,cone,torus}."""
    _require_trimesh()
    fn = _PRIMITIVES.get(kind)
    if fn is None:
        raise ValueError(f"unknown primitive '{kind}'; valid: {sorted(_PRIMITIVES)}")
    return fn(**(params or {}))