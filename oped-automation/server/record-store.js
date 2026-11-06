// Persist readable episode records and group identical OP/ED boundaries.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const recordFile = process.env.OPED_RECORD_FILE
    ? path.resolve(process.env.OPED_RECORD_FILE)
    : path.join(__dirname, 'data', 'oped-records.json');
const reportFile = process.env.OPED_REPORT_FILE
    ? path.resolve(process.env.OPED_REPORT_FILE)
    : path.join(__dirname, 'data', 'oped-reports.json');
let writes = Promise.resolve();
let reportWrites = Promise.resolve();
const { viewingUrl, validEpisode, validSeries, sourceDomain } = require('./identities');
const sites = require('../shared/streaming-sites');

function validateRecords(metadata, result) {
    if (!metadata || !validSeries(metadata.seriesId) ||
        typeof metadata.title !== 'string' || !metadata.title.trim() ||
        metadata.title.length > 300 || !Array.isArray(metadata.episodes)) {
        throw new Error('Missing series metadata.');
    }
    if (!Array.isArray(result?.episodes) || result.episodes.length !== 3 ||
        metadata.episodes.length !== 3) throw new Error('Three episode records required.');
    const seen = new Set();
    return result.episodes.map(episode => {
        const source = metadata.episodes.find(item => item.id === episode.id);
        if (!source || !validEpisode(episode.id) || seen.has(episode.id)) {
            throw new Error('Invalid episode identity.');
        }
        const domain = sourceDomain(episode.id);
        if ((metadata.sourceDomain && metadata.sourceDomain !== domain) ||
            (episode.id.startsWith('web:') && sites.identify(viewingUrl(episode.id)).seriesId !== metadata.seriesId) ||
            (metadata.seriesId.startsWith('web:') !== episode.id.startsWith('web:'))) {
            throw new Error('Episode source does not match series.');
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
            sourceDomain: domain,
            number: String(source.number).slice(0, 30),
            // Store the canonical viewing URL, never a signed CDN audio URL.
            url: viewingUrl(episode.id),
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
    series.sourceDomain = sourceDomain(episodes[0].id);
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

async function lookupRecords(ids) {
    await writes;
    let document;
    try {
        document = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
    if (document.schemaVersion !== 1 || !Array.isArray(document.series)) {
        throw new Error('Unsupported records format.');
    }
    const wanted = new Set(ids);
    const found = {};
    for (const series of document.series) {
        for (const group of series.groups || []) {
            for (const episode of group.episodes || []) {
                if (!wanted.has(episode.id)) continue;
                found[episode.id] = {
                    sourceDomain: episode.sourceDomain || series.sourceDomain || sourceDomain(episode.id),
                    duration: episode.duration,
                    segments: ['opening', 'ending'].flatMap(type =>
                        group[type] ? [{ type, ...group[type] }] : []),
                };
            }
        }
    }
    return found;
}

function saveReport(metadata, result, reporter) {
    const episodes = validateRecords(metadata, result);
    const pending = reportWrites.then(async () => {
        let document = { schemaVersion: 1, reports: [] };
        try {
            document = JSON.parse(await fs.readFile(reportFile, 'utf8'));
            if (document.schemaVersion !== 1 || !Array.isArray(document.reports)) {
                throw new Error('Unsupported report format.');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        document.reports.push({
            id: crypto.randomUUID(), seriesId: metadata.seriesId,
            sourceDomain: sourceDomain(episodes[0].id),
            title: metadata.title.trim(), submittedAt: new Date().toISOString(), reporter, episodes,
        });
        document.reports = document.reports.slice(-1000);
        await fs.mkdir(path.dirname(reportFile), { recursive: true, mode: 0o700 });
        const temporary = `${reportFile}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
            await fs.rename(temporary, reportFile);
        } finally {
            await fs.rm(temporary, { force: true });
        }
        const existing = await lookupRecords(episodes.map(item => item.id));
        const eligible = [];
        const recent = document.reports.filter(item =>
            item.seriesId === metadata.seriesId &&
            Date.now() - Date.parse(item.submittedAt) < 180 * 86400000);
        for (const episode of episodes) {
            if (!existing[episode.id]) {
                eligible.push(episode.id);
                continue;
            }
            if (!episode.opening && !episode.ending) continue;
            const signature = JSON.stringify(['opening', 'ending'].map(type =>
                episode[type] ? [Math.round(episode[type].start), Math.round(episode[type].end)] : null));
            const reporters = new Set();
            for (const report of recent) {
                const candidate = report.episodes.find(item => item.id === episode.id);
                if (!candidate || !report.reporter) continue;
                const candidateSignature = JSON.stringify(['opening', 'ending'].map(type =>
                    candidate[type] ? [Math.round(candidate[type].start), Math.round(candidate[type].end)] : null));
                if (candidateSignature === signature) reporters.add(report.reporter);
            }
            if (reporters.size < 5) continue;
            eligible.push(episode.id);
        }
        return {
            reportStatus: eligible.length ? 'pending_verification' : 'pending_quorum',
            eligible,
            episodes,
        };
    });
    reportWrites = pending.catch(() => {});
    return pending;
}

function promoteVerified(metadata, episodes) {
    const pending = writes.then(() => writeRecords(metadata, episodes));
    writes = pending.catch(() => {});
    return pending;
}

module.exports = { saveRecords, lookupRecords, saveReport, promoteVerified };
