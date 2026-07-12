# 文图重构工作台：验证报告

验证日期：2026-07-11（Asia/Singapore）

## 0. PDF 与后端功能验证

- 由干净基准页和倾斜基准页生成真实的双页 PDF：`tests/fixtures/docvision-two-page-benchmark.pdf`。
- 使用 Poppler `pdfinfo` 验证为未加密、2 页、A4 横向 PDF。
- 使用 Poppler 将两页重新渲染为 PNG，并完成页面清晰度和布局目视检查。
- 使用 `pdfjs-dist` 实际加载该 PDF，确认页数和元数据可读取。
- Worker 自动化测试覆盖：静态 APP、后端多页规范模型、模型哈希、多页 Visio XML，以及可由 ZIP/OOXML 解析的多页 DOCX。
- 生产构建确认包含 PDF.js Worker，并通过 Sites 构件校验。

## 1. 已完成检查

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| ESLint 代码检查 | 通过 | `npm run lint`，退出码 0 |
| 生产构建 | 通过 | `npm run build`，五个构建阶段全部完成 |
| Sites 构件校验 | 通过 | ESM Worker `default.fetch` 与 hosting manifest 均有效 |
| 健康接口 | 通过 | `/api/health` 返回 HTTP 200、`status: ok` |
| 结构验证接口 | 通过 | 合成文字、公式、节点、连接线请求返回 HTTP 200、`ready: true` |
| 四项验证 | 通过 | 图像完整性、元素结构、可编辑内容、框图拓扑全部通过 |
| 生产部署 | 通过 | 部署状态 `succeeded` |

## 2. 独立图片准确率测试（修复版）

测试文件不是 APP 内置样例，文件名不会触发任何兜底逻辑。测试图包含：

- 4 行中英文正文；
- 1 条相关匹配公式；
- 3 个矩形框图节点及中文标签；
- 2 条带箭头连接线；
- 1.1° 倾斜、轻度模糊与 JPEG 压缩。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 文字行字符准确率 | 80.0% | 100.0% |
| 公式字符准确率 | 100.0% | 100.0% |
| 框图节点标签准确率 | 未独立测量 | 100.0% |
| 框图节点 F1 | 倾斜图 0% | 100.0% |
| 连接线 F1 | 倾斜图 0% | 100.0% |
| 加权总体准确率 | 倾斜图 55.0% | 100.0% |

本次根据实测做了四项修复：

1. 页面文字识别从稀疏文本模式改为自动版面分析模式。
2. 每个框图节点增加独立 OCR，避免整行箭头干扰节点标签。
3. 合并粗连接线产生的重复检测，避免一条线被识别两次。
4. 增加 ±3° 自动倾斜估计和校正，再执行 OCR 与框图检测。

这里的 100% 是对这张可控测试图的结果，不代表任意真实照片、手写公式或复杂 Visio 图都能达到 100%。完整原始结果保存在 `docvision-benchmark-final-results.json`。

## 3. 后端验证样例结果

```json
{
  "score": 94,
  "ready": true,
  "counts": {
    "text": 1,
    "formula": 1,
    "diagramShapes": 2,
    "connectors": 1
  },
  "warnings": []
}
```

## 4. 浏览器验证说明

应用的预览服务已正常启动，但本次云端浏览器环境阻止了内部预览地址访问，因此无法生成可信的运行态页面截图。没有用设计稿冒充运行截图。作为替代，使用与 APP 完全相同的 OCR、公式分类、自动校正和框图检测函数生成了带真实识别框的分析证据图，并完成生产构建、Worker 级 API 实测与部署状态验证。

建议人工验收步骤：

1. 打开应用，点击“加载验证样例”。
2. 点击“开始智能重构”，等待进度达到 100%。
3. 确认预览图出现文字、公式、框图节点与连接线标注。
4. 修改任意元素内容，并分别导出 Word、PPT、Visio VDX、SVG。
5. 在 Office/Visio 中确认对象可继续编辑。

## 5. 公开技术依据

- [Tesseract.js 官方项目](https://github.com/naptha/tesseract.js/)
- [PaddleOCR 公式识别文档](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/pipeline_usage/formula_recognition.html)
- [PptxGenJS 官方文档](https://gitbrent.github.io/PptxGenJS/)
- [Microsoft：Visio VSDX 文件格式](https://learn.microsoft.com/en-us/office/client-developer/visio/introduction-to-the-visio-file-formatvsdx)
- [Microsoft：MathML Support in Microsoft 365](https://learn.microsoft.com/en-us/office/math/mathml)
