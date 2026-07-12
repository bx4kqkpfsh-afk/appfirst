export type ElementKind = "text" | "formula" | "image" | "diagram-shape" | "diagram-connector";

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DiagramGeometry = {
  shape?: "rectangle" | "ellipse";
  points?: [number, number, number, number];
};

export type ExtractedElement = {
  id: string;
  type: ElementKind;
  content: string;
  confidence: number;
  bbox: BoundingBox;
  geometry?: DiagramGeometry;
  pageNumber?: number;
  imageUrl?: string;
  role?: "title" | "heading" | "paragraph" | "caption" | "equation" | "figure";
  fontSize?: number;
  source?: "native-pdf" | "ocr" | "diagram" | "ai-review";
  originalContent?: string;
  reviewReason?: string;
  reviewStatus?: "corrected" | "unchanged" | "needs-review";
};

export type DocumentPage = {
  pageNumber: number;
  imageUrl: string;
  width: number;
  height: number;
  elements: ExtractedElement[];
  rawText: string;
  confidence: number;
};

export type VerificationCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type VerificationResult = {
  jobId: string;
  score: number;
  ready: boolean;
  checks: VerificationCheck[];
  warnings: string[];
  backend?: {
    processedAt: string;
    pipeline: string;
    pageCount: number;
    modelHash: string;
    exportFormats: string[];
  };
};

export type AnalysisResult = {
  fileName: string;
  imageUrl: string;
  width: number;
  height: number;
  elements: ExtractedElement[];
  confidence: number;
  rawText: string;
  sourceType?: "image" | "pdf";
  pages?: DocumentPage[];
  verification?: VerificationResult;
  aiReview?: {
    enabled: boolean;
    corrected: number;
    reviewed: number;
    model?: string;
    reviewers?: string[];
    conflicts?: number;
    warning?: string;
  };
};

export const kindLabel: Record<ElementKind, string> = {
  text: "文字",
  formula: "公式",
  image: "图片",
  "diagram-shape": "框图节点",
  "diagram-connector": "连接线",
};

export const kindColor: Record<ElementKind, string> = {
  text: "#2457d6",
  formula: "#14a87a",
  image: "#d97706",
  "diagram-shape": "#7c4dff",
  "diagram-connector": "#f59e0b",
};
