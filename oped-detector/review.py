"""Review candidate boundaries locally before exporting skip timestamps."""

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from result_store import approved_result, save_result


def main():
    parser = argparse.ArgumentParser(description="Review OP/ED candidate segments.")
    parser.add_argument("result", type=Path)
    parser.add_argument("--episode")
    parser.add_argument("--segment", type=int, help="One-based segment number")
    parser.add_argument("--decision", choices=("approved", "rejected", "pending"))
    parser.add_argument("--start", type=float)
    parser.add_argument("--end", type=float)
    parser.add_argument("--export", type=Path)
    args = parser.parse_args()
    result = json.loads(args.result.read_text(encoding="utf-8"))

    if args.decision:
        episode = next((item for item in result["episodes"] if item["id"] == args.episode), None)
        if episode is None or args.segment is None or not 1 <= args.segment <= len(episode["segments"]):
            parser.error("Choose a valid episode and one-based segment number.")
        segment = episode["segments"][args.segment - 1]
        start = segment["start"] if args.start is None else args.start
        end = segment["end"] if args.end is None else args.end
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= episode["duration"]):
            parser.error("Boundaries must satisfy 0 <= start < end <= duration.")
        segment.update({
            "start": start,
            "end": end,
            "reviewed": args.decision != "pending",
            "reviewStatus": args.decision,
            "reviewedAt": datetime.now(timezone.utc).isoformat(),
        })
        save_result(args.result, result)
    elif any(value is not None for value in (args.start, args.end, args.segment, args.episode)):
        parser.error("Editing a segment requires --decision.")

    if args.export:
        if args.export.resolve() == args.result.resolve():
            parser.error("Export must not overwrite the evidence file.")
        save_result(args.export, approved_result(result))

    for episode in result["episodes"]:
        print(f"{episode['id']} ({episode['duration']:.1f}s)")
        for index, segment in enumerate(episode["segments"], start=1):
            print(
                f"  {index}. {segment['type']} {segment['start']:.1f}-{segment['end']:.1f}s"
                f" | support={segment.get('supportCount', 1)}"
                f" | consensus={segment.get('consensus', False)}"
                f" | {segment.get('reviewStatus', 'pending')}"
            )


if __name__ == "__main__":
    main()
