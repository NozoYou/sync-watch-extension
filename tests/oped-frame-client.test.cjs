const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sites = require('../oped-automation/shared/streaming-sites');

test('embedded player reads its top episode and discards the previous episode on navigation', async () => {
    let pageUrl = 'https://omofun.in/vod/play/2026435987/ep4.html';
    let poll;
    const frameUrl = 'https://player.example/embed/1';
    const context = { URL, Date, Set, console, location:{href:frameUrl}, setInterval(fn){ poll=fn; return 1; },clearInterval(){},
        chrome:{ runtime:{async sendMessage(message){
            if(message.type==='OPED_PAGE_CONTEXT') return {pageUrl};
            const ep=sites.identify(message.pageUrl);
            return {pageUrl:message.pageUrl,episodeId:ep.episodeId,enabled:true,segments:[{type:'opening',start:30,end:Number(ep.episode)*30}]};
        }}, storage:{local:{async get(){return {opedSettings:{enabled:true}};}},onChanged:{addListener(){}}}},
    };
    context.window={top:{},SyncWatchStreamingSites:sites};
    vm.runInNewContext(fs.readFileSync(require.resolve('../oped-automation/extension/client.js'),'utf8'),context);
    const settle = async()=>{for(let i=0;i<5;i++) await new Promise(resolve=>setImmediate(resolve));};
    await settle();
    assert.equal(context.window.SyncWatchOpedClient.enabled,true);
    assert.equal(context.window.SyncWatchOpedClient.pageUrl,frameUrl);
    assert.equal(context.window.SyncWatchOpedClient.segments[0].end,120);
    pageUrl='https://omofun.in/vod/play/2026435987/ep5.html';
    poll(); await settle();
    assert.equal(context.window.SyncWatchOpedClient.segments[0].end,150);
    assert.equal(context.window.SyncWatchOpedClient.sourcePageUrl,pageUrl);
});
