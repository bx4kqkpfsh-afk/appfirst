import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildNativePdfElements, extractPdfImageBoxes } from "../app/lib/pdf-native.ts";

const input = resolve(process.argv[2] || "../upload/Cross-View Object Geo-Localization in a Local Region With Satellite Imagery.pdf");
const output = resolve(process.argv[3] || "../validation/cross-view/native-pdfjs-results.json");
const document = await pdfjs.getDocument({ data: new Uint8Array(await readFile(input)) }).promise;
const pageMetrics = [];
const allElements = [];

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
  const elements = buildNativePdfElements(textContent.items as never[], viewport, fonts, pageNumber);
  const imageBoxes = extractPdfImageBoxes(
    operatorList as never,
    viewport,
    pdfjs.OPS as unknown as Record<string, number>,
    pdfjs.Util.transform,
  );
  const sourceText = textContent.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
  const extractedText = elements.map((element) => element.content).join(" ").replace(/\s+/g, " ").trim();
  pageMetrics.push({
    page: pageNumber,
    sourceCharacters: sourceText.length,
    extractedCharacters: extractedText.length,
    characterCoverage: Math.min(1, extractedText.length / Math.max(1, sourceText.length)),
    paragraphs: elements.filter((element) => element.type === "text").length,
    formulas: elements.filter((element) => element.type === "formula").length,
    imageRegions: imageBoxes.length,
  });
  allElements.push(...elements);
  page.cleanup();
}
await document.destroy();

const combined = allElements.map((element) => element.content).join("\n");
const recognizedEquationNumbers = Array.from({ length: 15 }, (_, index) => index + 1)
  .filter((number) => new RegExp(`\\(\\s*${number}\\s*\\)`).test(combined));
const result = {
  pages: pageMetrics.length,
  totals: {
    sourceCharacters: pageMetrics.reduce((sum, page) => sum + page.sourceCharacters, 0),
    extractedCharacters: pageMetrics.reduce((sum, page) => sum + page.extractedCharacters, 0),
    paragraphs: pageMetrics.reduce((sum, page) => sum + page.paragraphs, 0),
    formulas: pageMetrics.reduce((sum, page) => sum + page.formulas, 0),
    imageRegions: pageMetrics.reduce((sum, page) => sum + page.imageRegions, 0),
    numberedEquationRecall: recognizedEquationNumbers.length / 15,
    recognizedEquationNumbers,
  },
  pageMetrics,
};
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.totals, null, 2));
