// Keep old Bilibili IDs readable while separating other sites by their domain.
const sites = require('../shared/streaming-sites');
const biliEpisode = /^(?:\d{1,20}|ugc:BV[0-9A-Za-z]{10}:p[1-9]\d{0,3})$/;
const biliSeries = /^(?:\d{1,20}|ugc:(?:multi:BV[0-9A-Za-z]{10}|season:\d{1,20}))$/;

function viewingUrl(id) {
    if (typeof id !== 'string') throw new Error('Invalid episode identity.');
    if (/^\d{1,20}$/.test(id)) return `https://www.bilibili.com/bangumi/play/ep${id}`;
    const match = id.match(/^ugc:(BV[0-9A-Za-z]{10}):p([1-9]\d{0,3})$/);
    if (match) return `https://www.bilibili.com/video/${match[1]}/${match[2] === '1' ? '' : `?p=${match[2]}`}`;
    const url = sites.episodeUrl(id);
    if (!url || sites.identify(url)?.episodeId !== id) throw new Error('Invalid episode identity.');
    return url;
}

function validEpisode(id) {
    if (typeof id !== 'string') return false;
    if (biliEpisode.test(id)) return true;
    try { return sites.identify(viewingUrl(id))?.episodeId === id; } catch { return false; }
}

function validSeries(id) {
    if (typeof id !== 'string') return false;
    if (biliSeries.test(id)) return true;
    try { return sites.identify(viewingUrl(`${id}:1`))?.seriesId === id; } catch { return false; }
}

function sourceDomain(id) { return new URL(viewingUrl(id)).hostname; }

module.exports = { viewingUrl, validEpisode, validSeries, sourceDomain };
