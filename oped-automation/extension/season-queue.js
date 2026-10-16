/* Plan one serial batch without duplicating detection or treating null as missing. */
(() => {
    function nextBatch(episodeOrder, knownIds, failedIds = []) {
        const completed = new Set([...knownIds, ...failedIds]);
        const pending = episodeOrder.filter(id => !completed.has(id));
        if (!pending.length || episodeOrder.length < 3) return [];
        const selected = pending.slice(0, 3);

        // The detector needs three references even for the final one or two episodes.
        // Reuse completed episodes rather than retrying inaccessible episodes.
        const anchor = episodeOrder.indexOf(selected[0]);
        const references = episodeOrder
            .filter(id => !selected.includes(id) && !failedIds.includes(id))
            .sort((a, b) => Math.abs(episodeOrder.indexOf(a) - anchor) -
                Math.abs(episodeOrder.indexOf(b) - anchor));
        selected.push(...references.slice(0, 3 - selected.length));
        return selected.length === 3 ? selected : [];
    }

    globalThis.SyncWatchOpedQueue = { nextBatch };
})();
