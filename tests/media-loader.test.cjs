const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { load } = require('../oped-automation/shared/media-loader');
const text = value => new TextEncoder().encode(value);
function fixture(files) {
    const fetched = [];
    return { fetched, fetchBytes: async url => {
        fetched.push(url);
        assert.ok(files[url], `Unexpected media request ${url}`);
        return typeof files[url] === 'string' ? text(files[url]) : files[url];
    } };
}
test('HLS selects separate audio and resolves relative init and segments', async () => {
    const f = fixture({
        'https://media.example/master.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=999999,AUDIO="a"\nvideo.m3u8',
        'https://media.example/audio/list.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\none.m4s\n#EXTINF:5,\ntwo.m4s\n#EXT-X-ENDLIST',
        'https://media.example/audio/init.mp4': new Uint8Array([1, 2]),
        'https://media.example/audio/one.m4s': new Uint8Array([3, 4]),
        'https://media.example/audio/two.m4s': new Uint8Array([5, 6]),
    });
    assert.deepEqual([...await load('https://media.example/master.m3u8', f)], [1,2,3,4,5,6]);
    assert.equal(f.fetched.some(url => url.endsWith('video.m3u8')), false);
});
test('HLS rejects live streams and unsupported DRM before fetching segments', async () => {
    for (const body of ['#EXTM3U\n#EXTINF:5,\none.ts', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:5,\none.ts\n#EXT-X-ENDLIST']) {
        const f = fixture({ 'https://media.example/list.m3u8': body });
        await assert.rejects(load('https://media.example/list.m3u8', f));
        assert.equal(f.fetched.length, 1);
    }
});
test('HLS decrypts AES-128 with media sequence IV', async () => {
    const keyBytes = new Uint8Array(16).fill(7);
    const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
    const iv = new Uint8Array(16); new DataView(iv.buffer).setBigUint64(8, 9n);
    const plain = new Uint8Array([0,0,0,8,102,116,121,112]);
    const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain));
    const f = fixture({
        'https://media.example/list.m3u8': '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:5,\none.m4s\n#EXT-X-ENDLIST',
        'https://media.example/key': keyBytes,
        'https://media.example/one.m4s': encrypted,
    });
    assert.deepEqual(await load('https://media.example/list.m3u8', { ...f, crypto: webcrypto }), plain);
});
test('HLS keeps AAC audio from TS and discards video PES', async () => {
    function packet(streamId, pid, payload) {
        const pes = new Uint8Array([0,0,1,streamId,0,payload.length+3,0x80,0,0,...payload]);
        const out = new Uint8Array(188).fill(255);
        out.set([0x47,0x40 | (pid >> 8),pid & 255,0x30,183-pes.length],0);
        out.set(pes,188-pes.length);
        return out;
    }
    const aac = [0xff,0xf1,0x50,0x80,0x01,0x3f,0xfc,1,2];
    const ts = new Uint8Array(376);
    ts.set(packet(0xe0,256,[9,9,9])); ts.set(packet(0xc0,257,aac),188);
    const f = fixture({
        'https://media.example/list.m3u8': '#EXTM3U\n#EXTINF:5,\none.ts\n#EXT-X-ENDLIST',
        'https://media.example/one.ts': ts,
    });
    assert.deepEqual([...await load('https://media.example/list.m3u8', f)], aac);
});
test('download budget counts playlist and media together', async () => {
    const f = fixture({ 'https://media.example/a.mp4': new Uint8Array(100) });
    await assert.rejects(load('https://media.example/a.mp4', { ...f, maxBytes: 99 }), /limit/);
});
test('matching windows skip middle HLS segments and retain original timestamps', async () => {
    const files = { 'https://media.example/list.m3u8': '#EXTM3U\n' + Array.from({length:10}, (_,i)=>`#EXTINF:100,\ns${i}.m4s`).join('\n') + '\n#EXT-X-ENDLIST' };
    for (let i=0;i<10;i++) files[`https://media.example/s${i}.m4s`] = new Uint8Array([i+1]);
    const f = fixture(files);
    const result = await load('https://media.example/list.m3u8', { ...f, windowSeconds:302 });
    assert.equal(result.duration,1000);
    assert.deepEqual(result.windows.map(item=>item.start),[0,600]);
    assert.deepEqual([...result.windows[0].bytes],[1,2,3,4]);
    assert.deepEqual([...result.windows[1].bytes],[7,8,9,10]);
    assert.equal(f.fetched.some(url=>/s[45]\.m4s/.test(url)),false);
});
