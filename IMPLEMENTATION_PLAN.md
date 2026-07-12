# 文图重构工作台：实施规划

## 1. 目标与交付边界

本项目实现一个本地优先的 Web 应用 MVP，完成以下闭环：

1. 上传 PNG、JPG、WEBP 等文档图片。
2. 自动识别文字与公式候选，并检测系统框图中的矩形节点和连接线。
3. 在页面上叠加显示识别区域，允许人工修改元素类型和内容。
4. 服务端验证图片尺寸、元素结构、可编辑对象和框图拓扑。
5. 导出 `.docx`、可编辑 `.pptx`、Visio 兼容 `.vdx` 与 `.svg`。

MVP 的文字识别在浏览器内运行，图片不发送给第三方模型。复杂手写公式、弯曲连接线、带图标的复杂 Visio 模板属于后续高精度阶段。

## 2. 技术架构

| 层 | 当前实现 | 后续增强 |
| --- | --- | --- |
| 前端 | React 19 + TypeScript + Vinext | 多页任务管理、模板库 |
| 文字 OCR | Tesseract.js，中英文模型随应用打包 | PaddleOCR PP-OCRv5 服务 |
| 公式识别 | OCR 文本 + 数学符号/结构分类，保留可编辑公式源码 | PP-FormulaNet plus 模型输出 LaTeX/MathML |
| 框图重构 | 灰度二值化、长线段扫描、矩形闭合检测、拓扑线段提取 | OpenCV HoughLinesP + 图元分类模型 |
| 后端 | Edge API 校验元素 schema、坐标、置信度与拓扑 | 任务队列、模型服务、对象存储 |
| Word | docx.js 生成标准 DOCX | LaTeX → MathML/OMML 原生公式 |
| PPT | PptxGenJS 生成独立文本框、图形与连接线 | 母版、自动分页、复杂图标矢量化 |
| Visio | DatadiagramML `.vdx` + SVG | OPC/XML 直接生成 `.vsdx` |

## 3. 识别流程

1. 校验文件类型与 50 MB 大小上限。
2. 将图片缩放到最长边 1800 像素，建立灰度二值图。
3. 扫描长水平线，结合左右竖边的墨迹比例判断矩形节点。
4. 识别与节点相接的线段，重建连接线。
5. Tesseract.js 识别中英文文字行；含多个数学运算符的行标记为公式。
6. 将落在节点内部的文字合并为节点标签。
7. 把元素发往后端执行结构验证和导出就绪评分。
8. 用户可在结果页修改类型、文本或删除误检项，再导出。

## 4. 验收标准

- 上传与拖拽均可读取图片。
- 内置验证样例能识别至少一个文字块、一个公式、三个框图节点和两条连接线。
- 每个识别区域可在预览图上点击，并能编辑内容和类型。
- `/api/health` 返回健康状态；`/api/analyze` 返回任务编号、四项检查和评分。
- Word、PPT、VDX、SVG 均能触发下载；PPT 的文字、形状与连接线是独立对象。
- 生产构建、类型检查和页面交互验证通过。

## 5. 参考实现依据

- Tesseract.js：浏览器/Node.js 中运行的 WebAssembly OCR，可返回文字及边界框。
- PaddleOCR：PP-StructureV3 负责文档版式，PP-FormulaNet 系列输出公式 LaTeX。
- PptxGenJS：生成符合 OOXML 的 PPTX，并支持文本、形状、图片和图表对象。
- Microsoft Visio：VSDX 基于 Open Packaging Conventions 和 XML；本 MVP 先输出兼容性更简单的 VDX/XML。
- Microsoft Office：现代 Office 公式优先使用 OMML，并已支持 MathML 导入；这是高精度公式导出的升级方向。
