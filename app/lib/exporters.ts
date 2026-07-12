"use client";

import type { AnalysisResult, DocumentPage, ExtractedElement } from "./types";
import { kindLabel } from "./types";

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const safeBaseName = (fileName: string) =>
  (fileName.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "-").trim() || "DocVision-导出").slice(0, 80);

const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
};

const dataUrlToBytes = (dataUrl: string) => {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const elementSummary = (elements: ExtractedElement[]) => {
  const count = (type: ExtractedElement["type"]) => elements.filter((item) => item.type === type).length;
  return {
    text: count("text"),
    formula: count("formula"),
    shapes: count("diagram-shape"),
    connectors: count("diagram-connector"),
  };
};

const documentPages = (result: AnalysisResult): DocumentPage[] =>
  result.pages?.length
    ? result.pages
    : [{ pageNumber: 1, imageUrl: result.imageUrl, width: result.width, height: result.height, elements: result.elements, rawText: result.rawText, confidence: result.confidence }];

const exportPayload = (result: AnalysisResult) => ({
  fileName: result.fileName,
  width: result.width,
  height: result.height,
  elements: result.elements,
  pages: documentPages(result).map(({ pageNumber, imageUrl, width, height, elements }) => ({ pageNumber, imageUrl, width, height, elements })),
});

export async function exportWord(result: AnalysisResult) {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    HeadingLevel,
    ImageRun,
    Packer,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = await import("docx");
  const summary = elementSummary(result.elements);
  const content: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

  content.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: "文图重构识别报告", bold: true, color: "172033" })],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `源文件：${result.fileName}`, color: "4C5B70" }),
        new TextRun({ text: `    综合置信度：${Math.round(result.confidence * 1000) / 10}%`, color: "14A87A" }),
      ],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: ["文字", "公式", "框图节点", "连接线"].map(
            (label) =>
              new TableCell({
                shading: { type: ShadingType.CLEAR, fill: "EAF0FF" },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 2, color: "DCE3EC" },
                  bottom: { style: BorderStyle.SINGLE, size: 2, color: "DCE3EC" },
                  left: { style: BorderStyle.SINGLE, size: 2, color: "DCE3EC" },
                  right: { style: BorderStyle.SINGLE, size: 2, color: "DCE3EC" },
                },
                children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: label, bold: true })] })],
              }),
          ),
        }),
        new TableRow({
          children: [summary.text, summary.formula, summary.shapes, summary.connectors].map(
            (value) =>
              new TableCell({
                children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(value), size: 28 })] })],
              }),
          ),
        }),
      ],
    }),
    new Paragraph({ text: "" }),
  );

  documentPages(result).forEach((page) => {
    content.push(
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(`第 ${page.pageNumber} 页 · 源页预览`)] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({
          data: dataUrlToBytes(page.imageUrl),
          transformation: { width: 590, height: Math.max(180, Math.min(650, (590 * page.height) / page.width)) },
          type: "png",
        })],
      }),
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`第 ${page.pageNumber} 页 · 可编辑内容`)] }),
    );
    page.elements.filter((item) => item.type !== "diagram-connector").forEach((element, index) => {
      const isFormula = element.type === "formula";
      content.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${index + 1}. ${kindLabel[element.type]}  `, bold: true, color: isFormula ? "14A87A" : "2457D6" }),
          new TextRun({ text: `${Math.round(element.confidence * 100)}%`, color: "637083", size: 18 }),
        ],
        spacing: { before: 180, after: 80 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: element.content,
            font: isFormula ? "Cambria Math" : "Microsoft YaHei",
            italics: isFormula,
            size: isFormula ? 26 : 22,
          }),
        ],
        shading: isFormula ? { type: ShadingType.CLEAR, fill: "E8F7F2" } : undefined,
        indent: { left: 220 },
      }),
      );
    });
  });

  const document = new Document({
    creator: "DocVision Studio",
    title: `${safeBaseName(result.fileName)} - 文图重构报告`,
    description: "由文图重构工作台生成的可编辑识别结果",
    styles: {
      default: {
        document: { run: { font: "Microsoft YaHei", size: 21, color: "172033" } },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
        children: content,
      },
    ],
  });
  downloadBlob(await Packer.toBlob(document), `${safeBaseName(result.fileName)}-可编辑.docx`);
}

export async function exportWordFromBackend(result: AnalysisResult) {
  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "word", ...exportPayload(result) }),
  });
  if (!response.ok) throw new Error("后端 Word 生成失败，请稍后重试。");
  downloadBlob(await response.blob(), `${safeBaseName(result.fileName)}-后端可编辑.docx`);
}

export async function exportPowerPoint(result: AnalysisResult) {
  const pptxModule = await import("pptxgenjs");
  const PptxGenJS = pptxModule.default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "DocVision Studio";
  pptx.subject = "图片转可编辑 PPT";
  pptx.title = `${safeBaseName(result.fileName)} - 可编辑重构`;
  pptx.company = "DocVision Studio";
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei",
  };

  for (const page of documentPages(result)) {
  const slide = pptx.addSlide();
  slide.background = { color: "F5F7FA" };
  slide.addText("文图重构 · 可编辑结果", {
    x: 0.55,
    y: 0.22,
    w: 8.4,
    h: 0.4,
    fontFace: "Microsoft YaHei",
    fontSize: 18,
    bold: true,
    color: "172033",
    margin: 0,
  });
  slide.addText(`${result.fileName} · 第 ${page.pageNumber} 页 · ${Math.round(page.confidence * 1000) / 10}%`, {
    x: 9.25,
    y: 0.27,
    w: 3.5,
    h: 0.25,
    fontSize: 9,
    color: "637083",
    align: "right",
    margin: 0,
  });
  slide.addShape(pptx.ShapeType.line, {
    x: 0.55,
    y: 0.73,
    w: 12.2,
    h: 0,
    line: { color: "DCE3EC", width: 1 },
  });

  const stage = { x: 0.55, y: 0.96, w: 12.2, h: 6.05 };
  slide.addShape(pptx.ShapeType.rect, {
    ...stage,
    fill: { color: "FFFFFF" },
    line: { color: "DCE3EC", width: 1 },
    radius: 0.08,
  } as never);

  for (const element of page.elements) {
    const x = stage.x + (element.bbox.x / page.width) * stage.w;
    const y = stage.y + (element.bbox.y / page.height) * stage.h;
    const w = Math.max(0.12, (element.bbox.width / page.width) * stage.w);
    const h = Math.max(0.08, (element.bbox.height / page.height) * stage.h);
    if (element.type === "diagram-connector" && element.geometry?.points) {
      const [x0, y0, x1, y1] = element.geometry.points;
      slide.addShape(pptx.ShapeType.line, {
        x: stage.x + (x0 / page.width) * stage.w,
        y: stage.y + (y0 / page.height) * stage.h,
        w: ((x1 - x0) / page.width) * stage.w,
        h: ((y1 - y0) / page.height) * stage.h,
        line: { color: "637083", width: 1.6, endArrowType: "triangle" },
      } as never);
      continue;
    }
    if (element.type === "image" && element.imageUrl) {
      slide.addImage({ data: element.imageUrl, x, y, w, h });
      continue;
    }
    if (element.type === "diagram-shape") {
      slide.addShape(pptx.ShapeType.rect, {
        x,
        y,
        w,
        h,
        fill: { color: "FFFFFF", transparency: 0 },
        line: { color: "7C4DFF", width: 1.6 },
        radius: 0.05,
      } as never);
      slide.addText(element.content, {
        x: x + 0.05,
        y: y + 0.04,
        w: Math.max(0.1, w - 0.1),
        h: Math.max(0.08, h - 0.08),
        fontFace: "Microsoft YaHei",
        fontSize: Math.max(8, Math.min(14, h * 12)),
        color: "172033",
        align: "center",
        valign: "mid",
        margin: 0.02,
        breakLine: false,
      } as never);
      continue;
    }
    slide.addText(element.content, {
      x,
      y,
      w,
      h: Math.max(h, 0.22),
      fontFace: element.type === "formula" ? "Cambria Math" : "Microsoft YaHei",
      fontSize: Math.max(8, Math.min(element.type === "formula" ? 18 : 15, h * 12)),
      italic: element.type === "formula",
      color: element.type === "formula" ? "0B7A58" : "172033",
      bold: element.type === "text" && h > 0.35,
      margin: 0,
      breakLine: false,
      fit: "shrink",
    } as never);
  }

  slide.addText("所有文字、公式源码、节点与连接线均为独立可编辑对象", {
    x: 0.62,
    y: 7.18,
    w: 12,
    h: 0.2,
    fontSize: 8.5,
    color: "637083",
    margin: 0,
  });
  }
  const blob = await pptx.write({ outputType: "blob" });
  downloadBlob(blob as Blob, `${safeBaseName(result.fileName)}-可编辑.pptx`);
}

export async function exportVisioFromBackend(result: AnalysisResult) {
  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "visio", ...exportPayload(result) }),
  });
  if (!response.ok) throw new Error("后端 Visio 生成失败，请稍后重试。");
  downloadBlob(await response.blob(), `${safeBaseName(result.fileName)}-后端可编辑框图.vdx`);
}

function visioShapeXml(element: ExtractedElement, id: number, pageHeight: number, scale: number) {
  const x = element.bbox.x * scale;
  const yTop = element.bbox.y * scale;
  const width = Math.max(0.45, element.bbox.width * scale);
  const height = Math.max(0.25, element.bbox.height * scale);
  const pinX = x + width / 2;
  const pinY = pageHeight - yTop - height / 2;
  return `
      <Shape ID="${id}" NameU="Process.${id}" Name="Process.${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
        <XForm><PinX>${pinX.toFixed(4)}</PinX><PinY>${pinY.toFixed(4)}</PinY><Width>${width.toFixed(4)}</Width><Height>${height.toFixed(4)}</Height><LocPinX>${(width / 2).toFixed(4)}</LocPinX><LocPinY>${(height / 2).toFixed(4)}</LocPinY><Angle>0</Angle><FlipX>0</FlipX><FlipY>0</FlipY><ResizeMode>0</ResizeMode></XForm>
        <Geom IX="0"><NoFill>0</NoFill><NoLine>0</NoLine><NoShow>0</NoShow><NoSnap>0</NoSnap><MoveTo IX="1"><X>0</X><Y>0</Y></MoveTo><LineTo IX="2"><X>${width.toFixed(4)}</X><Y>0</Y></LineTo><LineTo IX="3"><X>${width.toFixed(4)}</X><Y>${height.toFixed(4)}</Y></LineTo><LineTo IX="4"><X>0</X><Y>${height.toFixed(4)}</Y></LineTo><LineTo IX="5"><X>0</X><Y>0</Y></LineTo></Geom>
        <Text>${escapeXml(element.content)}</Text>
      </Shape>`;
}

function visioConnectorXml(element: ExtractedElement, id: number, pageHeight: number, scale: number) {
  const points = element.geometry?.points || [element.bbox.x, element.bbox.y, element.bbox.x + element.bbox.width, element.bbox.y];
  const [rawX0, rawY0, rawX1, rawY1] = points;
  const x0 = rawX0 * scale;
  const y0 = pageHeight - rawY0 * scale;
  const x1 = rawX1 * scale;
  const y1 = pageHeight - rawY1 * scale;
  return `
      <Shape ID="${id}" NameU="Dynamic connector.${id}" Name="Dynamic connector.${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
        <XForm1D><BeginX>${x0.toFixed(4)}</BeginX><BeginY>${y0.toFixed(4)}</BeginY><EndX>${x1.toFixed(4)}</EndX><EndY>${y1.toFixed(4)}</EndY></XForm1D>
        <Line><LineWeight>0.0139</LineWeight><LineColor>0</LineColor><LinePattern>1</LinePattern><EndArrow>4</EndArrow><EndArrowSize>2</EndArrowSize></Line>
        <Geom IX="0"><NoFill>1</NoFill><NoLine>0</NoLine><NoShow>0</NoShow><NoSnap>0</NoSnap><MoveTo IX="1"><X>0</X><Y>0</Y></MoveTo><LineTo IX="2"><X>${((rawX1 - rawX0) * scale).toFixed(4)}</X><Y>${((rawY0 - rawY1) * scale).toFixed(4)}</Y></LineTo></Geom>
        <Text>${escapeXml(element.content)}</Text>
      </Shape>`;
}

export function exportVisioVdx(result: AnalysisResult) {
  const diagram = result.elements.filter((item) => item.type === "diagram-shape" || item.type === "diagram-connector");
  const scale = 9.5 / Math.max(result.width, 1);
  const pageWidth = Math.max(10, result.width * scale + 0.5);
  const pageHeight = Math.max(7.5, result.height * scale + 0.5);
  const shapesXml = diagram
    .map((element, index) =>
      element.type === "diagram-connector"
        ? visioConnectorXml(element, index + 1, pageHeight, scale)
        : visioShapeXml(element, index + 1, pageHeight, scale),
    )
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VisioDocument xmlns="http://schemas.microsoft.com/visio/2003/core" xmlns:vx="http://schemas.microsoft.com/visio/2006/extension" start="1" metric="0" DocLangID="2052" version="14.0">
  <DocumentProperties><Creator>DocVision Studio</Creator><Title>${escapeXml(result.fileName)}</Title><Description>图片框图自动重建，可在 Microsoft Visio 中继续编辑。</Description><TimeCreated>2026-07-10T00:00:00</TimeCreated><TimeSaved>2026-07-10T00:00:00</TimeSaved></DocumentProperties>
  <Colors><ColorEntry IX="0" RGB="#000000"/><ColorEntry IX="1" RGB="#FFFFFF"/><ColorEntry IX="2" RGB="#2457D6"/></Colors>
  <StyleSheets>
    <StyleSheet ID="0" NameU="No Style" Name="No Style"><Line><LineWeight>0.0139</LineWeight><LineColor>0</LineColor><LinePattern>1</LinePattern></Line><Fill><FillForegnd>1</FillForegnd><FillPattern>1</FillPattern></Fill><TextBlock><VerticalAlign>1</VerticalAlign><DefaultTabStop>0.5906</DefaultTabStop></TextBlock><Char IX="0"><Font>0</Font><Size>0.1389</Size><Color>0</Color></Char><Para IX="0"><HorzAlign>1</HorzAlign></Para></StyleSheet>
  </StyleSheets>
  <Pages>
    <Page ID="0" NameU="Page-1" Name="重构框图" Background="0" ViewScale="1" ViewCenterX="${(pageWidth / 2).toFixed(4)}" ViewCenterY="${(pageHeight / 2).toFixed(4)}">
      <PageSheet LineStyle="0" FillStyle="0" TextStyle="0"><PageProps><PageWidth>${pageWidth.toFixed(4)}</PageWidth><PageHeight>${pageHeight.toFixed(4)}</PageHeight><ShdwOffsetX>0.1181</ShdwOffsetX><ShdwOffsetY>-0.1181</ShdwOffsetY><PageScale>1</PageScale><DrawingScale>1</DrawingScale><DrawingSizeType>3</DrawingSizeType><DrawingScaleType>0</DrawingScaleType><InhibitSnap>0</InhibitSnap><UIVisibility>0</UIVisibility></PageProps></PageSheet>
      <Shapes>${shapesXml}
      </Shapes>
    </Page>
  </Pages>
</VisioDocument>`;
  downloadBlob(new Blob([xml], { type: "application/vnd.visio+xml;charset=utf-8" }), `${safeBaseName(result.fileName)}-可编辑框图.vdx`);
}

export function exportDiagramSvg(result: AnalysisResult) {
  const diagram = result.elements.filter((item) => item.type === "diagram-shape" || item.type === "diagram-connector");
  const parts = diagram.map((element) => {
    if (element.type === "diagram-connector") {
      const [x0, y0, x1, y1] = element.geometry?.points || [element.bbox.x, element.bbox.y, element.bbox.x + element.bbox.width, element.bbox.y];
      return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#637083" stroke-width="3" marker-end="url(#arrow)"/>`;
    }
    const { x, y, width, height } = element.bbox;
    return `<g><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" fill="#fff" stroke="#7c4dff" stroke-width="3"/><text x="${x + width / 2}" y="${y + height / 2}" font-family="Microsoft YaHei,Arial" font-size="${Math.max(14, Math.min(28, height * 0.25))}" text-anchor="middle" dominant-baseline="middle" fill="#172033">${escapeXml(element.content)}</text></g>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${result.width}" height="${result.height}" viewBox="0 0 ${result.width} ${result.height}"><defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="#637083"/></marker></defs><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`;
  downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${safeBaseName(result.fileName)}-可编辑框图.svg`);
}
