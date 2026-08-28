# Echo

Obsidian 里的英语精听插件。v1 先做本地视频 + SRT：逐句高亮、一键重听本句、点句子跳转。生词库和阅读是后面的事。

## 现在能做什么

- 在文件管理器右键 `mp4` / `webm` / `mkv` → **Echo: 精听**
- 同目录同名的 `.srt` / `.vtt`（也认 `video.en.srt`）会自动挂上
- 点字幕跳到那一句并播放到句尾停下
- 快捷键：`Space` 播放暂停，`R` 重听本句，`[` `]` 上一句/下一句，`-` `=` 变速

还没有：查词、生词卡、YouTube / B 站、阅读染色。

## 开发

```bash
npm install
npm test
npm run dev
```

把本仓库拷进某个 vault 的 `.obsidian/plugins/echo/`，或在 Obsidian 里用「文件夹作为插件」加载。`npm run dev` 会监视改动并写出 `main.js`。

需要 Obsidian 1.5+，目前仅桌面端。

## 许可

MIT。欢迎打赏，但功能不设门槛。
