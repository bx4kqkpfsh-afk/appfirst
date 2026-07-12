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

test("AI review is optional and never requires a key for local mode", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("http://localhost/api/ai-review", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "AI_NOT_CONFIGURED");
});

test("AI review accepts schema-bound corrections and rejects broken glyphs", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.match(init.headers.authorization, /^Bearer /);
    return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ corrections: [
      { id: "formula-1", content: "E = mc^2", type: "formula", confidence: 0.97, reason: "page image confirms the symbols" },
      { id: "text-1", content: "bad□", type: "text", confidence: 0.99, reason: "invalid placeholder" },
    ] }) }] }] });
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/ai-review", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        pageNumber: 1, width: 1000, height: 1400,
        imageUrl: "data:image/png;base64,iVBORw0KGgo=",
        elements: [
          { id: "formula-1", type: "formula", content: "E = mc□", bbox: { x: 1, y: 2, width: 100, height: 20 } },
          { id: "text-1", type: "text", content: "bad□", bbox: { x: 1, y: 30, width: 100, height: 20 } },
        ],
      }),
    }), { ...env, OPENAI_API_KEY: "test-key", OPENAI_VISION_MODEL: "test-vision-model" });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.model, "test-vision-model");
    assert.deepEqual(result.corrections.map((item) => item.id), ["formula-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("multi-model review accepts only matching consensus", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === "https://api.openai.com/v1/responses") return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ corrections: [{ id: "formula-1", content: "E = mc^2", type: "formula", confidence: 0.98, reason: "visual" }] }) }] }] });
    if (url === "https://api.deepseek.com/chat/completions") return Response.json({ choices: [{ message: { content: JSON.stringify({ corrections: [{ id: "formula-1", content: "E = mc^2", type: "formula", confidence: 0.96, reason: "cross-check" }] }) } }] });
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/ai-review", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        pageNumber: 1, width: 1000, height: 1400, imageUrl: "data:image/png;base64,iVBORw0KGgo=",
        elements: [{ id: "formula-1", type: "formula", content: "E = mc□", bbox: { x: 1, y: 2, width: 100, height: 20 } }],
      }),
    }), { ...env, OPENAI_API_KEY: "openai-test", DEEPSEEK_API_KEY: "deepseek-test" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.conflicts, 0);
    assert.deepEqual(result.reviewers, ["OpenAI Vision", "DeepSeek Reasoner"]);
    assert.deepEqual(result.corrections.map((item) => item.content), ["E = mc^2"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("multi-model disagreement preserves the original candidate", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const content = url === "https://api.openai.com/v1/responses" ? "E = mc^2" : "E = mc^3";
    if (url === "https://api.openai.com/v1/responses") return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ corrections: [{ id: "formula-1", content, type: "formula", confidence: 0.98, reason: "visual" }] }) }] }] });
    if (url === "https://api.deepseek.com/chat/completions") return Response.json({ choices: [{ message: { content: JSON.stringify({ corrections: [{ id: "formula-1", content, type: "formula", confidence: 0.96, reason: "cross-check" }] }) } }] });
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/ai-review", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        pageNumber: 1, width: 1000, height: 1400, imageUrl: "data:image/png;base64,iVBORw0KGgo=",
        elements: [{ id: "formula-1", type: "formula", content: "E = mc□", bbox: { x: 1, y: 2, width: 100, height: 20 } }],
      }),
    }), { ...env, OPENAI_API_KEY: "openai-test", DEEPSEEK_API_KEY: "deepseek-test" });
    const result = await response.json();
    assert.equal(result.conflicts, 1);
    assert.deepEqual(result.corrections, []);
  } finally { globalThis.fetch = originalFetch; }
});
