# 云端音频特征比对服务

此服务与一起看的房间服务器独立，使用 Node.js 18 或更新版本，无第三方依赖。它接收音频特征进行比对，也可接收本地检测的最终结果，并保存番名及观看链接；不接收 Cookie、音频下载地址或音频文件。

上传时需要保留相对目录：

```text
oped-automation/
  server/server.js
  server/record-store.js
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
location ~ ^/(detect|records)$ {
    client_max_body_size 12m;
    proxy_read_timeout 180s;
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Authorization $http_authorization;
}
```

域名和 HTTPS 证书需在服务器上配置。在扩展的“OP/ED 音频识别”中选择“云端服务器”，填写 `https://你的检测域名` 和密钥。若本机运行此服务，可填写 `http://127.0.0.1:8788`。

## 接口

`POST /detect`，请求头 `Authorization: Bearer <密钥>`。请求为三集的 `id`、`duration`、`features`（每秒一个 32 维频谱特征）和 `energies`。

返回 `episodes`，每项包含 `id`、`duration` 和 `segments`。每个片段含 `type`、`start`、`end`；未匹配的片头/片尾不会出现在列表中。没有匹配的集返回空列表。浏览器和云端共用 `audio-core.js`，使用相同算法。

服务一次处理一个任务；繁忙时返回 429。当前未部署到你的服务器，也未执行测试或校验。

## 云端记录文件

新检测结果自动写入服务器上的 `oped-automation/server/data/oped-records.json`。设置 `OPED_RECORD_FILE` 可指定其他绝对路径，服务运行用户需要有对应目录的写权限。

每个番剧保存名称和番剧 ID，各集保存集数、观看页面链接、时长及更新时间。`opening`、`ending` 使用秒为单位的 `start` / `end`，没有匹配时为 `null`。只记录已完成检测的结果；下载失败等任务错误不会伪装成“未识别到”。

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
