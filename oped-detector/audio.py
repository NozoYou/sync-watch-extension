"""Decode local media and build normalized frequency-band fingerprints."""

import subprocess

import numpy as np


SAMPLE_RATE = 8000
WINDOW_SECONDS = 2
HOP_SECONDS = 1


def load_features(path):
    # FFmpeg supports common audio formats and local video containers.
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
            "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-f", "f32le", "pipe:1",
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    samples = np.frombuffer(result.stdout, dtype="<f4")
    duration = len(samples) / SAMPLE_RATE
    window_size = WINDOW_SECONDS * SAMPLE_RATE
    hop_size = HOP_SECONDS * SAMPLE_RATE
    frequencies = np.fft.rfftfreq(window_size, 1 / SAMPLE_RATE)
    edges = np.geomspace(80, 3800, 33)
    bands = [
        (frequencies >= left) & (frequencies < right)
        for left, right in zip(edges[:-1], edges[1:])
    ]
    taper = np.hanning(window_size)
    features = []
    energies = []

    for start in range(0, len(samples) - window_size + 1, hop_size):
        frame = samples[start:start + window_size]
        energies.append(float(np.sqrt(np.mean(frame * frame))))
        spectrum = np.abs(np.fft.rfft(frame * taper)) ** 2
        feature = np.log1p([float(spectrum[band].mean()) for band in bands])
        feature -= feature.mean()
        feature /= max(float(np.linalg.norm(feature)), 1e-8)
        features.append(feature)

    return {
        "duration": duration,
        "features": np.asarray(features, dtype=np.float32).reshape(-1, 32),
        "energies": np.asarray(energies),
    }
