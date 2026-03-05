// lib/ai-report.ts (v4: standardized output format)
import { generateText } from "ai";
import type { FlaggedSupplier } from "@/lib/risk-engine";

// === Output types matching target schema ===
export type MetricEntry = {
  metric_id: string;
  value: number | null;
  unit: string;
  explanation: string;
};

export type SupplierRiskReport = {
  table_name: string;
  supplier_key: string;
  report_date: string;
  metrics: MetricEntry[];
  overall_risk_score: number; // 0.00 - 1.00
};

export type RiskReportOutput = {
  report_date: string;
  suppliers_reviewed: number;
  portfolio_summary: {
    critical_count: number;   // score >= 0.8
    high_count: number;       // score 0.5 - 0.79
    moderate_count: number;   // score < 0.5
    total_exposure: number;
    notes: string[];
  };
  suppliers: SupplierRiskReport[];
};

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function stripCodeFences(s: string) {
  return s.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

export async function generateRiskReportJSON(
  flagged: FlaggedSupplier[]
): Promise<RiskReportOutput> {
  const reportDate = new Date().toISOString().slice(0, 10);

  const payload = flagged.map((s) => {
    const receivable = safeNum(s.today_receivable);
    const chargeback = safeNum(s.today_chargeback);
    const computedNet = receivable - chargeback;

    return {
      supplier_key: s.supplier_key,
      supplier_name: s.supplier_name,
      engine_risk_score: s.risk_score,
      receivable,
      chargeback,
      computed_net_earning: computedNet,
      available_balance: safeNum(s.today_available_balance),
      outstanding_balance: safeNum(s.today_outstanding_bal),
      receivable_wow_pct: s.receivable_change_pct ?? null,
      liability_wow_pct: s.liability_change_pct ?? null,
      prev_receivable: safeNum(s.prev_receivable ?? 0),
      prev_liability: safeNum(s.prev_liability ?? 0),
      today_liability: safeNum(s.today_liability),
      flag_reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
    };
  });

  const system = `
You are a financial risk analyst at Payability (Amazon seller cash advance provider).
You MUST output valid JSON and NOTHING else (no markdown, no backticks, no commentary).

For each supplier, output an object with:
- "table_name": always "vm_transaction_summary"
- "supplier_key": from input
- "report_date": "${reportDate}"
- "metrics": array of metric objects, each with:
  - "metric_id": one of RECEIVABLE_WOW_CHANGE, LIABILITY_WOW_CHANGE, CHARGEBACK_RATIO, NET_EARNING, AVAILABLE_BALANCE, OUTSTANDING_EXPOSURE
  - "value": the numeric value
  - "unit": appropriate unit (%, $, ratio)
  - "explanation": 1-sentence explanation of what this metric means for risk
- "overall_risk_score": your independent assessment as a decimal 0.00-1.00
  - 0.00-0.39 = low/moderate risk
  - 0.40-0.69 = elevated risk
  - 0.70-0.89 = high risk
  - 0.90-1.00 = critical risk

Rules:
- Include ALL 6 metric_ids for every supplier, even if value is null
- "explanation" for each metric must reference the actual numbers
- overall_risk_score must reflect the full financial picture, not just flag_reasons
- Do NOT invent data. Use only what is provided.
`.trim();

  const prompt = `
Return JSON matching this schema:

{
  "report_date": "${reportDate}",
  "suppliers_reviewed": ${payload.length},
  "portfolio_summary": {
    "critical_count": number,
    "high_count": number,
    "moderate_count": number,
    "total_exposure": number,
    "notes": string[]
  },
  "suppliers": [
    {
      "table_name": "vm_transaction_summary",
      "supplier_key": string,
      "report_date": "${reportDate}",
      "metrics": [
        { "metric_id": "RECEIVABLE_WOW_CHANGE", "value": number|null, "unit": "%", "explanation": string },
        { "metric_id": "LIABILITY_WOW_CHANGE", "value": number|null, "unit": "%", "explanation": string },
        { "metric_id": "CHARGEBACK_RATIO", "value": number, "unit": "ratio", "explanation": string },
        { "metric_id": "NET_EARNING", "value": number, "unit": "$", "explanation": string },
        { "metric_id": "AVAILABLE_BALANCE", "value": number, "unit": "$", "explanation": string },
        { "metric_id": "OUTSTANDING_EXPOSURE", "value": number, "unit": "$", "explanation": string }
      ],
      "overall_risk_score": number
    }
  ]
}

Constraints:
- suppliers array length must equal ${payload.length}
- portfolio_summary counts based on overall_risk_score: critical >= 0.8, high 0.5-0.79, moderate < 0.5
- total_exposure = sum of all outstanding_balance values
- CHARGEBACK_RATIO = chargeback / receivable (0-1 scale)

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
    if (start >= 0 && end > start) parsed = JSON.parse(raw.slice(start, end + 1));
    else throw new Error("AI report is not valid JSON.");
  }

  const suppliers = Array.isArray(parsed?.suppliers) ? parsed.suppliers : [];

  const report: RiskReportOutput = {
    report_date: String(parsed?.report_date ?? reportDate),
    suppliers_reviewed: safeNum(parsed?.suppliers_reviewed ?? payload.length),
    portfolio_summary: {
      critical_count: safeNum(parsed?.portfolio_summary?.critical_count),
      high_count: safeNum(parsed?.portfolio_summary?.high_count),
      moderate_count: safeNum(parsed?.portfolio_summary?.moderate_count),
      total_exposure: safeNum(parsed?.portfolio_summary?.total_exposure),
      notes: Array.isArray(parsed?.portfolio_summary?.notes)
        ? parsed.portfolio_summary.notes.map(String)
        : [],
    },
    suppliers: suppliers.map((x: any) => ({
      table_name: String(x?.table_name ?? "vm_transaction_summary"),
      supplier_key: String(x?.supplier_key ?? ""),
      report_date: String(x?.report_date ?? reportDate),
      metrics: Array.isArray(x?.metrics)
        ? x.metrics.map((m: any) => ({
            metric_id: String(m?.metric_id ?? ""),
            value: m?.value === null ? null : safeNum(m?.value),
            unit: String(m?.unit ?? ""),
            explanation: String(m?.explanation ?? ""),
          }))
        : [],
      overall_risk_score: Math.max(0, Math.min(1, safeNum(x?.overall_risk_score))),
    })),
  };

  return report;
}

/**
 * Compatibility alias
 */
export async function generateRiskReport(flagged: FlaggedSupplier[]) {
  const json = await generateRiskReportJSON(flagged);
  return JSON.stringify(json, null, 2);
}