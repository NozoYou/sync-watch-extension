"""Consolidate independent episode evidence without auto-approving segments."""

from statistics import median


def compatible(left, right, tolerance=5):
    return (
        left["type"] == right["type"]
        and abs(left["start"] - right["start"]) <= tolerance
        and abs(left["end"] - right["end"]) <= tolerance
    )


def consolidate(candidates, minimum_references=2):
    groups = []
    for candidate in sorted(candidates, key=lambda item: item["similarity"], reverse=True):
        # Complete-link grouping avoids merging unrelated segments through a chain.
        group = next(
            (items for items in groups if all(compatible(candidate, item) for item in items)),
            None,
        )
        if group is None:
            groups.append([candidate])
        else:
            group.append(candidate)

    segments = []
    for group in groups:
        references = sorted({item["referenceEpisodeId"] for item in group})
        segments.append({
            "type": group[0]["type"],
            "start": median(item["start"] for item in group),
            "end": median(item["end"] for item in group),
            "similarity": round(median(item["similarity"] for item in group), 4),
            "referenceEpisodeIds": references,
            "supportCount": len(references),
            "consensus": len(references) >= minimum_references,
            "reviewed": False,
            "reviewStatus": "pending",
            "evidence": group,
        })
    return sorted(segments, key=lambda item: (item["type"], item["start"]))
