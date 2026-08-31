# Echo

在 Obsidian 里精听视频、阅读英文笔记，并把遇到的词连同原句沉淀成自己的 Markdown 生词库。

> 当前为 `0.0.1` 开发预览版，仅支持 Obsidian 桌面端（最低 `1.6.6`）。尚未提交社区插件市场。

## 核心工作流

### 精听

1. 把本地视频或音频放进 vault，并配一份同目录、同名的 `.srt` / `.vtt` 字幕。
2. 右键媒体选择 **Echo: 精听**，或点击侧边栏耳机图标后打开媒体。
3. 点击字幕句子重听，点击句中单词查看离线释义。
4. 点击 **加入生词**，Echo 会创建普通 Markdown 词卡，保存原句、媒体路径和时间戳。
5. 从词卡点击时间戳，可重新打开 Echo 并跳回原句。

精听快捷键：

- `Space`：播放 / 暂停
- `R`：重听当前句
- `[` / `]`：上一句 / 下一句
- `-` / `=`：降低 / 提高倍速
- `D`：精听 / 听写切换
- `H`：听写模式显示 / 隐藏原句

### 阅读

打开普通 Markdown 英文笔记，通过标题栏书本图标、文件右键菜单或命令 **Echo: 阅读当前笔记** 进入显式阅读模式。

- 正文保持连续，英文词可点击查义。
- `new` / `learning` 状态以轻量底线提示，`known` / `ignored` 不染色。
- 顶部状态栏按全文唯一词汇显示覆盖率。
- 从阅读弹层入库时，词卡保存当前句和来源笔记链接。
- 已入库词可在弹层中直接切换为生词、学习中、已掌握或忽略。

阅读模式只修改渲染出来的界面，不改原始文章。

## 生词数据

生词默认存放在 `Echo/Words/<首字母>/<lemma>.md`。一词一篇 Markdown，`lemma` 是主键；听力和阅读遇到的语境会追加到同一张卡。

已入库的词可以从查词弹层、词卡顶部按钮、标题栏图标、文件右键菜单或命令面板移出。文件进入 Obsidian 配置的废纸篓，不会直接永久删除。

字段格式、目录迁移、性能与 Anki 边界见 [生词库文档](docs/lexicon.md)。

## 离线词典

Echo 使用 ECDICT 生成的排序 TSV，不联网查词，也不把整本词典加载进内存。词典文件为：

```text
echo-dict-v1.tsv
echo-inflect-v1.tsv
```

默认存放在 vault 配置目录的 `echo/dict/` 下，也可在 Echo 设置里指定其他目录。开发者可按 [词典文档](docs/dictionary.md) 从 ECDICT 构建。

### 安装词典

将词典包中的两个 TSV 文件解压到：

```text
<vault>/.obsidian/echo/dict/
```

重载 Echo 后，设置页应显示“已加载 Echo 离线词典”。如果使用其他位置，在设置中填写绝对路径或相对 vault 根目录的路径。词典损坏或配置目录不完整时，Echo 会显示具体目录，但仍允许把未收录词以空释义入库。

## 安装

### 灰度安装包

灰度包需要包含 `main.js`、`manifest.json`、`styles.css`。把三个文件放入：

```text
<vault>/.obsidian/plugins/echo/
```

再按上面的步骤单独安装词典。当前 `0.0.1` 仍是开发预览版；如果尚未提供 Release 压缩包，请使用下面的源码安装方式，不要只复制仓库里的 TypeScript 源码。

### 源码安装

```bash
npm install
npm test
npm run build
```

把仓库放到或软链接到：

```text
<vault>/.obsidian/plugins/echo/
```

确保目录中存在 `manifest.json`、`main.js` 和 `styles.css`，然后在 Obsidian 的第三方插件设置中启用 Echo。

开发时运行：

```bash
npm run dev
```

配合 Obsidian Hot Reload 插件和仓库根目录的 `.hotreload` 标记，可在源码变化后自动重载。

## 验证

```bash
npm run build
npm test
npm run lint
```

## 当前边界

- 本地媒体优先；YouTube / B 站尚未实现。
- 阅读模式目前作用于 Markdown 阅读视图；手动切回源码模式会自动退出 Echo 阅读。
- 阅读嵌入内容时，语境归属当前打开的来源笔记；交互链接和代码不会被改造成可查词单词。
- 媒体改名后 Echo 会尝试恢复回跳；如果 vault 中有多个同名媒体，会提示手动打开，避免跳错文件。
- 不自研 SRS；未来 Anki 只作为可选导出和调度端，Markdown 仍是权威数据。

## 许可

Echo 使用 MIT License。ECDICT 的来源和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
