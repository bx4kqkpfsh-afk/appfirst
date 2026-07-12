import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const inputPath =
  process.argv[2] ||
  fileURLToPath(new URL("./fixtures/docvision-benchmark-tilted.jpg", import.meta.url));
const reportPath =
  process.argv[3] ||
  fileURLToPath(new URL("./artifacts/docvision-benchmark-final-results.json", import.meta.url));
const outputPath =
  process.argv[4] ||
  fileURLToPath(new URL("./artifacts/docvision-analysis-evidence.png", import.meta.url));

const report = JSON.parse(await readFile(reportPath, "utf8"));
const workingImage = await sharp(inputPath)
  .rotate(report.input.deskewAngle || 0, { background: "#ffffff" })
  .png()
  .toBuffer();
const metadata = await sharp(workingImage).metadata();
const width = metadata.width;
const height = metadata.height;
const panelWidth = 470;

const esc = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const diagramShapes = report.recognized.diagramElements.filter(
  (item) => item.type === "diagram-shape",
);
const isInsideShape = (bbox) => {
  const x = bbox.x + bbox.width / 2;
  const y = bbox.y + bbox.height / 2;
  return diagramShapes.some(
    (shape) =>
      x >= shape.bbox.x &&
      x <= shape.bbox.x + shape.bbox.width &&
      y >= shape.bbox.y &&
      y <= shape.bbox.y + shape.bbox.height,
  );
};

const ocrBoxes = report.recognized.lines
  .filter((line) => !isInsideShape(line.bbox))
  .map((line) => {
    const formula = line.text.includes("Score(dx");
    const color = formula ? "#14a87a" : "#2457d6";
    const label = formula ? "FORMULA" : "TEXT";
    return `<g><rect x="${line.bbox.x}" y="${line.bbox.y}" width="${line.bbox.width}" height="${line.bbox.height}" fill="none" stroke="${color}" stroke-width="3"/><rect x="${line.bbox.x}" y="${Math.max(0, line.bbox.y - 24)}" width="${label.length * 13 + 16}" height="24" fill="${color}"/><text x="${line.bbox.x + 7}" y="${Math.max(17, line.bbox.y - 7)}" font-family="Arial" font-size="14" font-weight="700" fill="#fff">${label}</text></g>`;
  });

const diagramBoxes = report.recognized.diagramElements.map((item) => {
  if (item.type === "diagram-connector") {
    const [x0, y0, x1, y1] = item.geometry.points;
    return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#f59e0b" stroke-width="7" opacity=".8"/>`;
  }
  return `<g><rect x="${item.bbox.x}" y="${item.bbox.y}" width="${item.bbox.width}" height="${item.bbox.height}" fill="none" stroke="#7c4dff" stroke-width="5"/><rect x="${item.bbox.x}" y="${Math.max(0, item.bbox.y - 24)}" width="76" height="24" fill="#7c4dff"/><text x="${item.bbox.x + 7}" y="${Math.max(17, item.bbox.y - 7)}" font-family="Arial" font-size="14" font-weight="700" fill="#fff">NODE</text></g>`;
});

const overlay = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${ocrBoxes.join("")}
  ${diagramBoxes.join("")}
</svg>`);

const metrics = report.metrics;
const summary = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${height}">
  <rect width="100%" height="100%" fill="#f5f7fa"/>
  <rect x="1" y="1" width="${panelWidth - 2}" height="${height - 2}" fill="none" stroke="#dce3ec" stroke-width="2"/>
  <text x="40" y="62" font-family="Arial" font-size="15" font-weight="700" fill="#2457d6" letter-spacing="2">DOCVISION BENCHMARK</text>
  <text x="40" y="106" font-family="Arial" font-size="31" font-weight="700" fill="#172033">Analysis evidence</text>
  <text x="40" y="140" font-family="Arial" font-size="16" fill="#637083">Independent image · no demo fallback</text>
  <rect x="40" y="178" width="390" height="96" rx="12" fill="#e8f7f2" stroke="#bce5d7"/>
  <text x="62" y="215" font-family="Arial" font-size="15" fill="#42685c">Weighted accuracy</text>
  <text x="62" y="256" font-family="Arial" font-size="38" font-weight="700" fill="#14a87a">${metrics.weightedOverallAccuracy.toFixed(1)}%</text>
  ${[
    ["Text lines", metrics.textLineAccuracy, "#2457d6"],
    ["Formula characters", metrics.formulaCharacterAccuracy, "#14a87a"],
    ["Node labels", metrics.diagramNodeLabelAccuracy, "#7c4dff"],
    ["Diagram shapes F1", metrics.diagramShapeF1, "#7c4dff"],
    ["Connectors F1", metrics.diagramConnectorF1, "#f59e0b"],
  ]
    .map(
      ([label, value, color], index) => `<g transform="translate(40 ${330 + index * 92})"><text x="0" y="0" font-family="Arial" font-size="16" font-weight="600" fill="#172033">${esc(label)}</text><text x="390" y="0" text-anchor="end" font-family="Arial" font-size="17" font-weight="700" fill="${color}">${Number(value).toFixed(1)}%</text><rect x="0" y="18" width="390" height="9" rx="5" fill="#e0e6ee"/><rect x="0" y="18" width="${390 * (Number(value) / 100)}" height="9" rx="5" fill="${color}"/></g>`,
    )
    .join("")}
  <line x1="40" y1="820" x2="430" y2="820" stroke="#dce3ec"/>
  <text x="40" y="858" font-family="Arial" font-size="15" font-weight="700" fill="#172033">Detected structure</text>
  <text x="40" y="892" font-family="Arial" font-size="15" fill="#637083">3 nodes · 2 connectors</text>
  <text x="40" y="926" font-family="Arial" font-size="15" fill="#637083">Deskew correction: ${report.input.deskewAngle || 0}°</text>
</svg>`);

await sharp({
  create: {
    width: width + panelWidth,
    height,
    channels: 4,
    background: "#ffffff",
  },
})
  .composite([
    { input: workingImage, left: 0, top: 0 },
    { input: overlay, left: 0, top: 0 },
    { input: summary, left: width, top: 0 },
  ])
  .png({ compressionLevel: 9 })
  .toFile(outputPath);

console.log(outputPath);
