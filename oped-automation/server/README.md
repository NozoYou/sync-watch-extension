# 云端音频特征比对服务

此服务与一起看的房间服务器独立，使用 Node.js 18 或更新版本。常规识别无 npm 依赖；重新识别上报达到自动核验门槛时，服务器需要安装 `ffmpeg`，自行解析 B 站、AGE、OmoFun、樱花的公开播放源并提取音频。B 站优先独立音轨，其他网站 HLS 仅下载首尾匹配分段；AGE 加密线路暂不支持。它接收音频特征或本地检测的最终结果，不接收用户 Cookie 或视频流。

上传时需要保留相对目录：

```text
oped-automation/
  server/server.js
  server/record-store.js
  server/independent-verifier.js
  extension/audio-core.js
```

## 启动

设置至少 24 字符的随机密钥（扩展中填写同一个密钥），然后启动：

```sh
export OPED_TOKEN='替换为你自己的至少24字符随机密钥'
node oped-automation/server/server.js
```

默认监听 `127.0.0.1:8788`。`OPED_HOST`、`OPED_PORT` 可修改监听位置；现有房间服务器仍使用原来的端口。这个命令在前台运行，长期部署可由 systemd 托管。

云端使用已有 HTTPS 反向代理转发到本机端口。Nginx 对应站点的代理区块可写为：

```nginx
location ~ ^/(detect|records|records/lookup|reports)$ {
    client_max_body_size 12m;
    proxy_read_timeout 180s;
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Real-IP $remote_addr;
}
```

域名和 HTTPS 证书需在服务器上配置。在扩展的“OP/ED 音频识别”中选择“云端服务器”，填写 `https://你的检测域名` 和密钥。若本机运行此服务，可填写 `http://127.0.0.1:8788`。

## 接口

`POST /detect`，请求头 `Authorization: Bearer <密钥>`。请求为三集的 `id`、`duration`、`features`（每秒一个 32 维频谱特征）和 `energies`。

`GET /records/lookup?id=<剧集ID>` 可重复传入 `id`，一次最多查询 100 个；返回 `{ "records": { "剧集ID": { "duration": 1440, "segments": [] } } }`。已检测但没有匹配片段的集返回空 `segments`；未保存过的集不出现在 `records` 中。此只读接口不要求密钥，代理公开后任何知道视频 ID 的客户端都能读取时间点。写入和检测仍需要密钥。

返回 `episodes`，每项包含 `id`、`duration` 和 `segments`。每个片段含 `type`、`start`、`end`；未匹配的片头/片尾不会出现在列表中。没有匹配的集返回空列表。浏览器和云端共用 `audio-core.js`，使用相同算法。

服务一次处理一个任务；繁忙时返回 429。新增普通视频合集支持后，需同步更新服务器上的 `server.js` 和 `record-store.js` 并重启检测服务。

## 云端记录文件

新检测结果自动写入服务器上的 `oped-automation/server/data/oped-records.json`。设置 `OPED_RECORD_FILE` 可指定其他绝对路径，服务运行用户需要有对应目录的写权限。

每个系列保存名称和系列 ID，各集保存集数、观看页面链接、时长及更新时间。B 站合集使用 `ugc:season:<合集 ID>`，多 P 视频使用 `ugc:multi:<BV 号>`；每集使用对应的 BV 号和 P 号标识。`opening`、`ending` 使用秒为单位的 `start` / `end`，没有匹配时为 `null`。只记录已完成检测的结果；下载失败等任务错误不会伪装成“未识别到”。

同一番剧内 OP 和 ED 时间均相同的剧集合并进同一个 `groups` 项，时间只存一次，各集的链接分别保留。例如以下为格式示意，不是实测结果：

```json
{
  "schemaVersion": 1,
  "series": [{
    "id": "963",
    "title": "示例番剧",
    "groups": [{
      "opening": { "start": 90, "end": 175 },
      "ending": null,
      "episodes": [
        { "id": "1001", "number": "1", "url": "https://www.bilibili.com/bangumi/play/ep1001", "duration": 1440, "updatedAt": "2026-10-16T00:00:00.000Z" },
        { "id": "1002", "number": "2", "url": "https://www.bilibili.com/bangumi/play/ep1002", "duration": 1440, "updatedAt": "2026-10-16T00:00:00.000Z" }
      ]
    }]
  }]
}
```

同集重新检测后替换该集记录，不影响其他集。文件采用串行写入和临时文件替换；记录失败不会阻止云端检测返回跳过结果。

本地浏览器检测也可填写同一服务器地址和密钥，将最终结果通过 `POST /records` 保存到该文件；不上传音频或特征。未填写服务器时继续使用本地功能，不会生成云端文件。部署代理时需要同时开放上述 `/records` 路由。

