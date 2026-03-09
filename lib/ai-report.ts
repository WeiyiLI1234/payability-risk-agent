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

  const payload = flagged.map((s) => ({
    supplier_key: s.supplier_key,
    supplier_name: s.supplier_name,
    overall_risk_score: safeNum(s.engine_suggested_risk_score),
    trigger_reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
    metrics: Array.isArray(s.metrics)
      ? s.metrics
          .filter((m: any) => safeNum(m?.score_contribution) > 0)
          .map((m: any) => ({
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

For each supplier:
- Keep only materially triggered metrics already provided in input.
- Do not add metrics with score_contribution = 0.
- Write one "trigger_reason" paragraph that combines:
  1) the raw trigger reasons
  2) the deeper business interpretation
- Do not include recommendations.
- overall_risk_score must be an integer from 1 to 10.
- You may keep the same score as the input overall_risk_score, or adjust by at most 1 point if clearly justified by the trigger pattern.
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
- trigger_reason should merge trigger reasons with deeper interpretation into one concise paragraph
- do not include recommendation actions
- do not include engine_score_100
- do not include engine_suggested_risk_score

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

  let parsed: any;
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

  const suppliers = Array.isArray(parsed?.suppliers) ? parsed.suppliers : [];

  const report: RiskReportOutput = {
    report_date: String(parsed?.report_date ?? reportDate),
    suppliers_reviewed: safeNum(parsed?.suppliers_reviewed ?? payload.length),
    suppliers: suppliers.map((x: any, idx: number) => {
      const inputSupplier = payload[idx];

      const metrics = Array.isArray(x?.metrics)
        ? x.metrics.map((m: any) => ({
            metric_id: String(m?.metric_id ?? ""),
            value: m?.value === null ? null : safeNum(m?.value),
            unit: String(m?.unit ?? ""),
          }))
        : [];

      const filteredMetrics = metrics.filter((m) =>
        inputSupplier?.metrics?.some((im: any) => im.metric_id === m.metric_id)
      );

      const fallbackTriggerReason = dedupeStrings([
        ...(inputSupplier?.trigger_reasons ?? []),
        `This supplier shows risk signals requiring review based on the triggered metrics above.`,
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
            Math.round(
              safeNum(x?.overall_risk_score ?? inputSupplier?.overall_risk_score ?? 5)
            )
          )
        ),
      };
    }),
  };

  return report;
}