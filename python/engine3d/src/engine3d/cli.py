#!/usr/bin/env python3
"""
engine3d.cli — Text-based protocol for dsh tool layer (TS bridge).

Usage (from dsh’s cmd tool or any script):
    echo '{"action":"build","kind":"sphere","params":{"radius":2}}' | python -m engine3d.cli > result.json

Response (always valid JSON on stdout, even on error):
    Success:    {"ok":true,"format":"glb","data":<base64>}
    Failed:     {"ok":false,"error":"<message>"}
"""

from __future__ import annotations

import base64
import json
import sys
from typing import Any

import numpy as np

try:
    import trimesh
    import io
except ModuleNotFoundError as e:
    print(json.dumps({"ok": False, "error": f"Missing dependency: {e}. Run: pip install trimesh"}))
    sys.exit(1)


def encode_mesh(mesh: "trimesh.Trimesh", fmt: str = "glb") -> str:
    """Serialize mesh to GLB/OBJ/PLY/STL and return base64 string."""
    fmt = fmt.lower()
    valid = ("glb", "obj", "ply", "stl")
    if fmt not in valid:
        raise ValueError(f"unsupported format '{fmt}'; choose {valid}")

    bio = io.BytesIO()
    if fmt == "glb":
        mesh.export(bio, file_type="glb")
    elif fmt == "obj":
        mesh.export(bio, file_type="obj")
    elif fmt == "ply":
        mesh.export(bio, file_type="ply")
    elif fmt == "stl":
        mesh.export(bio, file_type="stl")
    else:
        mesh.export(bio, file_type=fmt)  # pragma: no cover
    return base64.b64encode(bio.getvalue()).decode("ascii")


def handle(request: dict[str, Any]) -> dict[str, Any]:
    """Parse request and build/dump mesh."""
    action = request.get("action", "")
    if action == "build":
        from .primitives import build

        kind = request.get("kind", "")
        params = request.get("params", {}) or {}
        fmt = request.get("format", "glb")

        if not kind:
            return {"ok": False, "error": "missing 'kind' parameter"}
        try:
            mesh = build(kind, params)
            return {"ok": True, "format": fmt, "data": encode_mesh(mesh, fmt)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    elif action == "info":
        # lightweight health/metadata check
        sizes = ["box", "sphere", "cylinder", "cone", "torus"]
        return {
            "ok": True,
            "trimesh_version": trimesh.__version__,
            "primitives": sizes,
        }

    else:
        return {"ok": False, "error": f"unknown action '{action}'"}


def main() -> None:
    """Entry point: read JSON from stdin, write JSON to stdout."""
    try:
        raw = sys.stdin.buffer.read()
        if not raw.strip():
            raise ValueError("empty input")
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"parse error: {e}"}))
        sys.exit(1)

    resp = handle(req)
    print(json.dumps(resp))


if __name__ == "__main__":
    main()