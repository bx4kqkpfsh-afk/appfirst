import type { BoundingBox, ExtractedElement } from "./types";

type TextItem = {
  str: string;
  fontName: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

type ViewportLike = {
  width: number;
  height: number;
  scale: number;
  transform: number[];
  convertToViewportPoint(x: number, y: number): number[];
};

type NativeSpan = {
  text: string;
  fontName: string;
  math: boolean;
  bbox: BoundingBox;
  baseline: number;
  fontSize: number;
};

const MATH_FONT = /CMSY|MTSYN|RMTMI|MSBM|CMEX|SYMBOL|MATH/i;
const DISPLAY_OPERATOR = /[=∑Σ√∫∥≤≥±×÷→↦∈∗^_]|\b(?:min|max|log|ReLU|Conv|BN|Norm)\b/;

const unionBox = (boxes: BoundingBox[]): BoundingBox => {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const textWithSpacing = (spans: NativeSpan[]) => {
  const sorted = [...spans].sort((a, b) => a.bbox.x - b.bbox.x);
  let output = "";
  let previousRight = 0;
  for (const span of sorted) {
    const gap = span.bbox.x - previousRight;
    if (output && gap > Math.max(1.5, span.fontSize * 0.16) && !/\s$/.test(output)) output += " ";
    output += span.text;
    previousRight = Math.max(previousRight, span.bbox.x + span.bbox.width);
  }
  return output.replace(/\s+/g, " ").trim();
};

export function buildNativePdfElements(
  items: TextItem[],
  viewport: ViewportLike,
  resolvedFonts: Record<string, string>,
  pageNumber: number,
): ExtractedElement[] {
  const spans: NativeSpan[] = items
    .filter((item) => item.str && item.str.trim())
    .map((item) => {
      const [x, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      const fontSize = Math.max(4, Math.hypot(item.transform[2], item.transform[3]) * viewport.scale);
      return {
        text: item.str,
        fontName: resolvedFonts[item.fontName] || item.fontName,
        math: MATH_FONT.test(resolvedFonts[item.fontName] || item.fontName),
        bbox: {
          x,
          y: Math.max(0, baseline - fontSize * 0.82),
          width: Math.max(1, item.width * viewport.scale),
          height: fontSize,
        },
        baseline,
        fontSize,
      };
    });

  const lines: NativeSpan[][] = [];
  for (const span of spans.sort((a, b) => a.baseline - b.baseline || a.bbox.x - b.bbox.x)) {
    const line = lines.find((candidate) => {
      const reference = candidate[0];
      return Math.abs(reference.baseline - span.baseline) <= Math.max(2.5, span.fontSize * 0.25);
    });
    if (line) line.push(span);
    else lines.push([span]);
  }

  const segmentedLines = lines.flatMap((line) => {
    const sorted = [...line].sort((a, b) => a.bbox.x - b.bbox.x);
    const segments: NativeSpan[][] = [];
    for (const span of sorted) {
      const current = segments.at(-1);
      const previous = current?.at(-1);
      const gap = previous ? span.bbox.x - (previous.bbox.x + previous.bbox.width) : 0;
      if (!current || gap > Math.max(14, viewport.width * 0.012)) segments.push([span]);
      else current.push(span);
    }
    return segments;
  });

  const lineModels = segmentedLines.map((line) => {
    const content = textWithSpacing(line);
    const bbox = unionBox(line.map((span) => span.bbox));
    const nonSpace = Math.max(1, content.replace(/\s/g, "").length);
    const mathChars = line.filter((span) => span.math).reduce((sum, span) => sum + span.text.replace(/\s/g, "").length, 0);
    const formula = mathChars / nonSpace >= 0.28 && DISPLAY_OPERATOR.test(content);
    const spanFontSizes = line.map((span) => span.fontSize).sort((a, b) => a - b);
    return {
      content,
      bbox,
      formula,
      fontSize: spanFontSizes[Math.floor(spanFontSizes.length / 2)] || 8,
      mathRatio: mathChars / nonSpace,
    };
  }).filter((line) => line.content);

  const medianFont = [...lineModels].sort((a, b) => a.fontSize - b.fontSize)[Math.floor(lineModels.length / 2)]?.fontSize || 10;
  const formulaLines = lineModels.filter((line) => line.formula);
  const textLines = lineModels.filter((line) => !line.formula);
  const elements: ExtractedElement[] = formulaLines.map((line, index) => ({
    id: `pdf-${pageNumber}-formula-${index + 1}`,
    type: "formula",
    content: line.content,
    confidence: 0.98,
    bbox: line.bbox,
    pageNumber,
    role: "equation",
    fontSize: line.fontSize,
    source: "native-pdf",
  }));

  const paragraphs: typeof lineModels[] = [];
  const columns = [
    textLines.filter((line) => line.bbox.width > viewport.width * 0.62),
    textLines.filter((line) => line.bbox.width <= viewport.width * 0.62 && line.bbox.x + line.bbox.width / 2 < viewport.width / 2),
    textLines.filter((line) => line.bbox.width <= viewport.width * 0.62 && line.bbox.x + line.bbox.width / 2 >= viewport.width / 2),
  ];
  for (const columnLines of columns) {
    const sorted = columnLines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const columnLeft = sorted.length ? Math.min(...sorted.map((line) => line.bbox.x)) : 0;
    let candidate: typeof lineModels = [];
    for (const line of sorted) {
      const previous = candidate.at(-1);
      const verticalGap = previous ? line.bbox.y - (previous.bbox.y + previous.bbox.height) : Infinity;
      const startsIndentedParagraph = previous && line.bbox.x - columnLeft > medianFont * 0.65 && previous.bbox.x - columnLeft < medianFont * 0.45;
      const headingBoundary = line.fontSize > medianFont * 1.14 || previous && previous.fontSize > medianFont * 1.14;
      const continuation = previous && verticalGap < medianFont * 1.15 && !startsIndentedParagraph && !headingBoundary;
      if (continuation) candidate.push(line);
      else {
        if (candidate.length) paragraphs.push(candidate);
        candidate = [line];
      }
    }
    if (candidate.length) paragraphs.push(candidate);
  }

  paragraphs.forEach((paragraph, index) => {
    const bbox = unionBox(paragraph.map((line) => line.bbox));
    const content = paragraph.map((line) => line.content).join(" ").replace(/-\s+/g, "");
    const paragraphFontSizes = paragraph.map((line) => line.fontSize).sort((a, b) => a - b);
    const fontSize = paragraphFontSizes[Math.floor(paragraphFontSizes.length / 2)] || medianFont;
    const role = fontSize > medianFont * 1.55 ? "title" : fontSize > medianFont * 1.16 || /^[IVX]+\.\s/.test(content) ? "heading" : /^Fig\.|^TABLE\s/i.test(content) ? "caption" : "paragraph";
    elements.push({
      id: `pdf-${pageNumber}-text-${index + 1}`,
      type: "text",
      content,
      confidence: 0.995,
      bbox,
      pageNumber,
      role,
      fontSize,
      source: "native-pdf",
    });
  });

  return elements.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}

export function extractPdfImageBoxes(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  viewport: ViewportLike,
  ops: Record<string, number>,
  transform: (m1: number[], m2: number[]) => number[],
): BoundingBox[] {
  let ctm = [...viewport.transform];
  const stack: number[][] = [];
  const boxes: BoundingBox[] = [];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] as number[];
    if (fn === ops.save) stack.push([...ctm]);
    else if (fn === ops.restore && stack.length) ctm = stack.pop()!;
    else if (fn === ops.transform) ctm = transform(ctm, args);
    else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
      const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      if (box.width >= 2 && box.height >= 2 && box.width * box.height >= 16) boxes.push(box);
    }
  }
  return boxes;
}
