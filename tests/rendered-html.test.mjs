import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";

const loadWorker = async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
};

const env = {
  ASSETS: {
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(await readFile(new URL("../dist/client/index.html", import.meta.url)), {
          headers: { "content-type": "text/html;charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  },
};

test("serves the static DocVision application", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("http://localhost/"), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /文图重构工作台/);
});

test("backend builds a canonical multi-page document model", async () => {
  const worker = await loadWorker();
  const payload = {
    fileName: "sample.pdf", width: 1200, height: 800, fileSize: 2000,
    pages: [{ pageNumber: 1, width: 1200, height: 800 }, { pageNumber: 2, width: 1200, height: 800 }],
    elements: [
      { id: "b", type: "text", content: "第二行", confidence: 0.9, pageNumber: 2, bbox: { x: 10, y: 20, width: 100, height: 30 } },
      { id: "a", type: "diagram-shape", content: "开始", confidence: 0.95, pageNumber: 1, bbox: { x: 20, y: 40, width: 160, height: 60 } },
    ],
  };
  const response = await worker.fetch(new Request("http://localhost/api/jobs", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.backend.pageCount, 2);
  assert.equal(result.backend.pipeline, "cloudflare-worker/document-model-v2");
  assert.equal(result.normalizedElements[0].id, "a");
  assert.match(result.backend.modelHash, /^[0-9A-F]{12}$/);
});

test("backend generates editable multi-page Visio XML", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      format: "visio", fileName: "flow.pdf",
      pages: [{ pageNumber: 1, width: 1000, height: 700, elements: [
        { id: "shape-1", type: "diagram-shape", content: "处理", confidence: 0.9, bbox: { x: 100, y: 100, width: 240, height: 90 } },
      ] }],
    }),
  }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /visio/);
  const xml = await response.text();
  assert.match(xml, /<VisioDocument/);
  assert.match(xml, /处理/);
});

test("backend generates a valid editable multi-page Word package", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      format: "word", fileName: "sample.pdf",
      pages: [
        { pageNumber: 1, elements: [{ type: "text", content: "第一页正文", confidence: 0.9, bbox: { x: 1, y: 1, width: 10, height: 10 } }] },
        { pageNumber: 2, elements: [{ type: "formula", content: "E = mc^2", confidence: 0.9, bbox: { x: 1, y: 1, width: 10, height: 10 } }] },
      ],
    }),
  }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /wordprocessingml/);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /第一页正文/);
  assert.match(xml, /E = mc\^2/);
  assert.match(xml, /w:type="page"/);
});
