// lib/ai-report.ts (v5: risk score 1-10 integer)
import { generateText } from "ai";
import type { FlaggedSupplier } from "@/lib/risk-engine";

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
  overall_risk_score: number; // 1-10 integer, 1 = lowest risk
};

export type RiskReportOutput = {
  report_date: string;
  suppliers_reviewed: number;
  portfolio_summary: {
    critical_count: number;
    high_count: number;
    moderate_count: number;
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
- "metrics": array of 6 metric objects, each with:
  - "metric_id": one of RECEIVABLE_WOW_CHANGE, LIABILITY_WOW_CHANGE, CHARGEBACK_RATIO, NET_EARNING, AVAILABLE_BALANCE, OUTSTANDING_EXPOSURE
  - "value": the numeric value
  - "unit": appropriate unit (%, $, ratio)
  - "explanation": 1-sentence explanation referencing actual numbers
- "overall_risk_score": INTEGER from 1 to 10
  - 1-2: Low risk - healthy financials, normal fluctuations
  - 3-4: Moderate risk - some minor concerns, standard monitoring
  - 5-6: Elevated risk - needs attention within a week
  - 7-8: High risk - manual review required within 24-72h
  - 9-10: Critical risk - immediate escalation/freeze recommended

Scoring guidance for overall_risk_score:
- Start at 1 (healthy baseline)
- Add +1-2 for each significant risk factor:
  - Large WoW receivable swing (>50%): +1, (>200%): +2
  - Large WoW liability increase (>50%): +1, (>200%): +2
  - Chargeback ratio > 0.5: +1, > 0.9: +2
  - Negative net earnings: +1, deeply negative (< -$50K): +2
  - Negative available balance: +2
  - Outstanding exposure > $500K with other flags: +1
- Cap at 10

Rules:
- Include ALL 6 metric_ids for every supplier
- overall_risk_score MUST be an integer 1-10
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
      "overall_risk_score": integer (1-10)
    }
  ]
}

Constraints:
- suppliers array length must equal ${payload.length}
- overall_risk_score must be an INTEGER from 1 to 10. 1 = lowest risk. 10 = highest risk.
- portfolio_summary counts based on overall_risk_score: critical = 8-10, high = 5-7, moderate = 1-4
- total_exposure = sum of all outstanding_balance values
- CHARGEBACK_RATIO = chargeback / receivable (0-1+ scale)

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
      overall_risk_score: Math.max(1, Math.min(10, Math.round(safeNum(x?.overall_risk_score)))),
    })),
  };

  return report;
}

export async function generateRiskReport(flagged: FlaggedSupplier[]) {
  const json = await generateRiskReportJSON(flagged);
  return JSON.stringify(json, null, 2);
}