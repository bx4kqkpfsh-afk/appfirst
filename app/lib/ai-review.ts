"use client";

import type { AnalysisResult, DocumentPage, ExtractedElement } from "./types";

type ReviewCorrection = {
  id: string;
  content: string;
  type: "text" | "formula";
  confidence: number;
  reason: string;
};

type ReviewResponse = {
  corrections?: ReviewCorrection[];
  model?: string;
  reviewers?: string[];
  conflicts?: number;
  error?: string;
  message?: string;
};

const BROKEN_GLYPH = /[□�\uFFFD\uE000-\uF8FF]/u;

export const needsAiReview = (element: ExtractedElement) =>
  (element.type === "text" || element.type === "formula") &&
  (element.type === "formula" || element.confidence < 0.88 || BROKEN_GLYPH.test(element.content));

const safeCorrection = (value: ReviewCorrection, originals: Map<string, ExtractedElement>) => {
  const original = originals.get(value.id);
  if (!original || typeof value.content !== "string" || value.content.length > 4000) return null;
  const content = value.content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!content || BROKEN_GLYPH.test(content) || !Number.isFinite(value.confidence)) return null;
  const confidence = Math.max(0, Math.min(1, value.confidence));
  if (confidence < 0.78 || content === original.content) return null;
  return { original, content, confidence, reason: String(value.reason || "视觉复核修正").slice(0, 240), type: value.type };
};

export async function reviewWithAi(
  result: AnalysisResult,
  onProgress: (value: number, label: string) => void,
): Promise<AnalysisResult> {
  const pages = result.pages?.length ? result.pages : [{
    pageNumber: 1, imageUrl: result.imageUrl, width: result.width, height: result.height,
    elements: result.elements, rawText: result.rawText, confidence: result.confidence,
  }];
  const reviewPages = pages.filter((page) => page.elements.some(needsAiReview));
  if (!reviewPages.length) return { ...result, aiReview: { enabled: true, corrected: 0, reviewed: 0 } };

  const corrections: ReviewCorrection[] = [];
  let model = "";
  let warning = "";
  let reviewed = 0;
  const reviewers = new Set<string>();
  let conflicts = 0;
  for (let index = 0; index < reviewPages.length; index += 1) {
    const page = reviewPages[index];
    const candidates = page.elements.filter(needsAiReview).slice(0, 120);
    onProgress(94 + Math.round(((index + 1) / reviewPages.length) * 4), `多模型交叉复核第 ${page.pageNumber} 页`);
    let response: Response;
    try {
      response = await fetch("/api/ai-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pageNumber: page.pageNumber,
          imageUrl: page.imageUrl,
          width: page.width,
          height: page.height,
          elements: candidates.map(({ id, type, content, bbox, role }) => ({ id, type, content, bbox, role })),
        }),
      });
    } catch {
      warning = "AI 复核接口暂时不可用，本次保留本地识别结果。";
      continue;
    }

    let data: ReviewResponse = {};
    try {
      const body = await response.text();
      data = body ? JSON.parse(body) as ReviewResponse : {};
    } catch {
      warning = "AI 复核接口返回了无法解析的数据，本次保留本地识别结果。";
      continue;
    }
    if (!response.ok) {
      if (data.error === "AI_NOT_CONFIGURED") {
        warning = "站点尚未配置 OpenAI 或 DeepSeek API 密钥，本次保留本地识别结果。";
        break;
      }
      warning = data.message || "AI 复核暂时不可用，本次保留本地识别结果。";
      continue;
    }
    reviewed += candidates.length;
    corrections.push(...(Array.isArray(data.corrections) ? data.corrections : []));
    model = data.model || model;
    for (const reviewer of data.reviewers || []) reviewers.add(reviewer);
    conflicts += Number(data.conflicts || 0);
  }

  const originals = new Map(result.elements.map((element) => [element.id, element]));
  const accepted = new Map<string, ReturnType<typeof safeCorrection>>();
  for (const correction of corrections) {
    const safe = safeCorrection(correction, originals);
    if (safe) accepted.set(correction.id, safe);
  }
  const apply = (element: ExtractedElement): ExtractedElement => {
    const correction = accepted.get(element.id);
    if (!correction) return element;
    return {
      ...element,
      type: correction.type,
      originalContent: element.content,
      content: correction.content,
      confidence: correction.confidence,
      source: "ai-review",
      reviewReason: correction.reason,
      reviewStatus: "corrected",
    };
  };
  const updatedPages: DocumentPage[] = pages.map((page) => {
    const elements = page.elements.map(apply);
    return { ...page, elements, rawText: elements.filter((item) => item.type === "text" || item.type === "formula").map((item) => item.content).join("\n") };
  });
  const elements = result.elements.map(apply);
  return {
    ...result,
    elements,
    pages: updatedPages,
    rawText: updatedPages.map((page) => page.rawText).join("\n\n"),
    aiReview: { enabled: true, corrected: accepted.size, reviewed, model: model || undefined, reviewers: [...reviewers], conflicts, warning: warning || undefined },
  };
}
