# 文图重构工作台 / DocVision Studio

将文档图片或多页 PDF 中的文字、公式和系统框图提取为可编辑 Word、PPT、Visio 兼容文件的全栈 Web 应用。

## 功能

- 中英文 OCR，模型文件随应用打包，本地优先处理。
- 公式候选识别，输出可继续修改的公式源码。
- 矩形节点与连接线检测，叠加展示区域并支持人工校对。
- 自动校正约 ±3° 的轻微文档倾斜，并对框图节点单独执行 OCR。
- 后端结构验证、置信度评分、拓扑完整性检查。
- 导出 DOCX、原生可编辑 PPTX、Visio VDX 与 SVG。
- 内置验证样例，无需准备图片即可测试完整流程。
- PDF.js 本地逐页渲染，最多处理 30 页 PDF；每页独立识别与校对。
- Worker `/api/jobs` 对多页结果进行标准化、排序、SHA-256 模型签名和导出就绪检查。
- Worker `/api/export` 根据多页模型直接生成可编辑 DOCX，以及包含节点和连接线的多页 Visio VDX。

## 处理架构

- 浏览器：图片/PDF 渲染、OCR、公式分类、框图检测和人工校对。
- Worker 后端：构建规范化多页文档模型、验证字段与结构、计算模型哈希、生成 Visio。
- Word/Visio：由 Worker 从通过验证的多页模型生成；PPT 在浏览器生成独立可编辑对象，每个 PDF 页面对应一张幻灯片。

原始文件不会被 Worker 持久化保存。单文件限制为 50 MB，PDF 限制为 30 页。

## 本地运行

```bash
npm install
npm run dev
```

浏览器打开终端提示的地址，点击“加载验证样例”后再点击“开始智能重构”。第一次识别会初始化中英文 OCR 引擎，后续任务会使用浏览器缓存。

## 验证

```bash
npm run lint
npm run build
```

独立准确率基准：

```bash
node tests/create-benchmark.mjs
node --experimental-strip-types tests/run-benchmark.ts
node tests/render-benchmark-overlay.mjs
```

详细架构、识别流程和升级路径见 `IMPLEMENTATION_PLAN.md`。

## 当前限制

- 当前框图检测优先支持矩形节点与水平连接线；复杂符号、泳道、曲线和嵌套组合需要高精度视觉模型。
- 公式 MVP 以可编辑源码呈现；要生成 Word 原生 OMML 公式，可在后端接入 PP-FormulaNet + MathML/OMML 转换。
- VDX 是 Visio 2003–2010 XML 格式，桌面版 Visio 可打开并另存为 VSDX；后续可直接生成 OPC/XML VSDX 包。
