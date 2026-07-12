"use client";

import { analyzeImage } from "./analyze-image";
import { buildNativePdfElements, extractPdfImageBoxes } from "./pdf-native";
import type { AnalysisResult, DocumentPage, ExtractedElement } from "./types";

type ProgressCallback = (value: number, label: string) => void;

const asPage = (result: AnalysisResult, pageNumber: number): DocumentPage => ({
  pageNumber,
  imageUrl: result.imageUrl,
  width: result.width,
  height: result.height,
  elements: result.elements.map((element) => ({
    ...element,
    id: `page-${pageNumber}-${element.id}`,
    pageNumber,
  })),
  rawText: result.rawText,
  confidence: result.confidence,
});

async function renderPdfPages(file: File, onProgress: ProgressCallback) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  if (pdf.numPages > 30) throw new Error("当前版本最多处理 30 页 PDF，请拆分后重试。");

  const pages: DocumentPage[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onProgress(
      3 + Math.round(((pageNumber - 1) / pdf.numPages) * 92),
      `正在渲染并识别 PDF 第 ${pageNumber}/${pdf.numPages} 页`,
    );
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const [textContent, operatorList] = await Promise.all([
      page.getTextContent(),
      page.getOperatorList(),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器无法渲染 PDF 页面。");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const imageUrl = canvas.toDataURL("image/jpeg", 0.88);
    const commonObjects = (page as unknown as { commonObjs: { get(name: string): { name?: string } } }).commonObjs;
    const resolvedFonts: Record<string, string> = {};
    for (const name of Object.keys(textContent.styles)) {
      try { resolvedFonts[name] = commonObjects.get(name)?.name || name; }
      catch { resolvedFonts[name] = name; }
    }
    const nativeElements = buildNativePdfElements(
      textContent.items as never[],
      viewport,
      resolvedFonts,
      pageNumber,
    );
    for (const element of nativeElements) {
      if (element.type !== "formula") continue;
      const crop = document.createElement("canvas");
      const left = Math.max(0, Math.floor(element.bbox.x - 2));
      const top = Math.max(0, Math.floor(element.bbox.y - 2));
      crop.width = Math.max(1, Math.min(canvas.width - left, Math.ceil(element.bbox.width + 4)));
      crop.height = Math.max(1, Math.min(canvas.height - top, Math.ceil(element.bbox.height + 4)));
      crop.getContext("2d")?.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
      element.imageUrl = crop.toDataURL("image/png");
    }
    const nativeCharacters = nativeElements
      .filter((element) => element.type === "text" || element.type === "formula")
      .reduce((sum, element) => sum + element.content.length, 0);

    if (nativeCharacters >= 40) {
      onProgress(5 + Math.round((pageNumber / pdf.numPages) * 88), `第 ${pageNumber} 页 · 正在保留原生段落、公式与图片`);
      const rawBoxes = extractPdfImageBoxes(
        operatorList as never,
        viewport,
        pdfjs.OPS as unknown as Record<string, number>,
        pdfjs.Util.transform,
      );
      const imageBoxes = rawBoxes.filter((box, index) =>
        !rawBoxes.some((other, otherIndex) =>
          otherIndex < index &&
          Math.abs(other.x - box.x) < 3 && Math.abs(other.y - box.y) < 3 &&
          Math.abs(other.width - box.width) < 3 && Math.abs(other.height - box.height) < 3,
        ),
      );
      const imageElements: ExtractedElement[] = imageBoxes.slice(0, 200).map((box, index) => {
        const crop = document.createElement("canvas");
        crop.width = Math.max(1, Math.round(box.width));
        crop.height = Math.max(1, Math.round(box.height));
        crop.getContext("2d")?.drawImage(
          canvas,
          Math.max(0, box.x), Math.max(0, box.y), crop.width, crop.height,
          0, 0, crop.width, crop.height,
        );
        return {
          id: `pdf-${pageNumber}-image-${index + 1}`,
          type: "image",
          content: `第 ${pageNumber} 页图片 ${index + 1}`,
          confidence: 1,
          bbox: box,
          pageNumber,
          imageUrl: crop.toDataURL("image/jpeg", 0.88),
          role: "figure",
          source: "native-pdf",
        };
      });
      const elements = [...nativeElements, ...imageElements]
        .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
        .map((element, index) => ({ ...element, id: `page-${pageNumber}-element-${index + 1}` }));
      pages.push({
        pageNumber,
        imageUrl,
        width: canvas.width,
        height: canvas.height,
        elements,
        rawText: nativeElements.filter((element) => element.type !== "image").map((element) => element.content).join("\n"),
        confidence: elements.length ? elements.reduce((sum, element) => sum + element.confidence, 0) / elements.length : 0,
      });
    } else {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PDF 页面转图像失败。"))), "image/png"),
      );
      const imageFile = new File([blob], `${file.name}-第${pageNumber}页.png`, { type: "image/png" });
      const base = 5 + ((pageNumber - 1) / pdf.numPages) * 88;
      const span = 88 / pdf.numPages;
      const analyzed = await analyzeImage(imageFile, (value, label) =>
        onProgress(Math.min(94, Math.round(base + (value / 100) * span)), `第 ${pageNumber} 页 · ${label}`),
      );
      pages.push(asPage(analyzed, pageNumber));
    }
    page.cleanup();
  }
  await task.destroy();
  return pages;
}

function combinePages(file: File, pages: DocumentPage[], sourceType: "image" | "pdf"): AnalysisResult {
  const first = pages[0];
  const elements: ExtractedElement[] = pages.flatMap((page) => page.elements);
  return {
    fileName: file.name,
    imageUrl: first.imageUrl,
    width: first.width,
    height: first.height,
    elements,
    confidence: elements.length
      ? elements.reduce((sum, element) => sum + element.confidence, 0) / elements.length
      : 0,
    rawText: pages.map((page) => page.rawText).join("\n\n"),
    sourceType,
    pages,
  };
}

export async function analyzeDocument(file: File, onProgress: ProgressCallback): Promise<AnalysisResult> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return combinePages(file, await renderPdfPages(file, onProgress), "pdf");
  }
  const result = await analyzeImage(file, onProgress);
  return combinePages(file, [asPage(result, 1)], "image");
}
