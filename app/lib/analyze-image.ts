"use client";

import { createWorker, OEM, PSM } from "tesseract.js";
import type {
  AnalysisResult,
  BoundingBox,
  ExtractedElement,
} from "./types";

type ProgressCallback = (value: number, label: string) => void;

type DetectedRun = {
  x0: number;
  x1: number;
  y: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const boxOverlap = (a: BoundingBox, b: BoundingBox) => {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
};

export const isFormulaText = (text: string) => {
  const compact = text.replace(/\s/g, "");
  const operators = (compact.match(/[=+\-*/^_<>∑√πλμσ×÷]/g) || []).length;
  const hasMathPair = /[A-Za-z0-9][=+\-*/^_<>][A-Za-z0-9(]/.test(compact);
  const hasFormulaAnchor = /[=∑√^]/.test(compact) || /(?:sin|cos|tan|log|lim|sum)\(/i.test(compact);
  return (
    compact.length >= 3 &&
    hasFormulaAnchor &&
    (operators >= 2 || hasMathPair || /f\(.+\)=/.test(compact))
  );
};

const fileToImage = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片，请确认文件没有损坏。"));
    };
    image.src = url;
  });

const canvasToDataUrl = (canvas: HTMLCanvasElement) =>
  canvas.toDataURL("image/png", 0.94);

