"""Persist detection and review results through atomic file replacement."""

import json
import os
import tempfile
from pathlib import Path


def save_result(path, result):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False,
        ) as handle:
            temporary = handle.name
            json.dump(result, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def approved_result(result):
    # Export only explicitly approved segments; consensus alone is insufficient.
    return {
        "schemaVersion": result["schemaVersion"],
        "seriesId": result["seriesId"],
        "status": "reviewed",
        "episodes": [
            {
                "id": episode["id"],
                "url": episode.get("url", ""),
                "duration": episode["duration"],
                "segments": [
                    {key: segment[key] for key in ("type", "start", "end")}
                    for segment in episode["segments"]
                    if segment.get("reviewStatus") == "approved"
                ],
            }
            for episode in result["episodes"]
        ],
    }
