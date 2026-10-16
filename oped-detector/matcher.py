"""Find continuous similar audio in the opening and ending search regions."""

from dataclasses import dataclass

import numpy as np

from audio import HOP_SECONDS, WINDOW_SECONDS


@dataclass
class DetectorConfig:
    search_seconds: int = 300
    minimum_seconds: int = 40
    similarity_threshold: float = 0.94
    silence_threshold: float = 0.002
    maximum_gap_seconds: int = 2


def region_indices(audio, kind, config):
    times = np.arange(len(audio["features"])) * HOP_SECONDS
    # Keep opening and ending regions separate for short episodes.
    span = min(config.search_seconds, audio["duration"] / 2)
    if kind == "opening":
        return np.flatnonzero(times + WINDOW_SECONDS <= span)
    return np.flatnonzero(times >= audio["duration"] - span)


def match_pair(left, right, kind, config):
    left_indices = region_indices(left, kind, config)
    right_indices = region_indices(right, kind, config)
    if not len(left_indices) or not len(right_indices):
        return []

    scores = left["features"][left_indices] @ right["features"][right_indices].T
    audible = (
        (left["energies"][left_indices] > config.silence_threshold)[:, None]
        & (right["energies"][right_indices] > config.silence_threshold)[None, :]
    )
    matches = (scores >= config.similarity_threshold) & audible
    candidates = []

    # Diagonals represent equal-speed audio with different episode offsets.
    for offset in range(-len(left_indices) + 1, len(right_indices)):
        rows = np.arange(max(0, -offset), min(len(left_indices), len(right_indices) - offset))
        columns = rows + offset
        hits = np.flatnonzero(matches[rows, columns])
        if not len(hits):
            continue
        splits = np.flatnonzero(np.diff(hits) > config.maximum_gap_seconds + 1) + 1
        for run in np.split(hits, splits):
            first, last = int(run[0]), int(run[-1])
            length = (last - first) * HOP_SECONDS + WINDOW_SECONDS
            # Require dense matching to reject scattered similar music.
            if length < config.minimum_seconds or len(run) / (last - first + 1) < 0.85:
                continue
            candidates.append({
                "type": kind,
                "start": int(left_indices[rows[first]]) * HOP_SECONDS,
                "end": min(left["duration"], int(left_indices[rows[last]]) * HOP_SECONDS + WINDOW_SECONDS),
                "referenceStart": int(right_indices[columns[first]]) * HOP_SECONDS,
                "referenceEnd": min(right["duration"], int(right_indices[columns[last]]) * HOP_SECONDS + WINDOW_SECONDS),
                "similarity": round(float(scores[rows[run], columns[run]].mean()), 4),
            })

    # Keep the strongest continuous candidate rather than many overlapping offsets.
    return sorted(
        candidates,
        key=lambda item: (item["end"] - item["start"]) * item["similarity"],
        reverse=True,
    )[:1]
