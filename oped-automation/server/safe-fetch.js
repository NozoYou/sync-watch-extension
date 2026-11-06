// Fetch only public HTTP(S) resources, pinning DNS results for every redirect.
const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function publicAddress(address) {
    if (net.isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
            !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
            !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0)) &&
            !(a === 198 && (b === 18 || b === 19 || b === 51)) && !(a === 203 && b === 0);
    }
    // Public IPv6 global unicast addresses begin with 2 or 3; reject mapped/tunnel ranges.
    if (net.isIP(address) === 6) {
        const lower = address.toLowerCase();
        const [first, second] = lower.split(':').map(part => parseInt(part || '0', 16));
        return /^[23]/.test(lower) && first !== 0x2002 &&
            !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
    }
    return false;
}

async function fetchBytes(input, { signal, maxBytes = 256 * 1024 * 1024, referer = '', redirects = 5 } = {}) {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (url.port && !['80', '443', '8443'].includes(url.port))) throw new Error('Unsupported resource URL.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Non-public resource address rejected.');
    const chosen = addresses[0];
    return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).get(url, {
            signal,
            lookup: (hostname, options, callback) => options.all
                ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity', ...(referer ? { Referer: referer } : {}) },
        }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.destroy();
                if (!redirects || !response.headers.location) return reject(new Error('Resource redirect limit reached.'));
                fetchBytes(new URL(response.headers.location, url).href, { signal, maxBytes, referer, redirects: redirects - 1 }).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.destroy();
                return reject(new Error(`Resource HTTP ${response.statusCode}`));
            }
            if (Number(response.headers['content-length']) > maxBytes) {
                response.destroy();
                return reject(new Error('Resource exceeds download limit.'));
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > maxBytes) {
                    response.destroy(new Error('Resource exceeds download limit.'));
                } else chunks.push(chunk);
            });
            response.on('end', () => {
                const bytes = Buffer.concat(chunks);
                bytes.finalUrl = url.href;
                resolve(bytes);
            });
            response.on('error', reject);
        });
        request.setTimeout(120000, () => request.destroy(new Error('Resource request timed out.')));
        request.on('error', reject);
    });
}

async function readPage(url) {
    const bytes = await fetchBytes(url, { maxBytes: 4 * 1024 * 1024, signal: AbortSignal.timeout(30000) });
    return { html: bytes.toString('utf8'), url: bytes.finalUrl || url }; 
}

module.exports = { publicAddress, fetchBytes, readPage };