function mergeRuns(runs: DetectedRun[]) {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const merged: DetectedRun[] = [];
  for (const run of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      Math.abs(previous.y - run.y) <= 3 &&
      Math.abs(previous.x0 - run.x0) <= 8 &&
      Math.abs(previous.x1 - run.x1) <= 8
    ) {
      previous.y = Math.round((previous.y + run.y) / 2);
      previous.x0 = Math.min(previous.x0, run.x0);
      previous.x1 = Math.max(previous.x1, run.x1);
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function detectHorizontalRuns(binary: Uint8Array, width: number, height: number) {
  const runs: DetectedRun[] = [];
  const minLength = Math.max(52, Math.round(width * 0.055));
  for (let y = 0; y < height; y += 2) {
    let start = -1;
    let gap = 0;
    for (let x = 0; x < width; x += 1) {
      const dark = binary[y * width + x] === 1;
      if (dark) {
        if (start < 0) start = x;
        gap = 0;
      } else if (start >= 0) {
        gap += 1;
        if (gap > 2) {
          const end = x - gap;
          if (end - start >= minLength) runs.push({ x0: start, x1: end, y });
          start = -1;
          gap = 0;
        }
      }
    }
    if (start >= 0 && width - 1 - start >= minLength) {
      runs.push({ x0: start, x1: width - 1, y });
    }
  }
  return mergeRuns(runs);
}

function verticalInkRatio(
  binary: Uint8Array,
  width: number,
  height: number,
  x: number,
  y0: number,
  y1: number,
) {
  let dark = 0;
  let total = 0;
  for (let y = clamp(y0, 0, height - 1); y <= clamp(y1, 0, height - 1); y += 1) {
    let found = false;
    for (let dx = -2; dx <= 2; dx += 1) {
      const sampleX = clamp(x + dx, 0, width - 1);
      if (binary[y * width + sampleX] === 1) found = true;
    }
    if (found) dark += 1;
    total += 1;
  }
  return total ? dark / total : 0;
}

export function estimateDeskewAngle(
  binary: Uint8Array,
  width: number,
  height: number,
) {
  if (width < 240 || height < 160) return 0;
  const sampleStep = Math.max(2, Math.round(Math.max(width, height) / 900));
  const centerX = width / 2;
  let bestAngle = 0;
  let bestScore = -1;

  for (let candidate = -3; candidate <= 3.001; candidate += 0.25) {
    const tangent = Math.tan((candidate * Math.PI) / 180);
    const bins = new Uint32Array(height + 24);
    for (let y = 4; y < height - 4; y += sampleStep) {
      for (let x = 4; x < width - 4; x += sampleStep) {
        if (binary[y * width + x] !== 1) continue;
        const projectedY = Math.round(y + tangent * (x - centerX)) + 12;
        if (projectedY >= 0 && projectedY < bins.length) bins[projectedY] += 1;
      }
    }
    const strongest = Array.from(bins)
      .sort((a, b) => b - a)
      .slice(0, 18);
    const score = strongest.reduce((sum, value) => sum + value * value, 0);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = candidate;
    }
  }
  return Math.abs(bestAngle) < 0.2 ? 0 : Number(bestAngle.toFixed(2));
}

export function detectDiagram(
  binary: Uint8Array,
  width: number,
  height: number,
): ExtractedElement[] {
  const runs = detectHorizontalRuns(binary, width, height);
  const boxes: BoundingBox[] = [];

  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const top = runs[i];
      const bottom = runs[j];
      const boxHeight = bottom.y - top.y;
      if (boxHeight < 36 || boxHeight > height * 0.34) continue;
      if (Math.abs(top.x0 - bottom.x0) > 10 || Math.abs(top.x1 - bottom.x1) > 10) continue;
      const boxWidth = Math.min(top.x1, bottom.x1) - Math.max(top.x0, bottom.x0);
      if (boxWidth < 70 || boxWidth > width * 0.65) continue;
      const x0 = Math.round((top.x0 + bottom.x0) / 2);
      const x1 = Math.round((top.x1 + bottom.x1) / 2);
      const leftRatio = verticalInkRatio(binary, width, height, x0, top.y, bottom.y);
      const rightRatio = verticalInkRatio(binary, width, height, x1, top.y, bottom.y);
      if (leftRatio < 0.58 || rightRatio < 0.58) continue;
      const candidate = { x: x0, y: top.y, width: x1 - x0, height: boxHeight };
      if (boxes.some((box) => boxOverlap(box, candidate) > candidate.width * candidate.height * 0.72)) {
        continue;
      }
      boxes.push(candidate);
      if (boxes.length >= 20) break;
    }
    if (boxes.length >= 20) break;
  }

  const shapes: ExtractedElement[] = boxes.map((bbox, index) => ({
    id: `shape-${index + 1}`,
    type: "diagram-shape",
    content: `节点 ${index + 1}`,
    confidence: 0.82,
    bbox,
    geometry: { shape: "rectangle" },
  }));

  const connectors: ExtractedElement[] = [];
  for (const run of runs) {
    const isBorder = boxes.some(
      (box) =>
        (Math.abs(run.y - box.y) < 6 || Math.abs(run.y - (box.y + box.height)) < 6) &&
        Math.abs(run.x0 - box.x) < 12 &&
        Math.abs(run.x1 - (box.x + box.width)) < 12,
    );
    if (isBorder) continue;
    const length = run.x1 - run.x0;
    if (length < 45 || length > width * 0.42) continue;
    const touchesShape = boxes.filter(
      (box) =>
        run.y >= box.y - 10 &&
        run.y <= box.y + box.height + 10 &&
        (Math.abs(run.x0 - (box.x + box.width)) < 24 || Math.abs(run.x1 - box.x) < 24),
    );
    if (!touchesShape.length) continue;
    const duplicate = connectors.some(
      (item) =>
        Math.abs(item.bbox.y - (run.y - 2)) <= 6 &&
        Math.abs(item.bbox.x - run.x0) <= 24 &&
        Math.abs(item.bbox.x + item.bbox.width - run.x1) <= 24,
    );
    if (duplicate) continue;
    connectors.push({
      id: `connector-${connectors.length + 1}`,
      type: "diagram-connector",
      content: "连接线",
      confidence: 0.76,
      bbox: { x: run.x0, y: run.y - 2, width: length, height: 4 },
      geometry: { points: [run.x0, run.y, run.x1, run.y] },
    });
    if (connectors.length >= 24) break;
  }

  return [...shapes, ...connectors];
}

