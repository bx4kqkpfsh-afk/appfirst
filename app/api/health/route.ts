export async function GET() {
  return Response.json({
    status: "ok",
    service: "docvision-structure-validator",
    version: "1.0.0",
    capabilities: ["schema-validation", "confidence-scoring", "export-readiness"],
    processing: "local-first",
  });
}
