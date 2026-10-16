// Persist readable episode records and group identical OP/ED boundaries.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const recordFile = process.env.OPED_RECORD_FILE
    ? path.resolve(process.env.OPED_RECORD_FILE)
    : path.join(__dirname, 'data', 'oped-records.json');
let writes = Promise.resolve();

function validateRecords(metadata, result) {
    if (!metadata || !/^\d{1,20}$/.test(metadata.seriesId) ||
        typeof metadata.title !== 'string' || !metadata.title.trim() ||
        metadata.title.length > 300 || !Array.isArray(metadata.episodes)) {
        throw new Error('Missing series metadata.');
    }
    if (!Array.isArray(result?.episodes) || result.episodes.length !== 3 ||
        metadata.episodes.length !== 3) throw new Error('Three episode records required.');
    const seen = new Set();
    return result.episodes.map(episode => {
        const source = metadata.episodes.find(item => item.id === episode.id);
        if (!source || !/^\d{1,20}$/.test(episode.id) || seen.has(episode.id)) {
            throw new Error('Invalid episode identity.');
        }
        seen.add(episode.id);
        if (!Number.isFinite(episode.duration) || episode.duration <= 0 || episode.duration > 3600 ||
            !Array.isArray(episode.segments) || episode.segments.length > 2) {
            throw new Error('Invalid episode result.');
        }
        const times = { opening: null, ending: null };
        for (const segment of episode.segments) {
            if (!['opening', 'ending'].includes(segment.type) || times[segment.type] !== null ||
                !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
                segment.start < 0 || segment.end <= segment.start || segment.end > episode.duration) {
                throw new Error('Invalid segment boundaries.');
            }
            times[segment.type] = { start: segment.start, end: segment.end };
        }
        return {
            id: episode.id,
            number: String(source.number).slice(0, 30),
            // Store the canonical viewing URL, never a signed CDN audio URL.
            url: `https://www.bilibili.com/bangumi/play/ep${episode.id}`,
            duration: episode.duration,
            updatedAt: new Date().toISOString(),
            ...times,
        };
    });
}

async function writeRecords(metadata, episodes) {
    let document = { schemaVersion: 1, series: [] };
    try {
        document = JSON.parse(await fs.readFile(recordFile, 'utf8'));
        if (document.schemaVersion !== 1 || !Array.isArray(document.series)) {
            throw new Error('Unsupported records format.');
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    let series = document.series.find(item => item.id === metadata.seriesId);
    if (!series) {
        series = { id: metadata.seriesId, title: metadata.title.trim(), groups: [] };
        document.series.push(series);
    }
    series.title = metadata.title.trim();
    const allEpisodes = new Map();
    for (const group of series.groups) {
        for (const episode of group.episodes) {
            allEpisodes.set(episode.id, { ...episode, opening: group.opening, ending: group.ending });
        }
    }
    // A new detection replaces only the episodes it actually analyzed.
    for (const episode of episodes) allEpisodes.set(episode.id, episode);
    const groups = new Map();
    for (const episode of allEpisodes.values()) {
        const { opening, ending, ...details } = episode;
        const key = JSON.stringify([opening, ending]);
        if (!groups.has(key)) groups.set(key, { opening, ending, episodes: [] });
        groups.get(key).episodes.push(details);
    }
    series.groups = [...groups.values()];
    for (const group of series.groups) {
        group.episodes.sort((a, b) => Number(a.number) - Number(b.number));
    }
    await fs.mkdir(path.dirname(recordFile), { recursive: true, mode: 0o700 });
    const temporary = `${recordFile}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
        await fs.rename(temporary, recordFile);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

function saveRecords(metadata, result) {
    const episodes = validateRecords(metadata, result);
    const pending = writes.then(() => writeRecords(metadata, episodes));
    // Serialize writes without letting a failed write block future requests.
    writes = pending.catch(() => {});
    return pending;
}

module.exports = { saveRecords };
