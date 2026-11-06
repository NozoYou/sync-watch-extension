/* Fetch finite media without delegating network access to a decoder. */
(() => {
    const decoder = new TextDecoder();
    const bytesOf = value => value instanceof Uint8Array ? value : new Uint8Array(value);
    function join(parts) {
        const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        let offset = 0;
        for (const part of parts) { output.set(part, offset); offset += part.length; }
        return output;
    }
    function attributes(text) {
        return Object.fromEntries([...text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)]
            .map(([, key, value]) => [key, value.replace(/^"|"$/g, '')]));
    }
    function aacFromTransportStream(bytes) {
        const packets = new Map();
        const audio = [];
        function finish(pid) {
            const data = packets.get(pid);
            if (!data) return;
            const pes = join(data);
            if (pes.length >= 9 && pes[0] === 0 && pes[1] === 0 && pes[2] === 1 && (pes[3] & 0xe0) === 0xc0) {
                const length = (pes[4] << 8) | pes[5];
                const payload = pes.subarray(9 + pes[8], length ? Math.min(length + 6, pes.length) : pes.length);
                audio.push(payload);
            }
            packets.delete(pid);
        }
        for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
            if (bytes[offset] !== 0x47) throw new Error('Invalid MPEG-TS packet alignment.');
            const pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2];
            const mode = (bytes[offset + 3] >> 4) & 3;
            if (mode === 0 || mode === 2) continue;
            let start = offset + 4;
            if (mode === 3) start += 1 + bytes[start];
            if (start >= offset + 188) continue;
            if (bytes[offset + 1] & 0x40) {
                finish(pid);
                if (bytes[start] === 0 && bytes[start + 1] === 0 && bytes[start + 2] === 1 && (bytes[start + 3] & 0xe0) === 0xc0) packets.set(pid, []);
            }
            packets.get(pid)?.push(bytes.subarray(start, offset + 188));
        }
        for (const pid of packets.keys()) finish(pid);
        const output = join(audio);
        if (!output.length || output[0] !== 0xff || (output[1] & 0xf6) !== 0xf0) throw new Error('HLS audio is not supported ADTS AAC.');
        return output;
    }
    async function load(url, options = {}) {
        const { fetchBytes, signal, onProgress = () => {}, maxBytes = 64 * 1024 * 1024 } = options;
        const cryptoProvider = options.crypto || globalThis.crypto;
        if (!fetchBytes) throw new Error('A validated media fetcher is required.');
        let downloadedBytes = 0;
        let requests = 0;
        async function read(target) {
            signal?.throwIfAborted();
            const parsed = new URL(target);
            if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Unsupported media URL.');
            const bytes = bytesOf(await fetchBytes(parsed.href, { signal }));
            downloadedBytes += bytes.length;
            requests += 1;
            if (downloadedBytes > maxBytes) throw new Error('Media download limit exceeded.');
            onProgress({ downloadedBytes, requests });
            return bytes;
        }
        async function playlist(target, depth = 0) {
            if (depth > 4) throw new Error('HLS playlist nesting limit exceeded.');
            const bytes = await read(target);
            const text = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 2 * 1024 * 1024)));
            if (!text.trimStart().startsWith('#EXTM3U')) return bytes;
            const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            const audioTrack = lines.filter(line => line.startsWith('#EXT-X-MEDIA:'))
                .map(line => attributes(line)).find(item => item.TYPE === 'AUDIO' && item.URI);
            if (audioTrack) return playlist(new URL(audioTrack.URI, target).href, depth + 1);
            const variants = [];
            lines.forEach((line, index) => {
                if (line.startsWith('#EXT-X-STREAM-INF:') && lines[index + 1] && !lines[index + 1].startsWith('#')) {
                    variants.push({ bandwidth: Number(attributes(line).BANDWIDTH) || Infinity, uri: lines[index + 1] });
                }
            });
            if (variants.length) return playlist(new URL(variants.sort((a, b) => a.bandwidth - b.bandwidth)[0].uri, target).href, depth + 1);
            if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('Live HLS cannot be analyzed for OP/ED.');
            if (lines.some(line => line.startsWith('#EXT-X-BYTERANGE:'))) throw new Error('HLS byte-range playlists are not supported.');
            const segmentCount = lines.filter(line => !line.startsWith('#')).length;
            if (!segmentCount || segmentCount > 1800) throw new Error('Unsupported HLS segment count.');
            const duration = lines.reduce((sum, line) => sum + (line.startsWith('#EXTINF:') ? Number(line.slice(8).split(',')[0]) : 0), 0);
            if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Unsupported HLS duration.');
            const windowSeconds = options.windowSeconds || 0;
            const windowed = windowSeconds > 0 && duration > windowSeconds * 2;
            let position = 0;
            let segmentDuration = 0;
            const windows = [];
            let activeWindow = null;
            let sequence = Number(lines.find(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1] || 0);
            let keyInfo = null;
            let init = null;
            let initUrl = '';
            const keys = new Map();
            const parts = [];
            let ts = null;
            for (const line of lines) {
                if (line.startsWith('#EXTINF:')) {
                    segmentDuration = Number(line.slice(8).split(',')[0]);
                    if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) throw new Error('Invalid HLS segment duration.');
                } else if (line.startsWith('#EXT-X-KEY:')) {
                    const info = attributes(line);
                    if (info.METHOD === 'NONE') keyInfo = null;
                    else if (info.METHOD === 'AES-128' && (!info.KEYFORMAT || info.KEYFORMAT === 'identity') && info.URI) keyInfo = info;
                    else throw new Error('Encrypted HLS format is unsupported.');
                } else if (line.startsWith('#EXT-X-MAP:')) {
                    const info = attributes(line);
                    if (!info.URI || info.BYTERANGE || keyInfo) throw new Error('Unsupported HLS initialization map.');
                    const nextUrl = new URL(info.URI, target).href;
                    if (initUrl && initUrl !== nextUrl) throw new Error('Changing HLS initialization maps are unsupported.');
                    if (!init) init = await read(nextUrl);
                    initUrl = nextUrl;
                } else if (!line.startsWith('#')) {
                    const selected = !windowed || position < windowSeconds || position + segmentDuration > duration - windowSeconds;
                    const start = position;
                    position += segmentDuration;
                    if (!selected) { activeWindow = null; sequence += 1; continue; }
                    if (windowed && !activeWindow) {
                        activeWindow = { start, parts: [] };
                        windows.push(activeWindow);
                    }
                    let segment = await read(new URL(line, target).href);
                    if (keyInfo) {
                        const keyUrl = new URL(keyInfo.URI, target).href;
                        if (!keys.has(keyUrl)) {
                            const rawKey = await read(keyUrl);
                            if (rawKey.length !== 16) throw new Error('Invalid HLS AES key.');
                            keys.set(keyUrl, await cryptoProvider.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['decrypt']));
                        }
                        const iv = new Uint8Array(16);
                        if (keyInfo.IV) {
                            const hex = keyInfo.IV.replace(/^0x/i, '').padStart(32, '0');
                            if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('Invalid HLS IV.');
                            for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
                        } else new DataView(iv.buffer).setBigUint64(8, BigInt(sequence));
                        segment = new Uint8Array(await cryptoProvider.subtle.decrypt({ name: 'AES-CBC', iv }, keys.get(keyUrl), segment));
                    }
                    ts ??= !init && segment[0] === 0x47;
                    const audio = ts ? aacFromTransportStream(segment) : segment;
                    if (windowed) activeWindow.parts.push(audio);
                    else parts.push(audio);
                    sequence += 1;
                }
            }
            if (windowed) return { duration, windows: windows.map(({ start, parts }) => ({
                start, bytes: join(init ? [init, ...parts] : parts),
            })) };
            return join(init ? [init, ...parts] : parts);
        }
        return playlist(url);
    }
    const api = { load, aacFromTransportStream, attributes };
    globalThis.SyncWatchMediaLoader = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
