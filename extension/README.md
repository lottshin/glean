# Glean YouTube Capture（浏览器扩展）

桌面 Chrome / Edge 扩展：在 YouTube 页面读取已有字幕，POST 到本机 Obsidian 里的 Glean 接收端，写成 vault 文件。

## 开发

```bash
npm run extension:build
```

产物在 `extension/dist/`。Chrome → 扩展程序 → 加载已解压的扩展程序 → 选该目录。

## 使用

1. Obsidian 桌面端启用 Glean，打开设置里的「YouTube 采集接收端」，复制 token。
2. 点击扩展图标，填入端口（默认 `17865`）和 token，保存。
3. 打开任意带字幕的 YouTube 视频，点播放器旁的 **Glean** 按钮，或在弹窗里选语言后同步。

## 说明

- 只采集页面已加载的字幕轨道，不下载音视频。
- 需要桌面端 Obsidian 正在运行；iPad / 手机通过 Obsidian Sync 使用同步后的字幕与会话笔记。
