import type { ElementKind, ExtractedElement, VerificationCheck } from "../../lib/types";

const allowedKinds = new Set<ElementKind>([
  "text",
  "formula",
  "image",
  "diagram-shape",
  "diagram-connector",
]);

type AnalyzePayload = {
  fileName?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  elements?: ExtractedElement[];
};

const hashPayload = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
};

export async function POST(request: Request) {
  let payload: AnalyzePayload;
  try {
    payload = (await request.json()) as AnalyzePayload;
  } catch {
    return Response.json({ error: "INVALID_JSON", message: "无法读取验证请求。" }, { status: 400 });
  }

  const fileName = String(payload.fileName || "").slice(0, 180);
  const width = Number(payload.width || 0);
  const height = Number(payload.height || 0);
  const fileSize = Number(payload.fileSize || 0);
  const inputElements = Array.isArray(payload.elements) ? payload.elements.slice(0, 500) : [];
  const elements = inputElements.filter(
    (item) =>
      item &&
      typeof item.id === "string" &&
      allowedKinds.has(item.type) &&
      typeof item.content === "string" &&
      Number.isFinite(item.confidence) &&
      item.bbox &&
      [item.bbox.x, item.bbox.y, item.bbox.width, item.bbox.height].every(Number.isFinite),
  );

  if (!fileName || width <= 0 || height <= 0) {
    return Response.json(
      { error: "INVALID_DOCUMENT", message: "文件名或图像尺寸无效。" },
      { status: 422 },
    );
  }

  const outOfBounds = elements.filter(
    (item) =>
      item.bbox.x < 0 ||
      item.bbox.y < 0 ||
      item.bbox.width <= 0 ||
      item.bbox.height <= 0 ||
      item.bbox.x + item.bbox.width > width * 1.02 ||
      item.bbox.y + item.bbox.height > height * 1.02,
  );
  const editableElements = elements.filter((item) => item.type !== "diagram-connector");
  const diagramShapes = elements.filter((item) => item.type === "diagram-shape");
  const connectors = elements.filter((item) => item.type === "diagram-connector");
  const averageConfidence = elements.length
    ? elements.reduce((sum, item) => sum + Math.max(0, Math.min(1, item.confidence)), 0) / elements.length
    : 0;

  const checks: VerificationCheck[] = [
    {
      id: "image-integrity",
      label: "图像完整性",
      passed: width >= 120 && height >= 120 && fileSize <= 50 * 1024 * 1024,
      detail: `${Math.round(width)} × ${Math.round(height)} px · ${Math.max(0.01, fileSize / 1024 / 1024).toFixed(2)} MB`,
    },
    {
      id: "schema",
      label: "元素结构",
      passed: inputElements.length === elements.length && outOfBounds.length === 0,
      detail: `${elements.length} 个元素通过字段与坐标校验`,
    },
    {
      id: "editable",
      label: "可编辑内容",
      passed: editableElements.length > 0,
      detail: `${editableElements.length} 个文字、公式或节点可继续编辑`,
    },
    {
      id: "diagram",
      label: "框图拓扑",
      passed: diagramShapes.length === 0 || connectors.length > 0 || diagramShapes.length === 1,
      detail: `${diagramShapes.length} 个节点 · ${connectors.length} 条连接线`,
    },
  ];
  const score = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        averageConfidence * 72 + (checks.filter((check) => check.passed).length / checks.length) * 28,
      ),
    ) * 10,
  ) / 10;
  const warnings: string[] = [];
  if (!elements.length) warnings.push("尚未识别到可导出的元素，请提高图像清晰度后重试。");
  if (outOfBounds.length) warnings.push(`${outOfBounds.length} 个元素的坐标越界，已标记为需要人工校对。`);
  if (averageConfidence > 0 && averageConfidence < 0.62) warnings.push("平均置信度偏低，建议在导出前校对文字和公式。");
  if (diagramShapes.length > 1 && connectors.length === 0) warnings.push("检测到多个框图节点，但没有可靠连接线，请人工补充拓扑。 ");
  const jobHash = await hashPayload(`${fileName}|${width}|${height}|${fileSize}|${elements.length}`);

  return Response.json({
    jobId: `DV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${jobHash}`,
    score,
    ready: checks.every((check) => check.passed) && elements.length > 0,
    checks,
    warnings,
    counts: {
      text: elements.filter((item) => item.type === "text").length,
      formula: elements.filter((item) => item.type === "formula").length,
      images: elements.filter((item) => item.type === "image").length,
      diagramShapes: diagramShapes.length,
      connectors: connectors.length,
    },
  });
}
