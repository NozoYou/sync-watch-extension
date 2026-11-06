const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const policy = fs.readFileSync(path.join(__dirname, '../controller/player/streaming-ad-policy.js'), 'utf8');
const guard = fs.readFileSync(path.join(__dirname, '../controller/player/popup-guard.js'), 'utf8');
function page(host, ancestorOrigins = []) {
    const handlers = new Map();
    const calls = [];
    class Element {
        constructor(href, player = false, className = '') {
            this.href = href; this.player = player; this.className = className;
            this.tagName = href ? 'A' : 'DIV'; this.id = '';
        }
        matches(selector) { return selector.includes('video,') && this.player; }
        hasAttribute(name) { return name === 'href' && Boolean(this.href); }
        getAttribute(name) { return name === 'class' ? this.className : ''; }
    }
    const scope = { URL, Element, performance: {now: () => 10}, document: {referrer: ''},
        location: {hostname: host, origin: `https://${host}`, href: `https://${host}/play/1`, ancestorOrigins},
        addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
        postMessage() {}, open(...args) { calls.push(args); return 'opened'; } };
    scope.window = scope;
    const context = vm.createContext(scope);
    vm.runInContext(policy + '\n' + guard, context);
    return { scope, context, calls, Element, send(type, event) { for (const fn of handlers.get(type) || []) fn(event); } };
}
function click(p, nodes, trusted = true) {
    const event = {isTrusted: trusted, composedPath: () => nodes, prevented: false,
        preventDefault() {this.prevented = true;}, stopImmediatePropagation() {this.stopped = true;} };
    p.send('click', event);
    return event;
}
for (const host of ['omofun.in', 'yhdm.one', 'www.agedm.io']) {
    const p = page(host);
    assert.equal(p.scope.open('https://advert.example/'), null);
    assert.equal(p.calls.length, 0);
    assert.equal(click(p, [new p.Element('https://advert.example/')], false).prevented, true);
    const next = `https://${host}/next-episode`;
    assert.equal(click(p, [new p.Element(next)]).prevented, false);
    assert.equal(p.scope.open(next), 'opened');
    assert.equal(p.scope.open('https://advert.example/'), null);
    const explicit = 'https://reference.example/help';
    click(p, [new p.Element(explicit)]);
    assert.equal(p.scope.open(explicit), 'opened');
    assert.equal(click(p, [new p.Element('https://advert.example/'), new p.Element(null, true)]).prevented, true);
    assert.equal(click(p, [new p.Element(next, false, 'popup-ad')]).prevented, true);
    p.send('message', vm.runInContext("({source: window, data: {type: 'SYNC_WATCH_AD_GUARD_SETTINGS', enabled: false}})", p.context));
    assert.equal(p.scope.open('https://advert.example/'), 'opened');
}
const frame = page('player.example', ['https://omofun.in']);
assert.equal(frame.scope.open('https://advert.example/'), null);
const normal = page('example.com');
assert.equal(normal.scope.open('https://reference.example/'), 'opened');
console.log('PASS: streaming popup policy, explicit navigation, player ad links, iframe scope and settings toggle');
