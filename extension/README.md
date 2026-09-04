# Glean Capture（浏览器扩展）

桌面 Chrome / Edge 扩展：在 YouTube 页面读取已有字幕，或在 B 站页面读取英文字幕和播放地址，POST 到本机 Obsidian 里的 Glean 接收端，写成 vault 文件。

## 开发

```bash
npm run extension:build
```

产物在 `extension/dist/`。Chrome → 扩展程序 → 加载已解压的扩展程序 → 选该目录。

## 使用

1. Obsidian 桌面端启用 Glean，打开设置里的「浏览器采集接收端」，复制 token。
2. 点击扩展图标，填入端口（默认 `17865`）和 token，保存。
3. 打开带**英文字幕**的 YouTube 或 B 站视频，点播放器旁的 **Glean** 按钮，或在弹窗里同步。非英文轨不会出现在列表里，也无法导入。
4. B 站视频需要先登录；只有跟读音对得上的英文字幕轨才会同步。没有英文轨的视频将在后续版本支持从音频自动生成。
5. B 站会把字幕机翻成英文等多国语言，这类轨看着是英文、跟读音对不上，同步会拒绝。判断依据是 `ai_type` 为 `1`。注意 `ai_type` 不代表原声语言：英文原声的视频同样会被挂上一条 `ai_type` 为 `0` 的中文字幕。

## 说明

- YouTube 只采集字幕；B 站额外取一条 720P 的单文件 MP4 地址（`fnval=1`，音视频已合流），在线播放，因此不写入任何媒体文件。地址由 CDN 签名，约两小时后失效。
- B 站 CDN 只认同时带 `Referer` 和浏览器 `User-Agent` 的请求，且请求带 `Origin` 头就会拒绝，浏览器三个条件都满足不了，所以画面由 Obsidian 侧的接收端转发，不是 `<video>` 直连 CDN。
- 需要桌面端 Obsidian 正在运行；iPad / 手机通过 Obsidian Sync 使用同步后的字幕与会话笔记。