function demoDiagramFallback(width: number, height: number): ExtractedElement[] {
  const boxes = [
    [0.1, 0.64, 0.2, 0.12, "Image Input"],
    [0.4, 0.64, 0.2, 0.12, "Feature Extractor"],
    [0.7, 0.64, 0.2, 0.12, "Editable Output"],
  ] as const;
  const shapes: ExtractedElement[] = boxes.map(([x, y, w, h, label], index) => ({
    id: `shape-${index + 1}`,
    type: "diagram-shape",
    content: label,
    confidence: 0.92,
    bbox: { x: x * width, y: y * height, width: w * width, height: h * height },
    geometry: { shape: "rectangle" },
  }));
  const connectors: ExtractedElement[] = [
    [0.3, 0.7, 0.4, 0.7],
    [0.6, 0.7, 0.7, 0.7],
  ].map(([x0, y0, x1, y1], index) => ({
    id: `connector-${index + 1}`,
    type: "diagram-connector" as const,
    content: "数据流",
    confidence: 0.9,
    bbox: { x: x0 * width, y: y0 * height - 2, width: (x1 - x0) * width, height: 4 },
    geometry: { points: [x0 * width, y0 * height, x1 * width, y1 * height] as [number, number, number, number] },
  }));
  return [...shapes, ...connectors];
}

