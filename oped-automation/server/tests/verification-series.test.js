const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const identities = require('../identities');

test('site verification handles a whole series once, preserves old records, and distinguishes no match from unavailable audio', async () => {
    const id = number => `web:omofun.in:2026435987:1:${number}`;
    const episodes = Array.from({ length: 6 }, (_, i) => ({ id: id(i + 1), number: String(i + 1) }));
    const downloaded = [];
    let saved;
    const context = {
        console: { info() {}, error() {} }, Buffer, URL, AbortSignal, setTimeout, clearTimeout,
        module: { exports: {} }, downloaded,
        require(name) {
            if (name === './identities') return identities;
            if (name === './record-store') return {
                lookupRecords: async () => ({ [id(2)]: { duration: 1400, segments: [] } }),
                promoteVerified: async (metadata, records) => { saved = records; },
            };
            if (name === '../shared/streaming-sites') return { catalog: async () => ({seriesId:'web:omofun.in:2026435987:1', episodes}) };
            if (name === '../shared/media-loader' || name === './safe-fetch' || name === './decode-audio' || name === '../extension/audio-core.js') return {};
            return require(name);
        },
        SyncWatchOpedAudio: { detect: rows => ({ episodes: rows.map(row => ({ id:row.id, duration:1400,
            segments: row.id === id(4) ? [] : [{ type:'opening', start:40, end:130 }] })) }) },
    };
    const source = fs.readFileSync(path.join(__dirname, '../independent-verifier.js'), 'utf8');
    vm.runInNewContext(source + `
extract = async id => {
    downloaded.push(id);
    if (id.endsWith(':6')) throw new Error('Unavailable media');
    return {id, duration:1400, downloadedBytes:100};
};
queueVerification({seriesId:'web:omofun.in:2026435987:1',title:'Example'},
 [{id:'${id(1)}',number:'1',duration:1400,sourceDomain:'omofun.in',opening:{start:40,end:130},ending:null}], ['${id(1)}']);
globalThis.finished = pending;
`, context);
    await context.finished;
    assert.equal(downloaded.length, 6);
    assert.equal(new Set(downloaded).size, 6);
    assert.deepEqual(Array.from(saved, row => row.id).sort(), [id(1), id(3), id(4)].sort());
    const noMatch = saved.find(row => row.id === id(4));
    assert.equal(noMatch.opening, null);
    assert.equal(noMatch.ending, null);
    assert.equal(noMatch.sourceDomain, 'omofun.in');
    assert.equal(saved.some(row => [id(5), id(6)].includes(row.id)), false);
});
