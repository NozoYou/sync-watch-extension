const test = require('node:test');
const assert = require('node:assert/strict');
const { publicAddress, fetchBytes } = require('../safe-fetch');

test('public media fetching rejects private, mapped, multicast and documentation IPs', () => {
    for (const address of [
        '127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.0.1',
        '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '::1',
        '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1',
        '2001:0db8::1', '2001:0000::1', '2002:7f00:1::',
    ]) assert.equal(publicAddress(address), false, address);
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '2001:4860:4860::8888']) {
        assert.equal(publicAddress(address), true, address);
    }
});

test('unsafe resource URLs fail before opening a connection', async () => {
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1/', 'http://[::1]/',
        'https://user:password@example.com/', 'http://example.com:22/']) {
        await assert.rejects(fetchBytes(url));
    }
});
