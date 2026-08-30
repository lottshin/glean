# Echo

Obsidian 里的英语精听插件。v1 主路径是：**看 → 听 → 查 → 存**（查词与生词 Markdown 入库是下一里程碑）。

## 现在能做什么

- 右键视频 / 音频（`mp4` / `webm` / `mkv` / `mp3` / `m4a` 等）→ **Echo: 精听**；或在视图里点 **打开**
- 同目录同名 `.srt` / `.vtt`（也认 `video.en.srt`）自动挂上
- **精听模式（默认）**：上方材料区（横屏铺满、竖屏居中、音频条）+ 当前句焦点 + 字幕列表；点句跳转、句末停
- **听写模式（切换）**：工具条点「听写」或按 `D`；隐藏原句、逐字匹配；`H` 显示/隐藏原句
- 快捷键：`Space` 播放暂停，`R` 重听，`[` `]` 上下句，`-` `=` 变速，`D` 切换模式

## 下一步（PRD M2）

点词查义、ECDICT 离线词典、生词笔记入库、`obsidian://echo` 时间戳回跳——不再继续堆听写花样。

还没有：YouTube / B 站、阅读染色、SRS。

## 开发

```bash
npm install
npm test
npm run dev
```

把本仓库拷进某个 vault 的 `.obsidian/plugins/echo/`，或 symlink。需要 Obsidian 1.5+，目前仅桌面端。

## 许可

MIT。欢迎打赏，但功能不设门槛。
