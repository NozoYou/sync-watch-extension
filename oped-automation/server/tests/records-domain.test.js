const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { viewingUrl, validEpisode, validSeries } = require('../identities');

test('domain-scoped identities keep sites and playback lines separate', () => {
    for (const id of ['web:omofun.in:2026435987:1:4', 'web:yhdm.one:2026251887:1:5',
        'web:agedm.io:20260203:1:2', '2214939', 'ugc:BV1gk7L6rExZ:p1']) assert.equal(validEpisode(id), true, id);
    assert.equal(viewingUrl('web:omofun.in:2026435987:1:4'), 'https://omofun.in/vod/play/2026435987/ep4.html');
    assert.equal(validEpisode('web:127.0.0.1:2026435987:1:4'), false);
    assert.equal(validSeries('web:omofun.in:2026435987:1'), true);
    assert.equal(validEpisode('web:omofun.in:2026435987:2:4'), false);
});

test('new records persist a canonical domain, reject mixed sites, and first report needs verification', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oped-records-test-'));
    process.env.OPED_RECORD_FILE = path.join(directory, 'records.json');
    process.env.OPED_REPORT_FILE = path.join(directory, 'reports.json');
    delete require.cache[require.resolve('../record-store')];
    const store = require('../record-store');
    const ids = [1, 2, 3].map(number => `web:omofun.in:2026435987:1:${number}`);
    const metadata = { seriesId: 'web:omofun.in:2026435987:1', title: 'Example', sourceDomain: 'omofun.in', episodes: ids.map((id, i) => ({ id, number: i + 1 })) };
    const result = { episodes: ids.map(id => ({ id, duration: 1440, segments: [{ type: 'opening', start: 30, end: 120 }] })) };
    try {
        const first = await store.saveReport(metadata, result, 'source-1');
        assert.deepEqual(first.eligible, ids);
        await store.saveRecords(metadata, result);
        const document = JSON.parse(await fs.readFile(process.env.OPED_RECORD_FILE, 'utf8'));
        assert.equal(document.series[0].sourceDomain, 'omofun.in');
        assert.equal(document.series[0].groups[0].episodes[0].sourceDomain, 'omofun.in');
        assert.equal((await store.lookupRecords([ids[0]]))[ids[0]].sourceDomain, 'omofun.in');
        assert.equal((await store.saveReport(metadata, result, 'source-2')).eligible.length, 0);
        assert.equal((await store.saveReport(metadata, result, 'source-2')).eligible.length, 0);
        assert.equal((await store.saveReport(metadata, result, 'source-3')).eligible.length, 0);
        assert.equal((await store.saveReport(metadata, result, 'source-4')).eligible.length, 0);
        assert.deepEqual((await store.saveReport(metadata, result, 'source-5')).eligible, ids);
        assert.throws(() => store.saveRecords({ ...metadata, sourceDomain: 'yhdm.one' }, result), /source/);
        const other = result.episodes.map(item => ({...item, id: item.id.replace('omofun.in', 'yhdm.one')}));
        assert.throws(() => store.saveRecords(metadata, {episodes:other}), /identity/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
        delete process.env.OPED_RECORD_FILE;
        delete process.env.OPED_REPORT_FILE;
    }
});
