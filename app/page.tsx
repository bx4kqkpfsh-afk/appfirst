"use client";

import {
  Activity,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Code2,
  Download,
  FileCheck2,
  FileImage,
  FileOutput,
  FileText,
  FolderClock,
  Layers3,
  LoaderCircle,
  Maximize2,
  Menu,
  Network,
  Presentation,
  RefreshCcw,
  ScanText,
  Settings2,
  ShieldCheck,
  Sigma,
  Sparkles,
  Upload,
  WandSparkles,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createValidationSample } from "./lib/analyze-image";
import { analyzeDocument } from "./lib/analyze-document";
import { reviewWithAi } from "./lib/ai-review";
import {
  exportDiagramSvg,
  exportPowerPoint,
  exportVisioFromBackend,
  exportWordFromBackend,
} from "./lib/exporters";
import type {
  AnalysisResult,
  ElementKind,
  ExtractedElement,
  VerificationResult,
} from "./lib/types";
import { kindColor, kindLabel } from "./lib/types";

type Status = "idle" | "ready" | "analyzing" | "done" | "error";
type ExportFormat = "word" | "ppt" | "visio";

const formatOptions = [
  {
    id: "word" as const,
    title: "Word 文档",
    description: "原页保真 + 可编辑段落与 OMML 公式层",
    icon: FileText,
    className: "format-word",
  },
  {
    id: "ppt" as const,
    title: "可编辑 PPT",
    description: "文字、形状与连接线全部分层",
    icon: Presentation,
    className: "format-ppt",
  },
  {
    id: "visio" as const,
    title: "可编辑 Visio",
    description: "导出 VDX，并附 SVG 矢量版",
    icon: Workflow,
    className: "format-visio",
  },
];

