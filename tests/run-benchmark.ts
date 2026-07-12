import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createWorker, OEM, PSM } from "tesseract.js";
import {
  detectDiagram,
  estimateDeskewAngle,
  isFormulaText,
} from "../app/lib/analyze-image.ts";

const inputPath =
  process.argv[2] ||
  fileURLToPath(new URL("./fixtures/docvision-benchmark-tilted.jpg", import.meta.url));
const truthPath = `${inputPath}.ground-truth.json`;
const outputPath =
  process.argv[3] ||
  fileURLToPath(new URL("./artifacts/docvision-benchmark-final-results.json", import.meta.url));

const truth = JSON.parse(await readFile(truthPath, "utf8")) as {
  text: string[];
  formula: string;
  diagramLabels: string[];
  diagramShapes: number;
  diagramConnectors: number;
};

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}=+*()_,.-]/gu, "");

function editDistance(a: string, b: string) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function similarity(expected: string, actual: string) {
  const left = normalize(expected);
  const right = normalize(actual);
  if (!left.length && !right.length) return 1;
  return Math.max(0, 1 - editDistance(left, right) / Math.max(left.length, right.length, 1));
}

const initial = await sharp(inputPath)
  .flatten({ background: "#ffffff" })
  .greyscale()
  .raw()
  .toBuffer({ resolveWithObject: true });
const initialBinary = new Uint8Array(initial.info.width * initial.info.height);
for (let index = 0; index < initialBinary.length; index += 1) {
  initialBinary[index] = initial.data[index] < 105 ? 1 : 0;
}
const deskewAngle = estimateDeskewAngle(initialBinary, initial.info.width, initial.info.height);
const workingInput = deskewAngle
  ? await sharp(inputPath).rotate(deskewAngle, { background: "#ffffff" }).png().toBuffer()
  : inputPath;
const { data, info } = await sharp(workingInput)
  .flatten({ background: "#ffffff" })
  .greyscale()
  .raw()
  .toBuffer({ resolveWithObject: true });
const binary = new Uint8Array(info.width * info.height);
for (let index = 0; index < binary.length; index += 1) binary[index] = data[index] < 105 ? 1 : 0;
const diagram = detectDiagram(binary, info.width, info.height);

const worker = await createWorker(["eng", "chi_sim"], OEM.LSTM_ONLY, {
  langPath: fileURLToPath(new URL("../public/tessdata", import.meta.url)),
  logger: (message) => {
    if (message.status === "recognizing text") {
      process.stdout.write(`OCR ${Math.round(message.progress * 100)}%\r`);
    }
  },
});
await worker.setParameters({
  tessedit_pageseg_mode: (process.env.BENCHMARK_PSM || PSM.AUTO) as PSM,
  preserve_interword_spaces: "1",
  user_defined_dpi: "220",
});
const { data: ocr } = await worker.recognize(workingInput, {}, { text: true, blocks: true });

const lines =
  ocr.blocks
    ?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines))
    .map((line) => ({
      text: line.text.replace(/\s+/g, " ").trim(),
      confidence: line.confidence,
      bbox: {
        x: line.bbox.x0,
        y: line.bbox.y0,
        width: line.bbox.x1 - line.bbox.x0,
        height: line.bbox.y1 - line.bbox.y0,
      },
    }))
    .filter((line) => line.text.length > 1) || [];

