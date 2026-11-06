// The cloud service verifies replacement reports with independently fetched audio.
const http = require('node:http');
const crypto = require('node:crypto');
const { saveRecords, lookupRecords, saveReport } = require('./record-store');
const { queueVerification } = require('./independent-verifier');
require('../extension/audio-core.js');

const token = process.env.OPED_TOKEN;
if (!token || token.length < 24) {
    throw new Error('Set OPED_TOKEN to a secret containing at least 24 characters.');
}
const port = Number(process.env.OPED_PORT || 8788);
const host = process.env.OPED_HOST || '127.0.0.1';
const expected = Buffer.from(`Bearer ${token}`);
let busy = false;
const reportsByAddress = new Map();
const { validEpisode } = require('./identities');

function authorized(request) {
    const supplied = Buffer.from(request.headers.authorization || '');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function respond(response, code, body) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
}

function validate(body) {
    if (!Array.isArray(body.episodes) || body.episodes.length !== 3) throw new Error('Three episodes required.');
    const identifiers = new Set();
    for (const episode of body.episodes) {
        if (typeof episode.id !== 'string' || !validEpisode(episode.id) || identifiers.has(episode.id)) throw new Error('Invalid episode identity.');
        identifiers.add(episode.id);
        if (!Number.isFinite(episode.duration) || episode.duration < 2 || episode.duration > 3600) throw new Error('Invalid duration.');
        if (!Array.isArray(episode.features) || !Array.isArray(episode.energies)) throw new Error('Missing fingerprints.');
        const count = Math.floor(episode.duration - 2) + 1;
        if (Math.abs(episode.features.length - count) > 1 || episode.features.length > 3600 || episode.energies.length !== episode.features.length) throw new Error('Invalid frame count.');
        for (const frame of episode.features) {
            if (!Array.isArray(frame) || frame.length !== 32 || !frame.every(value => Number.isFinite(value) && Math.abs(value) <= 1.01)) throw new Error('Invalid feature vector.');
        }
        if (!episode.energies.every(value => Number.isFinite(value) && value >= 0 && value <= 2)) throw new Error('Invalid energy vector.');
    }
    return body.episodes;
}

const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/records/lookup?')) {
        try {
            const ids = new URL(request.url, 'http://localhost').searchParams.getAll('id');
            if (!ids.length || ids.length > 100 || ids.some(id => !validEpisode(id))) {
                return respond(response, 400, { error: 'Invalid episode identities.' });
            }
            return respond(response, 200, { records: await lookupRecords(ids) });
        } catch {
            return respond(response, 500, { error: 'Record lookup failed.' });
        }
    }
    if (request.method !== 'POST' || !['/detect', '/records', '/reports'].includes(request.url)) return respond(response, 404, { error: 'Not found.' });
    if (request.url !== '/reports' && !authorized(request)) return respond(response, 401, { error: 'Unauthorized.' });
    let address;
    if (request.url === '/reports') {
        const now = Date.now();
        const proxyAddress = request.headers['x-real-ip'];
        const direct = request.socket.remoteAddress || 'unknown';
        address = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(direct) &&
            typeof proxyAddress === 'string' && /^(?:[0-9a-fA-F:.]+)$/.test(proxyAddress)
            ? proxyAddress : direct;
        const recent = (reportsByAddress.get(address) || []).filter(at => now - at < 3600000);
        if (recent.length >= 200) return respond(response, 429, { error: 'Report limit reached.' });
        recent.push(now);
        reportsByAddress.set(address, recent);
        if (reportsByAddress.size > 1000) {
            for (const [key, timestamps] of reportsByAddress) {
                if (timestamps[timestamps.length - 1] < now - 3600000) reportsByAddress.delete(key);
            }
        }
    } else {
        if (busy) return respond(response, 429, { error: 'A detection task is already running.' });
        busy = true;
    }
    try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 12 * 1024 * 1024) {
                respond(response, 413, { error: 'Request too large.' });
                return;
            }
            chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (request.url === '/reports') {
            const reporter = crypto.createHmac('sha256', token).update(address).digest('hex');
            const result = await saveReport(body.metadata, body.result, reporter);
            console.info('OP/ED report stored', {
                seriesId: body.metadata.seriesId,
                episodeIds: result.episodes.map(item => item.id),
                status: result.reportStatus,
                eligibleIds: result.eligible,
            });
            if (result.eligible.length) {
                queueVerification(body.metadata, result.episodes, result.eligible);
            }
            return respond(response, 202, { reportStatus: result.reportStatus });
        }
        if (request.url === '/records') {
            await saveRecords(body.metadata, body.result);
            return respond(response, 200, { recordStatus: 'saved' });
        }
        const episodes = validate(body);
        const result = globalThis.SyncWatchOpedAudio.detect(episodes);
        let recordStatus = 'missing_metadata';
        if (body.metadata) {
            try {
                await saveRecords(body.metadata, result);
                recordStatus = 'saved';
            } catch {
                // Record storage failures must not change detection or skipping.
                recordStatus = 'failed';
                console.error('OP/ED record storage failed. Check directory permissions and disk space.');
            }
        }
        respond(response, 200, { ...result, recordStatus });
    } catch (error) {
        console.error('OP/ED request failed', { route: request.url, error: error.message });
        if (!response.headersSent) respond(response, 400, { error: 'Invalid fingerprint data.' });
    } finally {
        if (request.url !== '/reports') busy = false;
    }
});
server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.listen(port, host, () => console.log(`OP/ED fingerprint service listening on ${host}:${port}`));
