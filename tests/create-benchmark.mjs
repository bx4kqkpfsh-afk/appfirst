import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.env.FONTCONFIG_FILE ??= fileURLToPath(new URL("./fonts.conf", import.meta.url));
const { default: sharp } = await import("sharp");

const outputPath =
  process.argv[2] ||
  fileURLToPath(new URL("./fixtures/docvision-benchmark.png", import.meta.url));
const expected = {
  text: [
    "文档智能识别测试报告",
    "Document Vision Accuracy Test",
    "系统输入经过特征提取后生成可编辑输出",
    "The reconstructed result keeps every element editable.",
  ],
  formula: "Score(dx, dy) = SUM F_ir(x,y) * F_sat(x+dx,y+dy)",
  diagramLabels: ["图像输入", "特征提取", "可编辑输出"],
  diagramShapes: 3,
  diagramConnectors: 2,
};

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
  <defs>
    <style>
      .zh { font-family: "Noto Sans SC Thin", sans-serif; }
      .en { font-family: Arial, sans-serif; }
    </style>
    <marker id="arrow" markerWidth="14" markerHeight="10" refX="12" refY="5" orient="auto">
      <path d="M0,0 L14,5 L0,10 Z" fill="#172033"/>
    </marker>
  </defs>
  <rect width="1600" height="1000" fill="#ffffff"/>
  <rect x="40" y="40" width="1520" height="920" rx="8" fill="none" stroke="#d6dde8" stroke-width="2"/>
  <text x="110" y="140" class="zh" font-size="54" fill="#172033">文档智能识别测试报告</text>
  <text x="110" y="202" class="en" font-size="34" fill="#42526a">Document Vision Accuracy Test</text>
  <line x1="110" y1="240" x2="1490" y2="240" stroke="#cbd4e1" stroke-width="2"/>

  <text x="110" y="320" class="zh" font-size="36" fill="#172033">系统输入经过特征提取后生成可编辑输出</text>
  <text x="110" y="392" class="en" font-size="29" fill="#45556d">The reconstructed result keeps every element editable.</text>

  <rect x="110" y="445" width="1380" height="120" rx="8" fill="#f5f8fc" stroke="#cfd8e6" stroke-width="2"/>
  <text x="155" y="520" class="en" font-family="serif" font-size="38" font-style="italic" fill="#172033">Score(dx, dy) = SUM F_ir(x,y) * F_sat(x+dx,y+dy)</text>

  <text x="110" y="645" class="zh" font-size="28" fill="#637083">系统框图 / Editable system diagram</text>
  <g fill="#ffffff" stroke="#172033" stroke-width="4">
    <rect x="120" y="705" width="310" height="120"/>
    <rect x="645" y="705" width="310" height="120"/>
    <rect x="1170" y="705" width="310" height="120"/>
  </g>
  <g class="zh" font-size="34" fill="#172033" text-anchor="middle">
    <text x="275" y="780">图像输入</text>
    <text x="800" y="780">特征提取</text>
    <text x="1325" y="780">可编辑输出</text>
  </g>
  <g fill="none" stroke="#172033" stroke-width="5" marker-end="url(#arrow)">
    <line x1="430" y1="765" x2="645" y2="765"/>
    <line x1="955" y1="765" x2="1170" y2="765"/>
  </g>
  <text x="110" y="910" class="en" font-size="22" fill="#7a8798">Ground truth: 4 text lines · 1 formula · 3 nodes · 2 connectors</text>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(outputPath);
await writeFile(`${outputPath}.ground-truth.json`, JSON.stringify(expected, null, 2));
console.log(outputPath);
