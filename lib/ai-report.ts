// lib/ai-report.ts
import { generateText } from "ai";
import type { FlaggedSupplier } from "@/lib/risk-engine";

export type FinalMetricEntry = {
  metric_id: string;
  value: number | null;
  unit: string;
};

export type FinalSupplierRiskReport = {
  table_name: string;
  supplier_key: string;
  supplier_name: string;
  report_date: string;
  metrics: FinalMetricEntry[];
  trigger_reason: string;
  overall_risk_score: number;
};

export type RiskReportOutput = {
  report_date: string;
  suppliers_reviewed: number;
  suppliers: FinalSupplierRiskReport[];
};

type InputMetricForLLM = {
  metric_id: string;
  value: number | null;
  unit: string;
  explanation: string;
  score_contribution: number;
};

type InputSupplierForLLM = {
  supplier_key: string;
  supplier_name: string;
  overall_risk_score: number;
  trigger_reasons: string[];
  metrics: InputMetricForLLM[];
};

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function stripCodeFences(s: string) {
  return s.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

function dedupeStrings(arr: string[]): string[] {
  return [...new Set(arr.map((x) => x.trim()).filter(Boolean))];
}

export async function generateRiskReportJSON(
  flagged: FlaggedSupplier[]
): Promise<RiskReportOutput> {
  const reportDate = new Date().toISOString().slice(0, 10);

  const payload: InputSupplierForLLM[] = flagged.map((s) => ({
    supplier_key: s.supplier_key,
    supplier_name: s.supplier_name,
    overall_risk_score: safeNum(s.engine_suggested_risk_score),
    trigger_reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
    metrics: Array.isArray(s.metrics)
      ? s.metrics
          .filter((m) => safeNum(m?.score_contribution) > 0)
          .map((m) => ({
            metric_id: String(m?.metric_id ?? ""),
            value: m?.value === null ? null : safeNum(m?.value),
            unit: String(m?.unit ?? ""),
            explanation: String(m?.explanation ?? ""),
            score_contribution: safeNum(m?.score_contribution ?? 0),
          }))
      : [],
  }));

  const system = `
You are a senior financial risk analyst at Payability.
You MUST output valid JSON and NOTHING else.

You are NOT responsible for recalculating the risk engine.
The rule engine has already:
- selected flagged suppliers
- determined which metrics materially triggered
- assigned an initial risk score

Your role is only to:
1) convert the structured triggered signals into a concise final trigger_reason
2) lightly calibrate the final overall_risk_score

Rules:
- Use ONLY the triggered metrics and trigger reasons already provided.
- Do NOT invent new metrics, new numbers, or new risk drivers.
- Do NOT include metrics with score_contribution = 0.
- overall_risk_score must remain close to the engine score.
- You may adjust the score by at most 1 point up or down.
- If the engine score already matches the severity pattern, keep it unchanged.
- Do NOT include recommendations.
`.trim();

  const prompt = `
Return JSON matching this schema exactly:

{
  "report_date": "${reportDate}",
  "suppliers_reviewed": ${payload.length},
  "suppliers": [
    {
      "table_name": "vm_transaction_summary",
      "supplier_key": string,
      "supplier_name": string,
      "report_date": "${reportDate}",
      "metrics": [
        {
          "metric_id": string,
          "value": number|null,
          "unit": string
        }
      ],
      "trigger_reason": string,
      "overall_risk_score": integer
    }
  ]
}

Rules:
- suppliers array length must equal ${payload.length}
- metrics must only include metrics from input where score_contribution > 0
- each metric object must contain ONLY:
  - metric_id
  - value
  - unit
- trigger_reason should be one concise paragraph based only on the provided trigger reasons and metric facts
- do not include recommendations
- do not include engine_score_100
- do not include engine_suggested_risk_score
- overall_risk_score may differ from input score by at most 1 point

Input suppliers:
${JSON.stringify(payload)}
`.trim();

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    system,
    prompt,
    temperature: 0.2,
  });

  const raw = stripCodeFences(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } else {
      throw new Error("AI report is not valid JSON.");
    }
  }

  const parsedObj = (parsed ?? {}) as {
    report_date?: string;
    suppliers_reviewed?: number;
    suppliers?: Array<{
      table_name?: string;
      supplier_key?: string;
      supplier_name?: string;
      report_date?: string;
      metrics?: Array<{
        metric_id?: string;
        value?: number | null;
        unit?: string;
      }>;
      trigger_reason?: string;
      overall_risk_score?: number;
    }>;
  };

  const suppliers = Array.isArray(parsedObj.suppliers) ? parsedObj.suppliers : [];

  const report: RiskReportOutput = {
    report_date: String(parsedObj.report_date ?? reportDate),
    suppliers_reviewed: safeNum(parsedObj.suppliers_reviewed ?? payload.length),
    suppliers: suppliers.map((x, idx) => {
      const inputSupplier: InputSupplierForLLM | undefined = payload[idx];

      const metrics: FinalMetricEntry[] = Array.isArray(x?.metrics)
        ? x.metrics.map((m) => ({
            metric_id: String(m?.metric_id ?? ""),
            value: m?.value === null ? null : safeNum(m?.value),
            unit: String(m?.unit ?? ""),
          }))
        : [];

      const filteredMetrics = metrics.filter((m) =>
        inputSupplier?.metrics?.some((im: { metric_id: string }) => im.metric_id === m.metric_id)
      );

      const fallbackTriggerReason = dedupeStrings([
        ...(inputSupplier?.trigger_reasons ?? []),
        "This supplier shows risk signals requiring review based on the triggered metrics above.",
      ]).join(" ");

      return {
        table_name: "vm_transaction_summary",
        supplier_key: String(x?.supplier_key ?? inputSupplier?.supplier_key ?? ""),
        supplier_name: String(x?.supplier_name ?? inputSupplier?.supplier_name ?? ""),
        report_date: String(x?.report_date ?? reportDate),
        metrics: filteredMetrics,
        trigger_reason: String(x?.trigger_reason ?? fallbackTriggerReason),
        overall_risk_score: Math.max(
          1,
          Math.min(
            10,
            Math.round(safeNum(x?.overall_risk_score ?? inputSupplier?.overall_risk_score ?? 5))
          )
        ),
      };
    }),
  };

  return report;
}