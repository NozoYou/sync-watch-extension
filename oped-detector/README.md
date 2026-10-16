# OP/ED 音频检测框架

独立的离线 Python 工具，可在本地电脑或服务器运行。输入至少两集、按顺序排列的本地音视频文件；输出候选片头/片尾时间戳。当前不接入扩展的跳过按钮，不修改房间服务器，不下载网页媒体，不中转同步观看的视频。

## 本地部署

需要 Python 3.10 或更新版本，以及 PATH 中可用的 FFmpeg。

```sh
cd oped-detector
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows 激活命令为 `.venv\Scripts\activate`。

将相邻几集文件放进 `media`，复制 `episodes.example.json` 为 `episodes.json`，修改集数 ID、文件路径和可选的视频页面 URL。路径相对于清单文件。

```sh
python detect.py episodes.json --output segments.json
```

这些是供你部署的命令，本次没有安装依赖、执行检测或进行测试校验。

## 检测流程

1. FFmpeg 将本地文件解码为 8 kHz 单声道音频。
2. 每秒提取一个两秒窗口，将频谱压缩成 32 个频率带，归一化后形成音频特征图。
3. 默认比较前后两集范围内的开头、结尾各最多五分钟；短视频各取半段，避免首尾重叠。
4. 查找特征图中持续匹配的对角线，允许少量断点，排除静音，保留至少 40 秒的候选重复片段。
5. 合并边界相差不超过五秒的同类候选，使用中位数边界；保留原始证据及支持集数。至少两个不同参考集支持时标记为多集共识，仍需要人工审核。

`--threshold 0.94` 可调整相似度门槛。其他参数在 `matcher.py` 的 `DetectorConfig` 中集中管理。相似度不是识别正确率。

## 当前边界

- 输出全部标记为 `candidate` 和 `reviewed: false`，不是可以直接自动跳过的最终结果。
- 重复前情提要、插曲、预告也可能匹配；现在仅依据首尾位置区分 OP/ED，没有语义识别。
- 不同混音、配音、速度或较短片段可能漏检；时间粒度约一秒，窗口可能令边界延伸，需人工确认。
- 多集共识仍可能来自重复插曲或前情提要，不会自动变成批准跳过的片段。
- 当前解码整集到内存，适合少量普通动画集数的初期部署；长视频和大批量处理需后续增加流式解码和特征缓存。

## 模块与后续接入

- `audio.py`：媒体解码及特征提取，可独立替换为更稳健的指纹实现。
- `matcher.py`：重复音频匹配及候选区间判定。
- `detect.py`：清单入口、相邻集分析及 JSON 输出。
- `consensus.py`：候选分组、多集证据和中位数边界。
- `review.py`：查看、批准、拒绝或修改候选片段。
- `result_store.py`：原子保存检测结果，导出仅包含已批准片段的数据。

## 多集检测与人工审核

建议输入至少三集，保证每集有机会获得两个不同参考集的证据。只有两集也能生成候选，但默认不能形成多集共识。

```sh
python detect.py episodes.json --neighbors 2 --minimum-references 2 --output segments.json
python review.py segments.json
```

审核命令中的片段编号来自列表，按每集从 1 开始。批准时可以同时修正秒数，也可以省略 `--start` 和 `--end` 保留检测边界：

```sh
python review.py segments.json --episode episode-01 --segment 1 --decision approved --start 90 --end 175
python review.py segments.json --episode episode-01 --segment 2 --decision rejected
python review.py segments.json --export approved-segments.json
```

这里的秒数仅演示命令格式，不是检测结果。`pending` 可撤回审核决定。导出会排除待审核和拒绝的片段；没有已批准片段时，该集导出的片段列表为空。原始证据保留在 `segments.json`。

重新运行检测会替换输出文件，并重置其中的审核状态；需要保留旧审核时，请使用不同的输出文件名。本工具目前供单个本地进程使用，不提供多人并发编辑锁。

下一阶段可增加特征缓存、浏览器审核界面和独立查询 API。确认后的时间戳再交给扩展现有跳转流程，继续遵循成员权限及同步事件机制。服务器部署目前使用相同 CLI 批处理，不启动网络服务。
