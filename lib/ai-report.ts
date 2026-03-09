// lib/ai-report.ts

import { generateText } from "ai";
import type { FlaggedSupplier } from "@/lib/risk-engine";

export type MetricEntry = {
  metric_id: string;
  value: number | null;
  unit: string;
  explanation: string;
  severity?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  score_contribution?: number;
};

export type SupplierRiskReport = {
  table_name: string;
  supplier_key: string;
  report_date: string;
  headline: string;
  metrics: MetricEntry[];
  trigger_reasons: string[];
  deep_interpretation: string[];
  recommended_actions: string[];
  engine_score_100: number;
  engine_suggested_risk_score: number;
  overall_risk_score: number; // final LLM score, 1-10
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

  const payload = flagged.map((s) => ({
    supplier_key: s.supplier_key,
    supplier_name: s.supplier_name,
    policy_version: s.policy_version,

    engine_score_100: safeNum(s.engine_score_100),
    engine_suggested_risk_score: safeNum(s.engine_suggested_risk_score),

    receivable: safeNum(s.today_receivable),
    chargeback: safeNum(s.today_chargeback),
    computed_net_earning: safeNum(s.today_net_earning),
    available_balance: safeNum(s.today_available_balance),
    outstanding_balance: safeNum(s.today_outstanding_bal),

    receivable_wow_pct: s.receivable_change_pct ?? null,
    liability_wow_pct: s.liability_change_pct ?? null,
    marketplace_payment_change_pct: s.marketplace_payment_change_pct ?? null,
    chargeback_ratio: s.chargeback_ratio ?? null,

    due_from_supplier: safeNum(s.today_due_from_supplier ?? 0),
    due_from_supplier_ratio: s.due_from_supplier_ratio ?? null,
    due_from_supplier_turned_positive: !!s.due_from_supplier_turned_positive,

    flag_reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
    metrics: Array.isArray(s.metrics) ? s.metrics : [],
  }));

  const system = `
You are a senior financial risk analyst at Payability.
You MUST output valid JSON and NOTHING else.

Your job:
- Review each supplier's engine-generated risk signals and raw values.
- Assign a FINAL overall_risk_score from 1 to 10, where 1 is lowest risk and 10 is highest risk.
- Provide deep interpretation of why the supplier is risky or why the risk is manageable.

Important scoring policy:
- Start from engine_suggested_risk_score.
- You may adjust by at most 2 points up or down.
- Do NOT over-penalize pure growth in receivables if repayment quality remains healthy.
- Put heavier emphasis on:
  1) due_from_supplier becoming positive
  2) negative available balance
  3) negative net earning
  4) high chargeback ratio
  5) materially worsening liabilities
  6) meaningful drop in marketplace payments when that data is available
- If due_from_supplier turned positive OR available_balance is materially negative OR chargeback_ratio is extreme, the final score should usually be at least 7 unless there is strong offsetting evidence.

Output JSON only.
`.trim();

  const prompt = `
Return JSON matching this schema exactly:

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
      "headline": string,
      "metrics": [
        {
          "metric_id": string,
          "value": number|null,
          "unit": string,
          "explanation": string,
          "severity": "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
          "score_contribution": number
        }
      ],
      "trigger_reasons": string[],
      "deep_interpretation": string[],
      "recommended_actions": string[],
      "engine_score_100": number,
      "engine_suggested_risk_score": number,
      "overall_risk_score": integer
    }
  ]
}

Rules:
- suppliers array length must equal ${payload.length}
- overall_risk_score must be an INTEGER from 1 to 10
- critical_count = number of suppliers with overall_risk_score 8-10
- high_count = number of suppliers with overall_risk_score 5-7
- moderate_count = number of suppliers with overall_risk_score 1-4
- total_exposure = sum of all outstanding_balance values
- Keep metrics aligned with input metrics; do not invent new numeric values
- trigger_reasons should be concise and specific
- deep_interpretation should be thoughtful and not just restate the numbers
- recommended_actions should be practical for a risk operations team

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
      headline: String(x?.headline ?? ""),
      metrics: Array.isArray(x?.metrics)
        ? x.metrics.map((m: any) => ({
            metric_id: String(m?.metric_id ?? ""),
            value: m?.value === null ? null : safeNum(m?.value),
            unit: String(m?.unit ?? ""),
            explanation: String(m?.explanation ?? ""),
            severity: String(m?.severity ?? "NONE") as MetricEntry["severity"],
            score_contribution: safeNum(m?.score_contribution ?? 0),
          }))
        : [],
      trigger_reasons: Array.isArray(x?.trigger_reasons)
        ? x.trigger_reasons.map(String)
        : [],
      deep_interpretation: Array.isArray(x?.deep_interpretation)
        ? x.deep_interpretation.map(String)
        : [],
      recommended_actions: Array.isArray(x?.recommended_actions)
        ? x.recommended_actions.map(String)
        : [],
      engine_score_100: safeNum(x?.engine_score_100),
      engine_suggested_risk_score: Math.max(
        1,
        Math.min(10, Math.round(safeNum(x?.engine_suggested_risk_score)))
      ),
      overall_risk_score: Math.max(
        1,
        Math.min(10, Math.round(safeNum(x?.overall_risk_score)))
      ),
    })),
  };

  return report;
}