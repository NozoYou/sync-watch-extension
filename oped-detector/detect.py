"""Offline CLI entry point; deliberately independent of the room server."""

import argparse
import json
from pathlib import Path

from audio import load_features
from matcher import DetectorConfig, match_pair
from consensus import consolidate
from result_store import save_result


def analyze(manifest, config, neighbor_distance=2, minimum_references=2):
    episodes = manifest["episodes"]
    if len(episodes) < 2:
        raise ValueError("At least two episodes are required.")
    identifiers = [episode["id"] for episode in episodes]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Episode IDs must be unique.")

    audio = [load_features(episode["path"]) for episode in episodes]
    output = {
        "schemaVersion": 2,
        "seriesId": manifest["seriesId"],
        "status": "candidate",
        "episodes": [
            {
                "id": episode["id"],
                "url": episode.get("url", ""),
                "duration": decoded["duration"],
                "segments": [],
            }
            for episode, decoded in zip(episodes, audio)
        ],
    }

    # Compare nearby episodes without a quadratic full-series search.
    pairs = (
        (left, right)
        for left in range(len(episodes))
        for right in range(left + 1, min(len(episodes), left + neighbor_distance + 1))
    )
    for index, reference in pairs:
        for kind in ("opening", "ending"):
            for candidate in match_pair(audio[index], audio[reference], kind, config):
                output["episodes"][index]["segments"].append({
                    "type": kind,
                    "start": candidate["start"],
                    "end": candidate["end"],
                    "similarity": candidate["similarity"],
                    "referenceEpisodeId": episodes[reference]["id"],
                    "reviewed": False,
                })
                output["episodes"][reference]["segments"].append({
                    "type": kind,
                    "start": candidate["referenceStart"],
                    "end": candidate["referenceEnd"],
                    "similarity": candidate["similarity"],
                    "referenceEpisodeId": episodes[index]["id"],
                    "reviewed": False,
                })
    for episode in output["episodes"]:
        episode["segments"] = consolidate(episode["segments"], minimum_references)
    return output


def main():
    parser = argparse.ArgumentParser(description="Find candidate OP/ED audio repetitions.")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, default=Path("segments.json"))
    parser.add_argument("--threshold", type=float, default=0.94)
    parser.add_argument("--neighbors", type=int, default=2)
    parser.add_argument("--minimum-references", type=int, default=2)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    # Resolve media paths relative to the manifest, not the current directory.
    for episode in manifest["episodes"]:
        episode["path"] = str((args.manifest.parent / episode["path"]).resolve())
    if not 0 < args.threshold <= 1:
        parser.error("Threshold must be greater than zero and at most one.")
    if args.neighbors < 1 or args.minimum_references < 1:
        parser.error("Neighbors and minimum references must be positive.")
    result = analyze(
        manifest, DetectorConfig(similarity_threshold=args.threshold),
        args.neighbors, args.minimum_references,
    )
    save_result(args.output, result)


if __name__ == "__main__":
    main()
