/* Shared browser audio fingerprints and conservative multi-episode matching. */
(() => {
    const SAMPLE_RATE = 8000;
    const WINDOW = 16000;
    const FFT_SIZE = 16384;
    const cosines = Float64Array.from({ length: FFT_SIZE / 2 }, (_, index) => Math.cos(-2 * Math.PI * index / FFT_SIZE));
    const sines = Float64Array.from({ length: FFT_SIZE / 2 }, (_, index) => Math.sin(-2 * Math.PI * index / FFT_SIZE));

    function fft(real, imaginary) {
        for (let i = 1, j = 0; i < real.length; i += 1) {
            let bit = real.length >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                [real[i], real[j]] = [real[j], real[i]];
                [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
            }
        }
        for (let size = 2; size <= real.length; size *= 2) {
            const stride = FFT_SIZE / size;
            for (let start = 0; start < real.length; start += size) {
                for (let k = 0; k < size / 2; k += 1) {
                    const a = start + k;
                    const b = a + size / 2;
                    const cosine = cosines[k * stride];
                    const sine = sines[k * stride];
                    const r = cosine * real[b] - sine * imaginary[b];
                    const im = sine * real[b] + cosine * imaginary[b];
                    real[b] = real[a] - r;
                    imaginary[b] = imaginary[a] - im;
                    real[a] += r;
                    imaginary[a] += im;
                }
            }
        }
    }

    function extract(samples) {
        const duration = samples.length / SAMPLE_RATE;
        const features = [];
        const energies = [];
        const taper = Float64Array.from({ length: WINDOW }, (_, i) =>
            0.5 * (1 - Math.cos(2 * Math.PI * i / (WINDOW - 1))));
        const edges = Array.from({ length: 33 }, (_, i) =>
            Math.ceil(80 * (3800 / 80) ** (i / 32) * FFT_SIZE / SAMPLE_RATE));
        for (let start = 0; start + WINDOW <= samples.length; start += SAMPLE_RATE) {
            // Preserve absolute timestamps while avoiding FFT work in the middle.
            if (start / SAMPLE_RATE > 300 && (start + WINDOW) / SAMPLE_RATE < duration - 300) {
                features.push(Array(32).fill(0));
                energies.push(0);
                continue;
            }
            const real = new Float64Array(FFT_SIZE);
            const imaginary = new Float64Array(FFT_SIZE);
            let energy = 0;
            for (let i = 0; i < WINDOW; i += 1) {
                real[i] = samples[start + i] * taper[i];
                energy += samples[start + i] ** 2;
            }
            fft(real, imaginary);
            const bands = edges.slice(0, -1).map((left, index) => {
                let sum = 0;
                for (let bin = left; bin < edges[index + 1]; bin += 1) {
                    sum += real[bin] ** 2 + imaginary[bin] ** 2;
                }
                return Math.log1p(sum / (edges[index + 1] - left));
            });
            const mean = bands.reduce((sum, value) => sum + value, 0) / bands.length;
            const norm = Math.max(1e-8, Math.hypot(...bands.map(value => value - mean)));
            features.push(bands.map(value => (value - mean) / norm));
            energies.push(Math.sqrt(energy / WINDOW));
        }
        return { duration, features, energies };
    }

    function region(audio, type) {
        const span = Math.min(300, audio.duration / 2);
        return audio.features.map((_, index) => index).filter(index =>
            type === 'opening' ? index + 2 <= span : index >= audio.duration - span);
    }

    function match(left, right, type) {
        const rows = region(left, type);
        const columns = region(right, type);
        let best = null;
        for (let offset = -rows.length + 1; offset < columns.length; offset += 1) {
            let hits = [];
            const flush = () => {
                if (!hits.length) return;
                const first = hits[0];
                const last = hits[hits.length - 1];
                const length = last.i - first.i + 2;
                if (length >= 40 && hits.length / (length - 1) >= 0.9) {
                    const score = hits.reduce((sum, hit) => sum + hit.score, 0) / hits.length;
                    if (!best || length * score > best.weight) {
                        best = {
                            type, start: rows[first.i], end: rows[last.i] + 2,
                            referenceStart: columns[first.j], referenceEnd: columns[last.j] + 2,
                            similarity: score, weight: length * score,
                        };
                    }
                }
                hits = [];
            };
            for (let i = Math.max(0, -offset); i < Math.min(rows.length, columns.length - offset); i += 1) {
                const j = i + offset;
                const a = left.features[rows[i]];
                const b = right.features[columns[j]];
                const score = a.reduce((sum, value, bin) => sum + value * b[bin], 0);
                if (score >= 0.96 && left.energies[rows[i]] > 0.002 && right.energies[columns[j]] > 0.002) {
                    if (hits.length && i - hits[hits.length - 1].i > 3) flush();
                    hits.push({ i, j, score });
                }
            }
            flush();
        }
        return best;
    }

    function detect(episodes) {
        const results = episodes.map(item => ({ id: item.id, duration: item.duration, segments: [] }));
        for (let left = 0; left < episodes.length; left += 1) {
            for (let right = left + 1; right < episodes.length; right += 1) {
                for (const type of ['opening', 'ending']) {
                    const pair = match(episodes[left], episodes[right], type);
                    if (!pair) continue;
                    results[left].segments.push({ ...pair, reference: episodes[right].id });
                    results[right].segments.push({
                        ...pair, start: pair.referenceStart, end: pair.referenceEnd,
                        reference: episodes[left].id,
                    });
                }
            }
        }
        for (const result of results) {
            const confirmed = [];
            for (const type of ['opening', 'ending']) {
                const evidence = result.segments.filter(item => item.type === type);
                if (!evidence.length) continue;
                const [a, b] = evidence;
                if (b && (Math.abs(a.start - b.start) > 5 || Math.abs(a.end - b.end) > 5)) continue;
                // Use the intersection to avoid skipping outside the shared audio.
                const start = Math.max(a.start, b?.start ?? a.start);
                const end = Math.min(a.end, b?.end ?? a.end, result.duration);
                if (end - start >= 40) confirmed.push({ type, start, end });
            }
            result.segments = confirmed;
        }
        return { episodes: results };
    }

    globalThis.SyncWatchOpedAudio = { extract, detect };
})();
