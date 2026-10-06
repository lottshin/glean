# Chrome Web Store Listing

## Product Details

**Name**

Glean Capture

**Short description**

将 YouTube 和 B 站英文字幕同步到 Obsidian Glean。

**Detailed description**

Glean Capture 是 Glean Obsidian 插件的配套浏览器扩展，必须搭配 Glean Obsidian 插件使用，无法独立保存和学习字幕。它会将当前 YouTube 或 B 站视频的英文字幕同步到本机的 Glean。

在视频页面打开扩展，选择可用的英文字幕轨并同步。Glean 会在你的 Obsidian vault 中保存字幕和会话笔记，随后可用于精听、查词、生词卡和复习。

功能：

- 仅同步视频已有的英文字幕。
- YouTube 支持人工字幕和英文自动字幕。
- B 站会排除由其他语言机翻出的英文字幕。
- 同步到用户自己电脑上运行的 Obsidian Glean 接收端。
- 扩展更新后，已打开的视频页面可自动恢复，无需手动刷新。

使用前需在 Obsidian Glean 设置中启用浏览器采集接收端，并将端口和 token 填入扩展。

**Category**

Education

**Single purpose declaration**

Capture English captions from YouTube and Bilibili and sync them to the Glean Obsidian plugin.

## Privacy Disclosure

**Data handled**

- 当前视频的标题、链接、频道或作者名称、字幕语言和用户选择的英文字幕。
- B 站视频的临时播放地址和相关媒体元数据。
- 用户填写的本机 Obsidian 接收端口和 token。

**Use**

这些数据仅用于将用户主动选择的视频字幕同步到用户自己电脑上的 Obsidian Glean 插件。

**Storage**

- 端口和 token 存在 Chrome 同步存储中。
- 字幕分句缓存存于 Chrome 本地存储中。

**Sharing**

数据只会发送到用户自己配置的 `127.0.0.1` 或 `localhost` Obsidian 接收端。Glean 不运营远程收集、分析或广告服务器，不出售或共享数据给第三方。

**Permissions**

- `storage`: 保存接收端设置和字幕分句缓存。
- `scripting`: 扩展刚安装或更新后，向用户已打开的 YouTube/B 站视频页恢复内容脚本，免去手动刷新。

## Store Assets

Use files in `extension/store-assets/`:

- `icon-128.png`: Store icon.
- `screenshot-listen.png`, `screenshot-dictation.png`, `screenshot-review.png`: Store screenshots.
- `promo-small.png`: 440 x 280 promo tile.
- `promo-marquee.png`: 1400 x 560 marquee image.

## URLs

Use the public privacy repository below. Homepage and support URLs can be added later when the main project has a public repository:

- Privacy policy: `https://github.com/lottshin/glean-privacy/blob/main/README.md`
