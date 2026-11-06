const assert = require('node:assert/strict');
const test = require('node:test');
const sites = require('../shared/streaming-sites');

const age = 'https://www.agedm.io/play/20260203/1/2';
const omo = 'https://omofun.in/vod/play/2026435987/ep4.html';
const sakura = 'https://yhdm.one/vod-play/2026251887/ep5.html';

// These minimal fixtures retain the structures observed in the supplied playback pages.
function links(urls) {
    return '<h1>Example series</h1>' + urls.map(url => `<a href="${url}">Episode</a>`).join('');
}

test('episode identities preserve domain, series, playback line and episode', () => {
    for (const url of [age, omo, sakura]) {
        const identity = sites.identify(url);
        assert.equal(sites.episodeUrl(identity.episodeId), url);
        assert.equal(sites.validEpisodeId(identity.episodeId), true);
        assert.equal(sites.validSeriesId(identity.seriesId), true);
    }
    assert.notEqual(sites.identify(age).seriesId, sites.identify(age.replace('/1/2', '/2/2')).seriesId);
    assert.equal(sites.identify('https://attacker.example/play/20260203/1/2'), null);
    assert.equal(sites.validEpisodeId('web:127.0.0.1:10:1:2'), false);
});

test('AGE catalog includes only current playback line and domain', async () => {
    const html = links([1, 2, 3, 4].map(n => `/play/20260203/1/${n}`)) +
        links([1, 2, 3].map(n => `/play/20260203/2/${n}`)) +
        '<a href="https://agefans.tv/play/20260203/1/9">Other site</a>';
    const result = await sites.catalog(age, async () => html);
    assert.equal(result.episodes.length, 4);
    assert.equal(result.sourceDomain, 'www.agedm.io');
    assert.deepEqual(result.episodes.map(item => item.number), ['1', '2', '3', '4']);
});

test('OmoFun and Sakura resolve the page-specific public media endpoints', async () => {
    for (const url of [omo, sakura]) {
        const identity = sites.identify(url);
        const prefix = identity.provider === 'omofun' ? '/_dyn_plays/' : '/_get_plays/';
        const requests = [];
        const result = await sites.resolve(url, async target => {
            requests.push(target);
            if (target === url) return '<div id="player"></div>';
            assert.equal(new URL(target).pathname, `${prefix}${identity.seriesKey}/ep${identity.episode}`);
            return JSON.stringify({video_plays: [{play_data: 'https://media.example/video/index.m3u8', src_site: 'mdzy'}]});
        });
        assert.equal(result.mediaType, 'hls');
        assert.equal(result.audioUrl, 'https://media.example/video/index.m3u8');
        assert.equal(result.sourceDomain, identity.domain);
        assert.equal(requests.length, 2);
    }
});

test('static player iframe media works without executing remote JavaScript', async () => {
    const result = await sites.resolve(age, async url => url === age
        ? '<iframe src="https://player.example/player?id=123"></iframe>'
        : '<script>new Artplayer({url: "https:\\/\\/media.example\\/movie.mp4"});</script>');
    assert.equal(result.audioUrl, 'https://media.example/movie.mp4');
    assert.equal(result.mediaType, 'mp4');
});

test('encrypted AGE config never treats an advertising video as episode media', async () => {
    await assert.rejects(sites.resolve(age, async url => url === age
        ? '<iframe src="https://jx.wuzhoupai.com:8443/vip/?url=age_encrypted"></iframe>'
        : '<script>var Vurl="A017E80B5E5F4B15";var PlayConfig={"Url":Vurl,"Kpadmp4":"https://media.example/adposter.mp4"};</script>'), /encrypted/);
});

test('discover keeps selected episode IDs and attaches domain to cloud metadata', async () => {
    const html = links([3, 4, 5, 6].map(n => `/vod/play/2026435987/ep${n}.html`));
    const result = await sites.discover(omo, async url => url.includes('/_dyn_plays/')
        ? JSON.stringify({video_plays: [{play_data: 'https://media.example/index.m3u8'}]}) : html);
    assert.equal(result.metadata.sourceDomain, 'omofun.in');
    assert.deepEqual(result.episodes.map(item => item.number), ['3', '4', '5']);
});
