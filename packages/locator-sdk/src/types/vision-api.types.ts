// ---------------------------------------------------------------------------
// Vision API Types — TypeScript mirror of Python responses.py
// ---------------------------------------------------------------------------
// These are the shapes returned by the Python FastAPI service.
// They are declared here (not in strategy.types.ts) to keep the REST API
// contract separate from the SDK's internal domain types.
// ---------------------------------------------------------------------------

export interface VisionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionLocateResponse {
  found: boolean;
  bounding_box: VisionBoundingBox | null;
  confidence: number | null;
  reasoning: string | null;
  latency_ms: number;
}
