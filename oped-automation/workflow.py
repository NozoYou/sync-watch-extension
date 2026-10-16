"""Automate reference selection, downloads and candidate detection in one job."""

import argparse
import json
import sys
import uuid
from pathlib import Path

from adapters import download_media, resolve_media

# Reuse the existing detector without editing or duplicating its implementation.
DETECTOR_ROOT = Path(__file__).resolve().parent.parent / "oped-detector"
sys.path.insert(0, str(DETECTOR_ROOT))
from detect import analyze
from matcher import DetectorConfig
from result_store import save_result


def select_episodes(catalog):
    if catalog.get("continuousSeries") is not True:
        raise ValueError("The website adapter has not confirmed a continuous series.")
    episodes = sorted(catalog["episodes"], key=lambda item: item["number"])
    numbers = [item["number"] for item in episodes]
    identifiers = [item["id"] for item in episodes]
    if len(set(numbers)) != len(numbers) or len(set(identifiers)) != len(identifiers):
        raise ValueError("Episode numbers and IDs must be unique.")
    current = next((index for index, item in enumerate(episodes) if item["id"] == catalog["currentEpisodeId"]), None)
    if current is None or len(episodes) < 3:
        raise ValueError("A current episode and two reference episodes are required.")
    references = sorted(
        (index for index in range(len(episodes)) if index != current),
        key=lambda index: (abs(numbers[index] - numbers[current]), index),
    )[:2]
    # The first episode naturally selects the next two; the last selects the previous two.
    return [episodes[index] for index in sorted([current, *references])]


def run(catalog, jobs_root):
    job_id = uuid.uuid4().hex
    directory = jobs_root / job_id
    directory.mkdir(parents=True)
    state = {"jobId": job_id, "stage": "selecting", "currentEpisodeId": catalog.get("currentEpisodeId")}

    def publish(stage, **details):
        state.update(stage=stage, **details)
        save_result(directory / "status.json", state)

    try:
        publish("selecting")
        selected = select_episodes(catalog)
        manifest = {"seriesId": catalog["seriesId"], "episodes": []}
        for index, episode in enumerate(selected):
            publish("resolving", episodeId=episode["id"])
            source = resolve_media(episode)
            publish("downloading", episodeId=episode["id"])
            destination = directory / f"audio-{index}.media"
            download_media(source, destination)
            manifest["episodes"].append({
                "id": episode["id"], "url": episode["url"], "path": str(destination),
            })
        publish("detecting")
        result = analyze(manifest, DetectorConfig(), neighbor_distance=2)
        save_result(directory / "candidates.json", result)
        publish("awaiting_review", resultFile="candidates.json")
    except Exception as error:
        # Do not persist signed media URLs, cookies or raw network error payloads.
        publish("failed", errorType=type(error).__name__, message="Job failed; check episode metadata, adapter support and media access.")
        raise RuntimeError(f"OP/ED job failed. Status: {directory / 'status.json'}") from None
    finally:
        # Persist fingerprints/results later; raw media is temporary job input.
        for media in directory.glob("audio-*.media"):
            media.unlink(missing_ok=True)
    return directory


def main():
    parser = argparse.ArgumentParser(description="Run an automatic OP/ED analysis job.")
    parser.add_argument("catalog", type=Path)
    parser.add_argument("--jobs", type=Path, default=Path(__file__).parent / "jobs")
    args = parser.parse_args()
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    print(run(catalog, args.jobs.resolve()))


if __name__ == "__main__":
    main()
