# Glean 离线词典数据

Glean 的运行时词典由构建脚本从 ECDICT 生成。原始 CSV 和生成的 TSV 都不提交到 Git。
正式构建会把两个 TSV 以 gzip 压缩后嵌入 `main.js`，首次启用时校验并解压到 vault
配置目录。当前压缩数据约 3.5 MiB，不需要单独托管或联网下载。

## 来源与许可

- 上游项目：<https://github.com/skywind3000/ECDICT>
- 数据文件：`ecdict.csv`
- 当前上游文件约 76 万词条、65.9 MB
- 上游仓库声明采用 MIT License，版权声明为 `Copyright (c) 2025 Linwei`
- 发布 Glean 词典产物时，必须同时附带上游 LICENSE 和来源链接

构建脚本不会修改上游数据，只做筛选、字段截断、排序和格式转换。

## 为什么使用 TSV

Glean v1 仅支持 Obsidian 桌面端，可以直接通过 Node `fs` 按字节读取文件。排序 TSV
支持文件内二分查找，不需要把整个词典载入内存，也不需要额外引入 SQLite WASM。

生成两个文件：

- `glean-dict-v1.tsv`：词条查询表，按第一列 `lookup` 升序排列
- `glean-inflect-v1.tsv`：词形到 lemma 的映射，按第一列 `form` 升序排列

词典表字段依次为：

```text
lookup	word	phonetic	pos	translation	definition	tag	collins	oxford	bnc	frq
```

所有字段中的制表符和换行会被压成空格。中文释义最多保留三条，英文释义最多保留一条。

## 构建

先下载 ECDICT：

```bash
mkdir -p data/source
curl -L https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv \
  -o data/source/ecdict.csv
```

再生成默认的 6 万词频阈值版本：

```bash
npm run dict:build -- \
  --input data/source/ecdict.csv \
  --out-dir data/generated \
  --rank-limit 60000
```

筛选规则是满足以下任一条件：

- 牛津核心词
- 有柯林斯星级
- 有考试标签
- BNC 或当代语料库排名不超过阈值

脚本同时输出 `report.json`，列出多个阈值对应的词条数和预估体积。最终阈值应以真实字幕
覆盖率和 30 MB 体积上限共同决定。

## 2026-08-31 基线测量

使用上游 `ecdict.csv`（770,611 行，SHA-256
`1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`）得到：

- 58,226 个词条，7.54 MiB
- 39,333 条词形映射，0.66 MiB
- ECDICT 这份基础 CSV 的有效 BNC/当代词频排名在 6 万处封顶，因此 6 万到 20 万阈值
  生成的词典相同
- 100 条 TED 演讲简介组成的样本包含 5,182 次 token、2,067 个唯一 token
- 出现次数覆盖率为 94.98%；唯一 token 覆盖率为 89.36%
- 未命中项主要是人名、年份、所有格和临时复合词，不能靠盲目放大词频阈值解决

因此 v1 采用 6 万阈值。运行时应另做所有格回退，专有名词和未收录复合词允许空释义入库。

## 覆盖率测量

```bash
npm run dict:coverage -- \
  --dict data/generated/glean-dict-v1.tsv \
  --inflections data/generated/glean-inflect-v1.tsv \
  --sample-size 200 \
  --out data/generated/coverage.json \
  /path/to/subtitles
```

抽样对唯一 token 使用稳定哈希排序，因此同一批字幕重复执行会得到同一份样本。报告分别统计
直接命中、通过 lemma 命中和未命中词，便于检查阈值是否合理。

## 运行时存放位置

正式构建首次启用时会自动把两个 TSV 安装到：

```text
<vault>/.obsidian/glean/dict/
```

不要把运行时文件放在插件目录。开发环境的插件目录可能是 Git 仓库软链接，插件更新也
可能清空目录。安装过程会先解压到临时文件，校验字节数和 SHA-256 后再替换正式文件，并
写入 `.glean-dictionary.json` 记录版本和摘要。它不发出网络请求。

重载插件后，Glean 设置页应显示“已加载 Glean 离线词典”。也可以在设置中填写其他绝对
路径，或填写相对 vault 根目录的路径，然后用设置页的“安装内置词典”写入该目录。目录
存在但文件缺失、损坏或不可读时，启动和设置页会显示失败目录。

开发模式 `npm run dev` 不嵌入词典，以免每次热构建处理数 MiB 数据；它继续使用已经安装
在 vault 中的文件。`npm run build` 是正式构建，会要求
`data/generated/glean-dict-v1.tsv` 和 `data/generated/glean-inflect-v1.tsv` 已生成。
