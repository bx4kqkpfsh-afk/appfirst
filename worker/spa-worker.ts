import JSZip from "jszip";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

type ElementPayload = {
  id?: unknown;
  type?: unknown;
  content?: unknown;
  confidence?: unknown;
  bbox?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  geometry?: { shape?: unknown; points?: unknown };
  pageNumber?: unknown;
  imageUrl?: unknown;
  role?: unknown;
  fontSize?: unknown;
};

const kinds = new Set(["text", "formula", "image", "diagram-shape", "diagram-connector"]);

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function analyze(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "INVALID_JSON", message: "无法读取验证请求。" }, 400);
  }

  const fileName = String(payload.fileName || "").slice(0, 180);
  const width = Number(payload.width || 0);
  const height = Number(payload.height || 0);
  const fileSize = Number(payload.fileSize || 0);
  const input = Array.isArray(payload.elements) ? (payload.elements as ElementPayload[]).slice(0, 3000) : [];
  const inputPages = Array.isArray(payload.pages) ? payload.pages.slice(0, 30) : [];
  if (!fileName || width <= 0 || height <= 0) {
    return json({ error: "INVALID_DOCUMENT", message: "文件名或图像尺寸无效。" }, 422);
  }

  const elements = input.filter((item) => {
    const box = item?.bbox;
    return item && typeof item.id === "string" && kinds.has(String(item.type)) &&
      typeof item.content === "string" && Number.isFinite(item.confidence) && box &&
      [box.x, box.y, box.width, box.height].every(Number.isFinite);
  });
  const normalized = elements
    .map((item, index) => ({
      id: String(item.id || `backend-${index + 1}`),
      type: String(item.type),
      content: String(item.content || "").trim().slice(0, 4000),
      confidence: Math.max(0, Math.min(1, Number(item.confidence))),
      pageNumber: Math.max(1, Math.min(30, Number(item.pageNumber || 1))),
      bbox: {
        x: Number(item.bbox?.x), y: Number(item.bbox?.y),
        width: Number(item.bbox?.width), height: Number(item.bbox?.height),
      },
      geometry: item.geometry,
      role: typeof item.role === "string" ? item.role : undefined,
      fontSize: Number.isFinite(item.fontSize) ? Number(item.fontSize) : undefined,
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber || a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  const shapes = normalized.filter((item) => item.type === "diagram-shape");
  const connectors = normalized.filter((item) => item.type === "diagram-connector");
  const editable = normalized.filter((item) => item.type !== "diagram-connector");
  const average = normalized.length
    ? normalized.reduce((sum, item) => sum + item.confidence, 0) / normalized.length
    : 0;
  const checks = [
    { id: "image-integrity", label: "图像完整性", passed: width >= 120 && height >= 120 && fileSize <= 50 * 1024 * 1024, detail: `${Math.round(width)} × ${Math.round(height)} px` },
    { id: "schema", label: "元素结构", passed: input.length === normalized.length, detail: `${normalized.length} 个元素通过后端标准化` },
    { id: "editable", label: "可编辑内容", passed: editable.length > 0, detail: `${editable.length} 个内容可继续编辑` },
    { id: "diagram", label: "框图拓扑", passed: shapes.length === 0 || connectors.length > 0 || shapes.length === 1, detail: `${shapes.length} 个节点 · ${connectors.length} 条连接线` },
  ];
  const score = Math.round(Math.min(100, average * 72 + checks.filter((item) => item.passed).length * 7) * 10) / 10;
  const modelSource = JSON.stringify({ fileName, width, height, pages: inputPages.length || 1, elements: normalized });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(modelSource));
  const hash = Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return json({
    jobId: `DV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${hash}`,
    score,
    ready: checks.every((item) => item.passed) && normalized.length > 0,
    checks,
    warnings: normalized.length ? [] : ["尚未识别到可导出的元素，请提高图像清晰度后重试。"],
    counts: {
      text: normalized.filter((item) => item.type === "text").length,
      formula: normalized.filter((item) => item.type === "formula").length,
      images: normalized.filter((item) => item.type === "image").length,
      diagramShapes: shapes.length,
      connectors: connectors.length,
    },
    backend: {
      processedAt: new Date().toISOString(),
      pipeline: "cloudflare-worker/document-model-v2",
      pageCount: Math.max(1, inputPages.length),
      modelHash: hash,
      exportFormats: ["docx", "pptx", "vdx", "svg"],
    },
    normalizedElements: normalized,
  });
}

const escapeXml = (value: unknown) => String(value ?? "")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;").replace(/'/g, "&apos;");

function buildVisio(payload: Record<string, unknown>) {
  const fileName = String(payload.fileName || "DocVision");
  const pages = Array.isArray(payload.pages) && payload.pages.length
    ? payload.pages.slice(0, 30) as Array<Record<string, unknown>>
    : [{ pageNumber: 1, width: payload.width, height: payload.height, elements: payload.elements }];
  let nextId = 1;
  const pageXml = pages.map((page, pageIndex) => {
    const width = Math.max(1, Number(page.width || 1200));
    const height = Math.max(1, Number(page.height || 800));
    const scale = 9.5 / width;
    const pageWidth = Math.max(10, width * scale + 0.5);
    const pageHeight = Math.max(7.5, height * scale + 0.5);
    const elements = Array.isArray(page.elements) ? page.elements as ElementPayload[] : [];
    const shapes = elements.filter((item) => item.type === "diagram-shape" || item.type === "diagram-connector").map((item) => {
      const id = nextId++;
      const box = item.bbox || {};
      if (item.type === "diagram-connector") {
        const points = Array.isArray(item.geometry?.points) ? item.geometry?.points.map(Number) : [];
        const [x0, y0, x1, y1] = points.length === 4
          ? points : [Number(box.x || 0), Number(box.y || 0), Number(box.x || 0) + Number(box.width || 0), Number(box.y || 0)];
        return `<Shape ID="${id}" NameU="Dynamic connector.${id}" Type="Shape"><XForm1D><BeginX>${(x0 * scale).toFixed(4)}</BeginX><BeginY>${(pageHeight - y0 * scale).toFixed(4)}</BeginY><EndX>${(x1 * scale).toFixed(4)}</EndX><EndY>${(pageHeight - y1 * scale).toFixed(4)}</EndY></XForm1D><Line><LineWeight>0.0139</LineWeight><EndArrow>4</EndArrow></Line><Text>${escapeXml(item.content)}</Text></Shape>`;
      }
      const w = Math.max(0.45, Number(box.width || 1) * scale);
      const h = Math.max(0.25, Number(box.height || 1) * scale);
      const pinX = Number(box.x || 0) * scale + w / 2;
      const pinY = pageHeight - Number(box.y || 0) * scale - h / 2;
      return `<Shape ID="${id}" NameU="Process.${id}" Type="Shape"><XForm><PinX>${pinX.toFixed(4)}</PinX><PinY>${pinY.toFixed(4)}</PinY><Width>${w.toFixed(4)}</Width><Height>${h.toFixed(4)}</Height><LocPinX>${(w / 2).toFixed(4)}</LocPinX><LocPinY>${(h / 2).toFixed(4)}</LocPinY></XForm><Geom IX="0"><MoveTo IX="1"><X>0</X><Y>0</Y></MoveTo><LineTo IX="2"><X>${w.toFixed(4)}</X><Y>0</Y></LineTo><LineTo IX="3"><X>${w.toFixed(4)}</X><Y>${h.toFixed(4)}</Y></LineTo><LineTo IX="4"><X>0</X><Y>${h.toFixed(4)}</Y></LineTo><LineTo IX="5"><X>0</X><Y>0</Y></LineTo></Geom><Text>${escapeXml(item.content)}</Text></Shape>`;
    }).join("");
    return `<Page ID="${pageIndex}" NameU="Page-${pageIndex + 1}" Name="第${pageIndex + 1}页"><PageSheet><PageProps><PageWidth>${pageWidth.toFixed(4)}</PageWidth><PageHeight>${pageHeight.toFixed(4)}</PageHeight><PageScale>1</PageScale><DrawingScale>1</DrawingScale></PageProps></PageSheet><Shapes>${shapes}</Shapes></Page>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><VisioDocument xmlns="http://schemas.microsoft.com/visio/2003/core" start="1" metric="0" DocLangID="2052" version="14.0"><DocumentProperties><Creator>DocVision Studio Backend</Creator><Title>${escapeXml(fileName)}</Title><Description>由后端结构模型生成的可编辑多页框图</Description></DocumentProperties><Pages>${pageXml}</Pages></VisioDocument>`;
}

async function buildWord(payload: Record<string, unknown>) {
  const fileName = String(payload.fileName || "DocVision");
  const pages = Array.isArray(payload.pages) && payload.pages.length
    ? payload.pages.slice(0, 30) as Array<Record<string, unknown>>
    : [{ pageNumber: 1, elements: payload.elements }];
  const zip = new JSZip();
  const imageRelationships: string[] = [];
  let nextImage = 1;
  let nextShape = 1;
  const pageWidthPt = 612;
  const pageHeightPt = 792;

  const textBox = (item: ElementPayload, pageWidth: number, pageHeight: number) => {
    const box = item.bbox || {};
    const x = Number(box.x || 0) / pageWidth * pageWidthPt;
    const y = Number(box.y || 0) / pageHeight * pageHeightPt;
    const width = Math.max(4, Number(box.width || 1) / pageWidth * pageWidthPt);
    const height = Math.max(4, Number(box.height || 1) / pageHeight * pageHeightPt);
    const bold = item.role === "title" || item.role === "heading";
    const fontSize = Math.max(5.2, Math.min(22, Number(item.fontSize || 9) / pageWidth * pageWidthPt * (bold ? 0.92 : 0.86)));
    const style = `position:absolute;margin-left:${x.toFixed(2)}pt;margin-top:${y.toFixed(2)}pt;width:${width.toFixed(2)}pt;height:${height.toFixed(2)}pt;z-index:2;mso-position-horizontal-relative:page;mso-position-vertical-relative:page`;
    const content = escapeXml(item.content);
    const inner = item.type === "formula"
      ? `<m:oMathPara><m:oMath><m:r><m:rPr><m:sty m:val="i"/></m:rPr><m:t>${content}</m:t></m:r></m:oMath></m:oMathPara>`
      : `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="${item.role === "paragraph" ? "both" : "left"}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>${bold ? "<w:b/>" : ""}<w:sz w:val="${Math.round(fontSize * 2)}"/><w:szCs w:val="${Math.round(fontSize * 2)}"/></w:rPr><w:t xml:space="preserve">${content}</w:t></w:r></w:p>`;
    return `<w:r><w:pict><v:rect id="TextBox${nextShape++}" stroked="f" filled="f" style="${style}"><v:textbox inset="0,0,0,0"><w:txbxContent>${inner}</w:txbxContent></v:textbox></v:rect></w:pict></w:r>`;
  };

  const imageBox = (item: ElementPayload, pageWidth: number, pageHeight: number, zIndex = 3) => {
    if (typeof item.imageUrl !== "string") return "";
    const match = item.imageUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
    if (!match) return "";
    const extension = match[1].startsWith("jp") ? "jpg" : "png";
    const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
    const imageName = `image${nextImage}.${extension}`;
    const relationshipId = `rIdImage${nextImage}`;
    nextImage += 1;
    zip.file(`word/media/${imageName}`, bytes);
    imageRelationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${imageName}"/>`);
    const box = item.bbox || {};
    const x = Number(box.x || 0) / pageWidth * pageWidthPt;
    const y = Number(box.y || 0) / pageHeight * pageHeightPt;
    const width = Math.max(4, Number(box.width || 1) / pageWidth * pageWidthPt);
    const height = Math.max(4, Number(box.height || 1) / pageHeight * pageHeightPt);
    const style = `position:absolute;margin-left:${x.toFixed(2)}pt;margin-top:${y.toFixed(2)}pt;width:${width.toFixed(2)}pt;height:${height.toFixed(2)}pt;z-index:${zIndex};mso-position-horizontal-relative:page;mso-position-vertical-relative:page`;
    return `<w:r><w:pict><v:rect id="Image${nextShape++}" stroked="f" filled="f" style="${style}"><v:imagedata r:id="${relationshipId}" o:title="${escapeXml(item.content)}"/></v:rect></w:pict></w:r>`;
  };

  const body = pages.map((page, pageIndex) => {
    const pageWidth = Math.max(1, Number(page.width || 1224));
    const pageHeight = Math.max(1, Number(page.height || 1584));
    const elements = (Array.isArray(page.elements) ? page.elements : []) as ElementPayload[];
    const pageImage = typeof page.imageUrl === "string"
      ? imageBox({
          type: "image",
          content: `Original page ${pageIndex + 1}`,
          imageUrl: page.imageUrl,
          bbox: { x: 0, y: 0, width: pageWidth, height: pageHeight },
        }, pageWidth, pageHeight, 1)
      : "";
    const runs = pageImage || elements
      .filter((item) => item.type !== "diagram-connector")
      .map((item) => item.type === "image" ? imageBox(item, pageWidth, pageHeight, 3) : item.type === "formula" && typeof item.imageUrl === "string" ? imageBox(item, pageWidth, pageHeight, 4) : textBox(item, pageWidth, pageHeight))
      .join("");
    const anchor = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/></w:pPr>${runs}</w:p>`;
    const pageBreak = pageIndex < pages.length - 1 ? '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>' : "";
    return `${anchor}${pageBreak}`;
  }).join("");
  const editablePages = pages.map((page, pageIndex) => {
    const pageNumber = Number(page.pageNumber || pageIndex + 1);
    const elements = ((Array.isArray(page.elements) ? page.elements : []) as ElementPayload[])
      .filter((item) => item.type === "text" || item.type === "formula");
    if (!elements.length) return "";
    let formulaIndex = 0;
    const editableRuns = elements.map((item) => {
      if (item.type === "formula") {
        formulaIndex += 1;
        return `<w:p><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="53657A"/><w:sz w:val="18"/></w:rPr><w:t>Formula ${formulaIndex}</w:t></w:r></w:p><m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath><m:r><m:rPr><m:sty m:val="i"/></m:rPr><m:t>${escapeXml(item.content)}</m:t></m:r></m:oMath></m:oMathPara><w:p><w:pPr><w:spacing w:after="100"/></w:pPr></w:p>`;
      }
      const bold = item.role === "title" || item.role === "heading";
      const size = item.role === "title" ? 28 : item.role === "heading" ? 23 : 20;
      return `<w:p><w:pPr><w:spacing w:after="110"/><w:jc w:val="${item.role === "paragraph" ? "both" : "left"}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(item.content)}</w:t></w:r></w:p>`;
    }).join("");
    return `<w:p><w:pPr>${pageIndex > 0 ? "<w:pageBreakBefore/>" : ""}<w:keepNext/><w:spacing w:after="200"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="30"/></w:rPr><w:t>Page ${pageNumber} · Editable text and formulas</w:t></w:r></w:p>${editableRuns}`;
  }).join("");
  const editableAppendix = editablePages
    ? `<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:pPr><w:spacing w:after="220"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="34"/></w:rPr><w:t>Editable content layer</w:t></w:r></w:p><w:p><w:pPr><w:spacing w:after="200"/></w:pPr><w:r><w:rPr><w:i/><w:color w:val="666666"/><w:sz w:val="18"/></w:rPr><w:t>The original-layout pages above preserve the PDF appearance. The following paragraphs and OMML equations are editable in Word and compatible with MathType conversion workflows.</w:t></w:r></w:p>${editablePages}`
    : "";

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(fileName)}</dc:title><dc:creator>DocVision Studio Backend</dc:creator><dc:description>后端生成的多页可编辑文档</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${imageRelationships.join("")}</Relationships>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style></w:styles>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word"><w:body>${body}${editableAppendix}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

async function exportDocument(request: Request) {
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; }
  catch { return json({ error: "INVALID_JSON" }, 400); }
  if (payload.format === "word") {
    return new Response(await buildWord(payload), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": "attachment; filename=docvision-editable.docx",
        "x-docvision-backend": "document-model-v2",
      },
    });
  }
  if (payload.format !== "visio") return json({ error: "UNSUPPORTED_FORMAT" }, 422);
  const xml = buildVisio(payload);
  return new Response(xml, {
    headers: {
      "content-type": "application/vnd.visio+xml;charset=utf-8",
      "content-disposition": "attachment; filename=docvision-editable.vdx",
      "x-docvision-backend": "document-model-v2",
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ status: "ok", service: "docvision-document-backend", version: "2.0.0", processing: "local-first-plus-backend-model" });
    }
    if (url.pathname === "/api/analyze" || url.pathname === "/api/jobs") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return analyze(request);
    }
    if (url.pathname === "/api/export") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return exportDocument(request);
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || request.method !== "GET") return asset;
    return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
  },
};

export default worker;