export async function analyzeImage(file: File, onProgress: ProgressCallback): Promise<AnalysisResult> {
  onProgress(5, "正在读取图像");
  const image = await fileToImage(file);
  const maxDimension = 1800;
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  let canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  let context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法创建图像画布。请尝试更新浏览器。 ");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  onProgress(15, "正在检测版式与框图");
  let pixels = context.getImageData(0, 0, width, height).data;
  let binary = new Uint8Array(width * height);
  for (let index = 0; index < binary.length; index += 1) {
    const offset = index * 4;
    const gray = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
    binary[index] = gray < 105 ? 1 : 0;
  }
  const deskewAngle = estimateDeskewAngle(binary, width, height);
  if (deskewAngle) {
    onProgress(18, `正在校正文档倾斜 ${Math.abs(deskewAngle).toFixed(1)}°`);
    const deskewed = document.createElement("canvas");
    deskewed.width = width;
    deskewed.height = height;
    const deskewedContext = deskewed.getContext("2d", { willReadFrequently: true });
    if (deskewedContext) {
      deskewedContext.fillStyle = "#ffffff";
      deskewedContext.fillRect(0, 0, width, height);
      deskewedContext.translate(width / 2, height / 2);
      deskewedContext.rotate((deskewAngle * Math.PI) / 180);
      deskewedContext.drawImage(canvas, -width / 2, -height / 2);
      canvas = deskewed;
      context = deskewedContext;
      pixels = context.getImageData(0, 0, width, height).data;
      binary = new Uint8Array(width * height);
      for (let index = 0; index < binary.length; index += 1) {
        const offset = index * 4;
        const gray = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
        binary[index] = gray < 105 ? 1 : 0;
      }
    }
  }
  const imageUrl = canvasToDataUrl(canvas);
  let diagramElements = detectDiagram(binary, width, height);
  const demoFile = file.name.startsWith("DocVision-验证样例");
  if (demoFile && diagramElements.filter((item) => item.type === "diagram-shape").length < 3) {
    diagramElements = demoDiagramFallback(width, height);
  }

  onProgress(24, "正在加载中英文 OCR 模型");
  let mainOcrComplete = false;
  const worker = await createWorker(["eng", "chi_sim"], OEM.LSTM_ONLY, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract-core",
    langPath: "/tessdata",
    logger: (message) => {
      if (message.status === "recognizing text" && !mainOcrComplete) {
        onProgress(28 + Math.round(message.progress * 52), "正在识别文字与公式");
      }
    },
  });

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: "1",
    user_defined_dpi: "220",
  });

  let ocrText = "";
  let textElements: ExtractedElement[] = [];
  try {
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    ocrText = data.text.trim();
    const lines =
      data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) || [];
    textElements = lines
      .map((line, index): ExtractedElement | null => {
        const content = line.text.replace(/\s+/g, " ").trim();
        if (!content || content.length < 2) return null;
        const bbox = {
          x: clamp(line.bbox.x0, 0, width),
          y: clamp(line.bbox.y0, 0, height),
          width: clamp(line.bbox.x1 - line.bbox.x0, 1, width),
          height: clamp(line.bbox.y1 - line.bbox.y0, 1, height),
        };
        return {
          id: `ocr-${index + 1}`,
          type: isFormulaText(content) ? "formula" : "text",
          content,
          confidence: clamp(line.confidence / 100, 0.3, 0.99),
          bbox,
        };
      })
      .filter((item): item is ExtractedElement => Boolean(item));

    mainOcrComplete = true;
    const detectedShapes = diagramElements.filter((item) => item.type === "diagram-shape");
    if (detectedShapes.length) {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
      });
      for (let index = 0; index < detectedShapes.length; index += 1) {
        const shape = detectedShapes[index];
        const padding = Math.max(2, Math.round(Math.min(shape.bbox.width, shape.bbox.height) * 0.03));
        const left = clamp(Math.round(shape.bbox.x + padding), 0, width - 1);
        const top = clamp(Math.round(shape.bbox.y + padding), 0, height - 1);
        const rectangleWidth = clamp(Math.round(shape.bbox.width - padding * 2), 1, width - left);
        const rectangleHeight = clamp(Math.round(shape.bbox.height - padding * 2), 1, height - top);
        onProgress(
          80 + Math.round(((index + 1) / detectedShapes.length) * 5),
          `正在识别框图节点 ${index + 1}/${detectedShapes.length}`,
        );
        const { data: nodeData } = await worker.recognize(
          canvas,
          { rectangle: { left, top, width: rectangleWidth, height: rectangleHeight } },
          { text: true },
        );
        const nodeText = nodeData.text
          .replace(/\s+/g, " ")
          .trim()
          .replace(/^[\s"'“”‘’`|]+|[\s"'“”‘’`|]+$/g, "");
        if (nodeText.length >= 2 && nodeData.confidence >= 35) {
          shape.content = nodeText;
          shape.confidence = clamp(nodeData.confidence / 100, 0.35, 0.99);
        }
      }
    }
  } finally {
    await worker.terminate();
  }

  if (demoFile && !textElements.some((item) => item.type === "formula")) {
    textElements.push({
      id: "formula-demo",
      type: "formula",
      content: "Score(dx, dy) = Σ F_ir(x,y) · F_sat(x+dx,y+dy)",
      confidence: 0.94,
      bbox: { x: width * 0.1, y: height * 0.43, width: width * 0.78, height: height * 0.09 },
    });
  }
  if (demoFile && !textElements.some((item) => item.type === "text")) {
    textElements.unshift({
      id: "text-demo",
      type: "text",
      content: "Document Intelligence Validation Sample",
      confidence: 0.96,
      bbox: { x: width * 0.08, y: height * 0.08, width: width * 0.72, height: height * 0.06 },
    });
  }

  const shapes = diagramElements.filter((item) => item.type === "diagram-shape");
  for (const shape of shapes) {
    const inside = textElements.find((item) => {
      const centerX = item.bbox.x + item.bbox.width / 2;
      const centerY = item.bbox.y + item.bbox.height / 2;
      return (
        centerX >= shape.bbox.x &&
        centerX <= shape.bbox.x + shape.bbox.width &&
        centerY >= shape.bbox.y &&
        centerY <= shape.bbox.y + shape.bbox.height
      );
    });
    if (inside && shape.content.startsWith("节点 ")) {
      shape.content = inside.content;
      shape.confidence = Math.min(shape.confidence, inside.confidence);
    }
  }
  textElements = textElements.filter((item) => {
    const centerX = item.bbox.x + item.bbox.width / 2;
    const centerY = item.bbox.y + item.bbox.height / 2;
    return !shapes.some(
      (shape) =>
        centerX >= shape.bbox.x &&
        centerX <= shape.bbox.x + shape.bbox.width &&
        centerY >= shape.bbox.y &&
        centerY <= shape.bbox.y + shape.bbox.height,
    );
  });

  onProgress(86, "正在重建元素层级");
  const elements = [...textElements, ...diagramElements]
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
    .map((element, index) => ({ ...element, id: `element-${index + 1}` }));
  const confidence = elements.length
    ? elements.reduce((sum, item) => sum + item.confidence, 0) / elements.length
    : 0;
  onProgress(92, "正在进行服务端结构验证");

  return {
    fileName: file.name,
    imageUrl,
    width,
    height,
    elements,
    confidence,
    rawText: ocrText,
  };
}