const statusCopy: Record<Status, string> = {
  idle: "等待上传",
  ready: "可以开始识别",
  analyzing: "正在解析图像结构",
  done: "识别与验证完成",
  error: "识别失败",
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function countByKind(elements: ExtractedElement[], kind: ElementKind) {
  return elements.filter((element) => element.type === kind).length;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("等待上传图片");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>("word");
  const [activeElement, setActiveElement] = useState<string | null>(null);
  const [health, setHealth] = useState<"checking" | "online" | "offline">("checking");
  const [zoom, setZoom] = useState(1);
  const [showAllLayers, setShowAllLayers] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [aiReviewEnabled, setAiReviewEnabled] = useState(true);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => {
        if (!response.ok) throw new Error("offline");
        return response.json();
      })
      .then(() => setHealth("online"))
      .catch(() => setHealth("offline"));
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const elements = useMemo(() => result?.elements || [], [result?.elements]);
  const activePage = useMemo(
    () => result?.pages?.find((page) => page.pageNumber === currentPage) || result?.pages?.[0],
    [currentPage, result?.pages],
  );
  const visiblePageElements = useMemo(
    () => activePage?.elements || result?.elements || [],
    [activePage?.elements, result?.elements],
  );
  const counts = useMemo(
    () => ({
      text: countByKind(elements, "text"),
      formula: countByKind(elements, "formula"),
      images: countByKind(elements, "image"),
      shapes: countByKind(elements, "diagram-shape"),
      connectors: countByKind(elements, "diagram-connector"),
    }),
    [elements],
  );

  const acceptFile = useCallback((nextFile: File) => {
    setError("");
    const isPdf = nextFile.type === "application/pdf" || nextFile.name.toLowerCase().endsWith(".pdf");
    if (!nextFile.type.startsWith("image/") && !isPdf) {
      setError("请上传 PDF、PNG、JPG、WEBP 或 BMP 文件。 ");
      setStatus("error");
      return;
    }
    if (nextFile.size > 50 * 1024 * 1024) {
      setError("文件不能超过 50 MB。 ");
      setStatus("error");
      return;
    }
    setFile(nextFile);
    setPreviewUrl(isPdf ? "" : URL.createObjectURL(nextFile));
    setResult(null);
    setStatus("ready");
    setProgress(0);
    setProgressLabel("图片已就绪");
    setActiveElement(null);
    setZoom(1);
    setCurrentPage(1);
  }, []);

  const loadSample = async () => {
    try {
      const sample = await createValidationSample();
      acceptFile(sample);
    } catch (sampleError) {
      setError(sampleError instanceof Error ? sampleError.message : "验证样例生成失败。 ");
      setStatus("error");
    }
  };

  const startAnalysis = async () => {
    if (!file || status === "analyzing") return;
    setStatus("analyzing");
    setProgress(1);
    setError("");
    setResult(null);
    setActiveElement(null);
    try {
      const localResult = await analyzeDocument(file, (value, label) => {
        setProgress(value);
        setProgressLabel(label);
      });
      const reviewedResult = aiReviewEnabled
        ? await reviewWithAi(localResult, (value, label) => { setProgress(value); setProgressLabel(label); })
        : localResult;
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: reviewedResult.fileName,
          width: reviewedResult.width,
          height: reviewedResult.height,
          fileSize: file.size,
          elements: reviewedResult.elements,
          pages: reviewedResult.pages?.map(({ pageNumber, width, height, elements }) => ({ pageNumber, width, height, elements })),
        }),
      });
      if (!response.ok) throw new Error("后端验证未通过，请重新上传更清晰的图片。 ");
      const verification = (await response.json()) as VerificationResult;
      if (reviewedResult.aiReview?.warning) verification.warnings.push(reviewedResult.aiReview.warning);
      if (reviewedResult.aiReview?.conflicts) verification.warnings.push(`多模型发现 ${reviewedResult.aiReview.conflicts} 处修正冲突，已安全保留本地原文，请人工复核。`);
      const complete = { ...reviewedResult, verification };
      setResult(complete);
      setPreviewUrl(complete.imageUrl);
      setProgress(100);
      setProgressLabel("识别、重建与验证完成");
      setStatus("done");
      setActiveElement(complete.elements.at(0)?.id || null);
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "识别过程中出现问题，请重试。 ",
      );
      setStatus("error");
      setProgress(0);
    }
  };

  const updateElement = (id: string, patch: Partial<ExtractedElement>) => {
    setResult((current) =>
      current
        ? {
            ...current,
            elements: current.elements.map((element) =>
              element.id === id ? { ...element, ...patch } : element,
            ),
          }
        : current,
    );
  };

  const removeElement = (id: string) => {
    setResult((current) =>
      current
        ? { ...current, elements: current.elements.filter((element) => element.id !== id) }
        : current,
    );
    setActiveElement((current) => (current === id ? null : current));
  };

  const runExport = async (format: ExportFormat) => {
    if (!result) return;
    setExporting(format);
    try {
      if (format === "word") await exportWordFromBackend(result);
      if (format === "ppt") await exportPowerPoint(result);
      if (format === "visio") await exportVisioFromBackend(result);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "导出失败，请重试。 ");
    } finally {
      setExporting(null);
    }
  };

  const selectedElement = elements.find((element) => element.id === activeElement) || null;
  const confidence = result?.verification?.score ?? Math.round((result?.confidence || 0) * 1000) / 10;
  const isPdf = file?.type === "application/pdf" || file?.name.toLowerCase().endsWith(".pdf");

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><ScanText size={24} strokeWidth={2.3} /></div>
          <div>
            <strong>文图重构工作台</strong>
            <span>DOCVISION STUDIO</span>
          </div>
          <button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单"><X size={18} /></button>
        </div>
        <nav className="side-nav" aria-label="主导航">
          <button className="active"><WandSparkles size={19} /><span>智能识别</span></button>
          <button><FolderClock size={19} /><span>任务中心</span><small>1</small></button>
          <button><FileOutput size={19} /><span>导出记录</span></button>
          <button><Layers3 size={19} /><span>模板管理</span></button>
        </nav>
        <div className="side-note">
          <ShieldCheck size={18} />
          <div><strong>本地优先处理</strong><span>视觉页发 OpenAI，候选文本发 DeepSeek</span></div>
        </div>
        <div className="side-footer">
          <div className={`system-dot ${health}`}></div>
          <div><strong>系统状态</strong><span>{health === "online" ? "验证服务正常" : health === "checking" ? "正在检查" : "本地模式"}</span></div>
          <ChevronDown size={16} />
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单" />}

      <section className="workspace">
        <header className="topbar">
          <div className="page-heading">
            <button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu size={21} /></button>
            <div><h1>智能识别</h1><p>上传 · 提取 · 校对 · 导出</p></div>
          </div>
          <div className="top-actions">
            <div className="local-badge"><ShieldCheck size={16} /><i></i>{aiReviewEnabled ? "本地识别 + 多模型共识" : "纯本地识别"}</div>
            <button className="icon-button" aria-label="帮助"><CircleHelp size={19} /></button>
            <button className="icon-button" aria-label="设置"><Settings2 size={19} /></button>
          </div>
        </header>

        <div className="work-grid">
          <section className="main-column">
            <article className="panel upload-panel">
              <div className="panel-heading">
                <div><span className="eyebrow">STEP 01 · INPUT</span><h2>上传图片或 PDF</h2><p>逐页识别文字、公式和系统框图，并重构为可编辑内容</p></div>
                {file && <button className="quiet-button" onClick={() => inputRef.current?.click()}><RefreshCcw size={15} />更换文件</button>}
              </div>

              {!file ? (
                <div
                  className={`dropzone ${dragging ? "dragging" : ""}`}
                  onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    const dropped = event.dataTransfer.files[0];
                    if (dropped) acceptFile(dropped);
                  }}
                >
                  <div className="upload-illustration"><FileImage size={39} /><span><Upload size={17} /></span></div>
                  <h3>拖拽图片或 PDF 到此处，或点击选择文件</h3>
                  <p>支持 PDF、PNG、JPG、WEBP、BMP · PDF 最多 30 页 · 文件不超过 50 MB</p>
                  <div className="dropzone-actions">
                    <button className="primary-small" onClick={() => inputRef.current?.click()}><Upload size={16} />选择文件</button>
                    <button className="secondary-small" onClick={loadSample}><Sparkles size={16} />加载验证样例</button>
                  </div>
                </div>
              ) : (
                <div className="document-stage-wrap">
                  <div className="stage-toolbar">
                    <div className="file-meta">{isPdf ? <FileText size={17} /> : <FileImage size={17} />}<div><strong>{file.name}</strong><span>{formatBytes(file.size)}{result?.pages?.length ? ` · ${result.pages.length} 页` : ""}</span></div></div>
                    <div className="stage-tools">
                      <button onClick={() => setShowAllLayers((current) => !current)} className={showAllLayers ? "is-active" : ""}><Layers3 size={16} />图层</button>
                      <button onClick={() => setZoom((current) => Math.max(0.65, current - 0.1))} aria-label="缩小"><ZoomOut size={16} /></button>
                      <span>{Math.round(zoom * 100)}%</span>
                      <button onClick={() => setZoom((current) => Math.min(1.65, current + 0.1))} aria-label="放大"><ZoomIn size={16} /></button>
                      <button onClick={() => setZoom(1)} aria-label="重置缩放"><Maximize2 size={16} /></button>
                      {result?.pages && result.pages.length > 1 && <>
                        <button disabled={currentPage <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>上一页</button>
                        <span>{currentPage}/{result.pages.length}</span>
                        <button disabled={currentPage >= result.pages.length} onClick={() => setCurrentPage((page) => Math.min(result.pages!.length, page + 1))}>下一页</button>
                      </>}
                    </div>
                  </div>
                  <div className="document-viewport">
                    <div className="document-canvas" style={{ transform: `scale(${zoom})` }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- local blob/data URLs must remain in-browser */}
                      {(activePage?.imageUrl || previewUrl) ? <img src={activePage?.imageUrl || previewUrl} alt="待识别文档预览" /> : <div className="pdf-placeholder"><FileText size={48} /><strong>PDF 已就绪</strong><span>点击“开始智能重构”后逐页渲染与识别</span></div>}
                      {result && showAllLayers && visiblePageElements.map((element) => (
                        <button
                          key={element.id}
                          className={`region-box ${element.type} ${activeElement === element.id ? "selected" : ""}`}
                          style={{
                            left: `${(element.bbox.x / (activePage?.width || result.width)) * 100}%`,
                            top: `${(element.bbox.y / (activePage?.height || result.height)) * 100}%`,
                            width: `${Math.max(0.8, (element.bbox.width / (activePage?.width || result.width)) * 100)}%`,
                            height: `${Math.max(0.6, (element.bbox.height / (activePage?.height || result.height)) * 100)}%`,
                            borderColor: kindColor[element.type],
                          }}
                          onClick={() => setActiveElement(element.id)}
                          aria-label={`${kindLabel[element.type]}：${element.content}`}
                        ><span style={{ backgroundColor: kindColor[element.type] }}>{kindLabel[element.type]}</span></button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <input ref={inputRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/bmp" hidden onChange={(event) => { const selected = event.target.files?.[0]; if (selected) acceptFile(selected); event.currentTarget.value = ""; }} />

              <div className="analysis-controls">
                <div className="mode-picker"><span>识别类型</span><button className="active"><Check size={14} />智能检测</button><button><ScanText size={14} />文字 OCR</button><button><Sigma size={14} />公式识别</button><button><Network size={14} />框图重构</button></div>
                <div className="privacy-toggle">
                  <span>中英混排</span><span>版式保留</span>
                  <button className={`ai-review-toggle ${aiReviewEnabled ? "on" : ""}`} role="switch" aria-checked={aiReviewEnabled} onClick={() => setAiReviewEnabled((current) => !current)}>
                    <i><b /></i><span>多模型高精度复核</span>
                  </button>
                </div>
              </div>
            </article>

            {file && (
              <article className={`panel task-panel status-${status}`}>
                <div className="task-topline">
                  <div className="task-status-icon">
                    {status === "analyzing" ? <LoaderCircle size={19} className="spin" /> : status === "done" ? <CheckCircle2 size={19} /> : <Activity size={19} />}
                  </div>
                  <div className="task-copy"><strong>{statusCopy[status]}</strong><span>{progressLabel}</span></div>
                  <b>{progress}%</b>
                </div>
                <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
                <div className="pipeline-steps">
                  {[
                    ["预处理", 12],
                    ["文字", 42],
                    ["公式", 69],
                    ["框图", 84],
                    ["模型共识", 94],
                    ["验证", 99],
                  ].map(([label, threshold]) => (
                    <div key={label} className={progress >= Number(threshold) ? "complete" : progress > Number(threshold) - 20 ? "current" : ""}>
                      <span>{progress >= Number(threshold) ? <Check size={12} /> : <i />}</span><b>{label}</b>
                    </div>
                  ))}
                </div>
                {error && <div className="error-banner"><CircleHelp size={16} />{error}</div>}
              </article>
            )}

            {result && (
              <article className="panel results-panel">
                <div className="panel-heading compact">
                  <div><span className="eyebrow">STEP 02 · REVIEW</span><h2>提取结果校对</h2><p>点击左侧标注区域或下方卡片，修改类型与内容</p></div>
                  <span className="job-id">{result.verification?.jobId}</span>
                </div>
                <div className="result-list">
                  {result.elements.map((element) => (
                    <button key={element.id} className={`result-row ${activeElement === element.id ? "active" : ""}`} onClick={() => setActiveElement(element.id)}>
                      <span className="kind-icon" style={{ color: kindColor[element.type], backgroundColor: `${kindColor[element.type]}12` }}>
                        {element.type === "text" ? <ScanText size={17} /> : element.type === "formula" ? <Sigma size={17} /> : element.type === "image" ? <FileImage size={17} /> : element.type === "diagram-shape" ? <Box size={17} /> : <Workflow size={17} />}
                      </span>
                      <span className="row-main"><b>{kindLabel[element.type]}{result.pages && result.pages.length > 1 ? ` · 第${element.pageNumber || 1}页` : ""}{element.source === "ai-review" ? <small className="ai-corrected">AI 修正</small> : null}</b><em>{element.content}</em>{element.originalContent ? <small className="original-content">原识别：{element.originalContent}</small> : null}</span>
                      <span className="confidence-mini"><i style={{ width: `${element.confidence * 100}%` }} />{Math.round(element.confidence * 100)}%</span>
                    </button>
                  ))}
                </div>
                {selectedElement && (
                  <div className="editor-card">
                    <div className="editor-head"><strong>编辑选中元素</strong><button onClick={() => removeElement(selectedElement.id)}><X size={14} />删除</button></div>
                    <div className="editor-grid">
                      <label><span>元素类型</span><select value={selectedElement.type} onChange={(event) => updateElement(selectedElement.id, { type: event.target.value as ElementKind })}><option value="text">文字</option><option value="formula">公式（OMML/MathType兼容）</option><option value="image">图片</option><option value="diagram-shape">框图节点</option><option value="diagram-connector">连接线</option></select></label>
                      <label className="editor-content"><span>可编辑内容</span><textarea value={selectedElement.content} onChange={(event) => updateElement(selectedElement.id, { content: event.target.value })} /></label>
                    </div>
                  </div>
                )}
              </article>
            )}
          </section>

          <aside className="inspector-column">
            <article className="panel summary-panel">
              <div className="summary-title"><div><span className="eyebrow">LIVE SUMMARY</span><h2>提取摘要</h2></div><Layers3 size={20} /></div>
              <div className="metric-grid">
                <div><span className="metric-icon text"><ScanText size={18} /></span><b>{counts.text}</b><em>文字段</em></div>
                <div><span className="metric-icon formula"><Sigma size={19} /></span><b>{counts.formula}</b><em>公式</em></div>
                <div><span className="metric-icon image"><FileImage size={19} /></span><b>{counts.images}</b><em>图片</em></div>
                <div><span className="metric-icon diagram"><Network size={19} /></span><b>{counts.shapes}</b><em>框图节点</em></div>
              </div>
              <div className={`confidence-card ${result ? "has-result" : ""}`}>
                <div><span>综合置信度</span><small>{result ? "含结构验证" : "完成识别后计算"}</small></div><strong>{result ? confidence.toFixed(1) : "—"}<em>{result ? "%" : ""}</em></strong>
              </div>
            </article>

            <article className="panel export-panel">
              <div className="section-heading"><span className="eyebrow">STEP 03 · EXPORT</span><h2>输出格式</h2></div>
              <div className="format-list">
                {formatOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button key={option.id} className={`format-card ${option.className} ${selectedFormat === option.id ? "selected" : ""}`} onClick={() => setSelectedFormat(option.id)}>
                      <span className="format-icon"><Icon size={23} /></span><span><strong>{option.title}</strong><em>{option.description}</em></span><i>{selectedFormat === option.id && <Check size={13} />}</i>
                    </button>
                  );
                })}
              </div>
              <button className="primary-action" disabled={!result || exporting !== null} onClick={() => runExport(selectedFormat)}>
                {exporting ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}
                {exporting ? "正在生成文件" : result ? `导出${selectedFormat === "word" ? " Word" : selectedFormat === "ppt" ? "可编辑 PPT" : " Visio VDX"}` : "完成识别后导出"}
              </button>
              {result && selectedFormat === "visio" && <button className="svg-export" onClick={() => exportDiagramSvg(result)}><Code2 size={15} />另存为可编辑 SVG</button>}
            </article>

            <article className="panel verify-panel">
              <div className="verify-title"><div><span className="eyebrow">VALIDATION</span><h2>自动验证</h2></div>{result?.verification?.ready ? <span className="ready-badge"><CheckCircle2 size={14} />可导出</span> : <FileCheck2 size={19} />}</div>
              {!result ? (
                <div className="empty-verification"><ShieldCheck size={26} /><p>识别后自动检查图像完整性、元素结构、可编辑内容与框图拓扑。</p></div>
              ) : (
                <div className="check-list">
                  {result.verification?.checks.map((check) => (
                    <div key={check.id} className={check.passed ? "passed" : "failed"}><span>{check.passed ? <Check size={12} /> : <X size={12} />}</span><div><strong>{check.label}</strong><em>{check.detail}</em></div></div>
                  ))}
                  {result.verification?.warnings.map((warning) => <p className="verify-warning" key={warning}>{warning}</p>)}
                  {result.verification?.backend && <p className="backend-proof">后端模型：{result.verification.backend.pipeline}<br />模型哈希：{result.verification.backend.modelHash} · {result.verification.backend.pageCount} 页</p>}
                </div>
              )}
            </article>

            <button className="start-button" disabled={!file || status === "analyzing"} onClick={startAnalysis}>
              {status === "analyzing" ? <LoaderCircle size={19} className="spin" /> : <WandSparkles size={19} />}
              {status === "analyzing" ? "正在智能重构" : status === "done" ? "重新识别" : "开始智能重构"}
            </button>
          </aside>
        </div>
      </section>
    </main>
  );
}