const detectedShapes = diagram.filter((item) => item.type === "diagram-shape");
await worker.setParameters({
  tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
  preserve_interword_spaces: "1",
});
const nodeLabels: Array<{ text: string; confidence: number }> = [];
for (const shape of detectedShapes) {
  const padding = Math.max(2, Math.round(Math.min(shape.bbox.width, shape.bbox.height) * 0.03));
  const { data: nodeData } = await worker.recognize(
    workingInput,
    {
      rectangle: {
        left: Math.round(shape.bbox.x + padding),
        top: Math.round(shape.bbox.y + padding),
        width: Math.max(1, Math.round(shape.bbox.width - padding * 2)),
        height: Math.max(1, Math.round(shape.bbox.height - padding * 2)),
      },
    },
    { text: true },
  );
  nodeLabels.push({
    text: nodeData.text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[\s"'“”‘’`|]+|[\s"'“”‘’`|]+$/g, ""),
    confidence: nodeData.confidence,
  });
}
await worker.terminate();

const textMatches = truth.text.map((expected) => {
  const candidates = lines.map((line) => ({
    actual: line.text,
    confidence: line.confidence,
    accuracy: similarity(expected, line.text),
  }));
  candidates.sort((a, b) => b.accuracy - a.accuracy);
  return { expected, ...(candidates[0] || { actual: "", confidence: 0, accuracy: 0 }) };
});
const formulaCandidates = lines.filter((line) => isFormulaText(line.text));
const rankedFormula = lines
  .map((line) => ({ actual: line.text, confidence: line.confidence, accuracy: similarity(truth.formula, line.text) }))
  .sort((a, b) => b.accuracy - a.accuracy)[0] || { actual: "", confidence: 0, accuracy: 0 };
const shapeCount = diagram.filter((item) => item.type === "diagram-shape").length;
const connectorCount = diagram.filter((item) => item.type === "diagram-connector").length;
const textAccuracy = textMatches.reduce((sum, item) => sum + item.accuracy, 0) / Math.max(textMatches.length, 1);
const nodeLabelMatches = truth.diagramLabels.map((expected) => {
  const ranked = nodeLabels
    .map((item) => ({ ...item, accuracy: similarity(expected, item.text) }))
    .sort((a, b) => b.accuracy - a.accuracy);
  return { expected, ...(ranked[0] || { text: "", confidence: 0, accuracy: 0 }) };
});
const nodeLabelAccuracy = nodeLabelMatches.reduce((sum, item) => sum + item.accuracy, 0) / Math.max(nodeLabelMatches.length, 1);
const shapeRecall = Math.min(1, shapeCount / truth.diagramShapes);
const shapePrecision = Math.min(1, truth.diagramShapes / Math.max(shapeCount, 1));
const shapeF1 = (2 * shapeRecall * shapePrecision) / Math.max(shapeRecall + shapePrecision, 1e-9);
const connectorRecall = Math.min(1, connectorCount / truth.diagramConnectors);
const connectorPrecision = Math.min(1, truth.diagramConnectors / Math.max(connectorCount, 1));
const connectorF1 = (2 * connectorRecall * connectorPrecision) / Math.max(connectorRecall + connectorPrecision, 1e-9);
const overallAccuracy =
  textAccuracy * 0.35 +
  rankedFormula.accuracy * 0.2 +
  nodeLabelAccuracy * 0.15 +
  shapeF1 * 0.15 +
  connectorF1 * 0.15;

const report = {
  input: { path: inputPath, width: info.width, height: info.height, deskewAngle },
  metrics: {
    textLineAccuracy: Number((textAccuracy * 100).toFixed(1)),
    formulaCharacterAccuracy: Number((rankedFormula.accuracy * 100).toFixed(1)),
    diagramNodeLabelAccuracy: Number((nodeLabelAccuracy * 100).toFixed(1)),
    diagramShapeF1: Number((shapeF1 * 100).toFixed(1)),
    diagramConnectorF1: Number((connectorF1 * 100).toFixed(1)),
    weightedOverallAccuracy: Number((overallAccuracy * 100).toFixed(1)),
  },
  expected: truth,
  recognized: {
    lines,
    formulaCandidates,
    bestFormula: rankedFormula,
    nodeLabels,
    nodeLabelMatches,
    diagramShapes: shapeCount,
    diagramConnectors: connectorCount,
    diagramElements: diagram,
  },
  textMatches,
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${JSON.stringify(report.metrics)}`);
console.log(outputPath);
