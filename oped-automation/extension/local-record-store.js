/* Durable JSON records in the extension's private filesystem on this computer. */
(() => {
    const fileName = 'oped-records.json';
    let writes = Promise.resolve();

    async function readDocument() {
        const root = await navigator.storage.getDirectory();
        try {
            const handle = await root.getFileHandle(fileName);
            const document = JSON.parse(await (await handle.getFile()).text());
            if (document.schemaVersion !== 1 || !Array.isArray(document.series)) {
                throw new Error('Unsupported local OP/ED record format.');
            }
            return document;
        } catch (error) {
            if (error.name !== 'NotFoundError') throw error;
            return { schemaVersion: 1, series: [] };
        }
    }

    async function getEpisode(id) {
        await writes;
        const document = await readDocument();
        for (const series of document.series) {
            const episode = series.episodes.find(item => item.id === id);
            if (!episode) continue;
            const segments = ['opening', 'ending'].flatMap(type =>
                episode[type] ? [{ type, ...episode[type] }] : []);
            // A durable record remains usable after the short-lived cache expires.
            return { segments, savedAt: Date.now() };
        }
        return null;
    }

    async function knownEpisodes(seriesId) {
        await writes;
        const document = await readDocument();
        const series = document.series.find(item => item.id === seriesId);
        return (series?.episodes || []).map(item => item.id);
    }

    function save(metadata, result, preserveExisting = false) {
        const pending = writes.then(async () => {
            const document = await readDocument();
            let series = document.series.find(item => item.id === metadata.seriesId);
            if (!series) {
                series = { id: metadata.seriesId, title: metadata.title, episodes: [] };
                document.series.push(series);
            }
            series.title = metadata.title;
            for (const episode of result.episodes) {
                const source = metadata.episodes.find(item => item.id === episode.id);
                if (!source) continue;
                if (preserveExisting && series.episodes.some(item => item.id === episode.id)) continue;
                const record = {
                    id: episode.id,
                    number: String(source.number),
                    url: `https://www.bilibili.com/bangumi/play/ep${episode.id}`,
                    duration: episode.duration ?? null,
                    updatedAt: new Date().toISOString(),
                    opening: null,
                    ending: null,
                };
                for (const segment of episode.segments || []) {
                    if (!['opening', 'ending'].includes(segment.type)) continue;
                    record[segment.type] = { start: segment.start, end: segment.end };
                }
                const index = series.episodes.findIndex(item => item.id === record.id);
                if (index < 0) series.episodes.push(record);
                else series.episodes[index] = record;
            }
            series.episodes.sort((a, b) => Number(a.number) - Number(b.number));

            const root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle(fileName, { create: true });
            const writer = await handle.createWritable();
            try {
                await writer.write(JSON.stringify(document, null, 2) + '\n');
                await writer.close();
            } catch (error) {
                await writer.abort().catch(() => {});
                throw error;
            }
        });
        writes = pending.catch(() => {});
        return pending;
    }

    globalThis.SyncWatchOpedRecords = { getEpisode, knownEpisodes, save };
})();
