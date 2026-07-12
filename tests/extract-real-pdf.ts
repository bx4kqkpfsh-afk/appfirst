import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import { buildNativePdfElements, extractPdfImageBoxes } from "../app/lib/pdf-native.ts";
import type { DocumentPage, ExtractedElement } from "../app/lib/types.ts";

const input = resolve(process.argv[2]);
const renderedDirectory = resolve(process.argv[3]);
const outputDirectory = resolve(process.argv[4]);
await mkdir(outputDirectory, { recursive: true });
const document = await pdfjs.getDocument({ data: new Uint8Array(await readFile(input)) }).promise;
const pages: DocumentPage[] = [];

for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 2 });
  const [textContent, operatorList] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  const commonObjects = (page as unknown as { commonObjs: { get(name: string): { name?: string } } }).commonObjs;
  const fonts: Record<string, string> = {};
  for (const name of Object.keys(textContent.styles)) {
    try { fonts[name] = commonObjects.get(name)?.name || name; }
    catch { fonts[name] = name; }
  }
  const native = buildNativePdfElements(textContent.items as never[], viewport, fonts, pageNumber);
  const pagePath = resolve(renderedDirectory, `page-${String(pageNumber).padStart(2, "0")}.jpg`);
  for (const element of native) {
    if (element.type !== "formula") continue;
    const left = Math.max(0, Math.min(Math.floor(element.bbox.x - 2), Math.floor(viewport.width) - 1));
    const top = Math.max(0, Math.min(Math.floor(element.bbox.y - 2), Math.floor(viewport.height) - 1));
    const width = Math.max(1, Math.min(Math.ceil(element.bbox.width + 4), Math.floor(viewport.width) - left));
    const height = Math.max(1, Math.min(Math.ceil(element.bbox.height + 4), Math.floor(viewport.height) - top));
    const bytes = await sharp(pagePath).extract({ left, top, width, height }).png().toBuffer();
    element.imageUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  }
  const rawBoxes = extractPdfImageBoxes(
    operatorList as never,
    viewport,
    pdfjs.OPS as unknown as Record<string, number>,
    pdfjs.Util.transform,
  );
  const boxes = rawBoxes.filter((box, index) => !rawBoxes.some((other, otherIndex) =>
    otherIndex < index && Math.abs(other.x - box.x) < 3 && Math.abs(other.y - box.y) < 3 &&
    Math.abs(other.width - box.width) < 3 && Math.abs(other.height - box.height) < 3,
  ));
  const imageElements: ExtractedElement[] = [];
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    const left = Math.max(0, Math.min(Math.floor(box.x), Math.floor(viewport.width) - 1));
    const top = Math.max(0, Math.min(Math.floor(box.y), Math.floor(viewport.height) - 1));
    const width = Math.max(1, Math.min(Math.ceil(box.width), Math.floor(viewport.width) - left));
    const height = Math.max(1, Math.min(Math.ceil(box.height), Math.floor(viewport.height) - top));
    const bytes = await sharp(pagePath).extract({ left, top, width, height }).jpeg({ quality: 88 }).toBuffer();
    imageElements.push({
      id: `page-${pageNumber}-image-${index + 1}`,
      type: "image",
      content: `Page ${pageNumber} image ${index + 1}`,
      confidence: 1,
      bbox: { x: left, y: top, width, height },
      pageNumber,
      imageUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      role: "figure",
      source: "native-pdf",
    });
  }
  const elements = [...native, ...imageElements].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  const pageBytes = await readFile(pagePath);
  pages.push({
    pageNumber,
    imageUrl: `data:image/jpeg;base64,${pageBytes.toString("base64")}`,
    width: Math.round(viewport.width),
    height: Math.round(viewport.height),
    elements,
    rawText: native.map((element) => element.content).join("\n"),
    confidence: 0.99,
  });
  page.cleanup();
  console.log(`page ${pageNumber}/${document.numPages}: ${native.length} text/formula elements, ${imageElements.length} images`);
}
await document.destroy();

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("extract", `${Date.now()}`);
const worker = (await import(workerUrl.href)).default;
const response = await worker.fetch(new Request("http://localhost/api/export", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    format: "word",
    fileName: basename(input),
    pages: pages.map(({ pageNumber, imageUrl, width, height, elements }) => ({ pageNumber, imageUrl, width, height, elements })),
  }),
}), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } });
if (!response.ok) throw new Error(`Word export failed: ${response.status} ${await response.text()}`);
const documentPath = resolve(outputDirectory, "Cross-View-Object-Geo-Localization-editable.docx");
await writeFile(documentPath, new Uint8Array(await response.arrayBuffer()));
await writeFile(
  resolve(outputDirectory, "extraction-model.json"),
  JSON.stringify({
    input: basename(input),
    pages: pages.map(({ pageNumber, width, height, elements }) => ({
      pageNumber, width, height,
      elements: elements.map((element) => Object.fromEntries(
        Object.entries(element).filter(([key]) => key !== "imageUrl"),
      )),
    })),
  }, null, 2),
);
console.log(documentPath);