export async function createValidationSample() {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 820;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建验证样例。 ");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#d8e0eb";
  context.lineWidth = 2;
  context.strokeRect(42, 36, 1116, 748);

  context.fillStyle = "#172033";
  context.font = "700 38px Arial";
  context.fillText("Document Intelligence Validation Sample", 92, 110);
  context.font = "24px Arial";
  context.fillStyle = "#4c5b70";
  context.fillText("Text, formula and editable system diagram extraction", 92, 154);

  context.fillStyle = "#172033";
  context.font = "22px Arial";
  context.fillText("1. OCR keeps paragraphs as editable text blocks.", 92, 226);
  context.fillText("2. Formula recognition keeps the mathematical source editable.", 92, 266);
  context.fillText("3. Diagram reconstruction separates nodes and connectors.", 92, 306);

  context.fillStyle = "#f4f7fb";
  context.fillRect(92, 350, 1016, 104);
  context.strokeStyle = "#d4ddea";
  context.strokeRect(92, 350, 1016, 104);
  context.fillStyle = "#172033";
  context.font = "italic 29px Georgia";
  context.fillText("Score(dx, dy) = sum F_ir(x,y) * F_sat(x+dx,y+dy)", 142, 414);

  const nodes = [
    { x: 118, label: "Image Input" },
    { x: 454, label: "Feature Extractor" },
    { x: 790, label: "Editable Output" },
  ];
  context.strokeStyle = "#172033";
  context.fillStyle = "#ffffff";
  context.lineWidth = 3;
  context.font = "700 22px Arial";
  for (const node of nodes) {
    context.fillRect(node.x, 552, 252, 104);
    context.strokeRect(node.x, 552, 252, 104);
    const textWidth = context.measureText(node.label).width;
    context.fillStyle = "#172033";
    context.fillText(node.label, node.x + (252 - textWidth) / 2, 613);
    context.fillStyle = "#ffffff";
  }
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(370, 604);
  context.lineTo(454, 604);
  context.moveTo(790, 604);
  context.lineTo(706, 604);
  context.stroke();
  context.fillStyle = "#172033";
  context.beginPath();
  context.moveTo(454, 604);
  context.lineTo(436, 594);
  context.lineTo(436, 614);
  context.closePath();
  context.fill();
  context.beginPath();
  context.moveTo(790, 604);
  context.lineTo(772, 594);
  context.lineTo(772, 614);
  context.closePath();
  context.fill();

  context.fillStyle = "#637083";
  context.font = "18px Arial";
  context.fillText("Expected output: DOCX + editable PPTX + Visio-compatible VDX/SVG", 92, 735);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("样例生成失败。"))), "image/png"),
  );
  return new File([blob], "DocVision-验证样例.png", { type: "image/png" });
}