扩展填写云端地址后，会先查询当前视频的云端记录，命中便直接使用时间点；后台批次也会先批量查询，跳过已经识别的集。查不到或云端不可用时继续原有本地或云端识别。新用户读取记录只需云端地址。本地检测且没有密钥时，新结果通过公开上报接口作为候选；持有密钥的管理员仍可直接写入正式记录。部署此功能需更新 `server.js`、`record-store.js`，重启服务并开放 `/records/lookup` 与 `/reports` 路由。

点击“重新识别当前系列并上报”后，浏览器会跳过已有记录，本地重新下载音轨并识别当前集及后续批次。`POST /reports` 不要求密钥，候选结果写入 `oped-reports.json`（可用 `OPED_REPORT_FILE` 指定位置）。普通用户在本地模式配置服务器地址但不填写密钥时，新识别结果也通过此接口提交。

同一剧集的非空 OP/ED 时间点在 180 天内由至少 5 个不同网络来源按秒一致上报后，只触发服务器独立核验。服务器根据系列 ID 自行获取番剧、合集或多 P 的完整目录，逐集获取音频，通过相邻三集的音频比对重新计算全集；每集音轨只下载一次；只有其结果与候选片段的起止时间均相差不超过 3 秒，才将该剧集写入正式 `oped-records.json`。独立核验完全重新计算，不读取旧时间点参与比对。若服务器无法访问音轨、未安装 ffmpeg 或核验结果不同，正式记录不变。空结果不会自动覆盖已有片段。

查看上报和独立核验进度：`sudo journalctl -u sync-watch-oped -f --no-pager`。日志依次显示候选上报、任务排队、三集音轨查询与下载、各集下载字节数、解码、音频指纹比对、每集匹配结果及最终写入的剧集。日志不记录下载地址、访问密钥或上报者地址。云端没有对应视频记录时，首次上报立即触发全集核验；已有记录的修改仍需五个独立来源一致上报。每次核验的总下载字节数会写入日志。

代理需设置真实来源 IP，服务只在反向代理从本机连接时采信 `X-Real-IP`。同一来源重复提交只计一次；它无法彻底防止拥有多个网络来源的恶意提交。每来源每小时最多 200 次上报，候选文件最多保留最近 1000 批，独立核验任务串行执行且限制短期重复请求。服务器核验会消耗自己的下行流量，B 站每集音轨最多下载 64 MiB，其他站点默认每集 512 MiB（HLS 只下载首尾各约 302 秒）；视频版权限制或 B 站接口风控可能使核验无法完成。安装 ffmpeg 的 Ubuntu 命令：`sudo apt install ffmpeg`。

首次上报与全集核验：云端缺少某集记录时，无需等待五次上报即可启动整个系列的独立核验。服务器从官方目录取得全集，串行下载，内存只保留当前三集音频指纹，不保存音频文件。正在核验的同系列上报合并到同一个任务。逐集下载失败会记录错误并继续，其相关比对窗口不保存伪造结果。上报集只有与服务器独立识别一致才保存；至少一集上报核验一致后，全集中未上报且云端尚无记录的集也保存独立识别结果（无匹配片段保存为 null）。未上报的已有记录不会被覆盖。相同系列完成后六小时内不重复下载，队列最多容纳三个系列。日志提供全集总数、已处理数、保存数和累计音频下载字节数。

## 多站点来源和部署文件

系列与每集记录增加 `sourceDomain`（例如 `omofun.in`、`yhdm.one`、`www.agedm.io`）；其他站点 ID 为 `web:<域名>:<视频ID>:<线路>:<集数>`，B 站旧 ID 保持兼容。域名、线路不同不会共享时间点。

除已有 `server.js`、`record-store.js`、`extension/audio-core.js` 外，部署时同步上传：

- `server/independent-verifier.js`、`server/identities.js`、`server/safe-fetch.js`、`server/decode-audio.js`
- `shared/streaming-sites.js`、`shared/media-loader.js`

路径均相对于 `oped-automation/`，需保留目录结构，然后重启原 OP/ED 服务。新增代码没有 npm 依赖；服务器解码仍需安装 `ffmpeg`。`OPED_MAX_MEDIA_BYTES` 可在服务环境文件中调整非 B 站单集下载上限，默认 536870912，允许 16 MiB～2 GiB。

HLS 无独立音轨时，首尾分段仍包含视频网络数据。服务器只下载参与匹配的首尾窗口，补回原始时间轴；中段不下载、不作音频匹配。每集媒体临时文件在解码结束或失败后删除，不把音视频写入长期记录。公开 URL 每次 DNS 解析和重定向均检查私网地址，并固定解析结果；ffmpeg 只读取本地临时文件，禁用网络协议。

AGE 示例第一线路的媒体由播放器 WASM 解密，当前服务器不会执行远程播放器脚本，也不能独立解析此线路。下载失败、加密源不可访问或格式不支持会记录错误，不写入“未识别到”的 null。OmoFun、樱花已验证页面目录和默认 HLS 地址解析；真实整集音频识别和房间同步需要部署后验证。
