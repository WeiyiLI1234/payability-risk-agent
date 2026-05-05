export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/risk-report/dry-run
 *
 * Runs the full Daily Summary Report pipeline (BigQuery reads, risk engine,
 * LLM analysis) but skips ALL writes to Supabase and agent_run_logs.
 * Safe to call at any time without affecting production data.
 *
 * Usage:
 *   curl https://payability-risk-agent.vercel.app/api/risk-report/dry-run
 *   curl https://payability-risk-agent.vercel.app/api/risk-report/dry-run?no_llm=true
 *
 * Query params:
 *   no_llm=true   Skip LLM calls (rule engine scores only, faster)
 */

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";
import { getBusinessDateNY } from "@/lib/agentRunLogs";
import { generateRiskReportJSON } from "@/lib/ai-report";

const AI_SCORE_THRESHOLD = 6;

function buildFallbackSupplier(s: FlaggedSupplier, reportDate: string) {
  return {
    table_name: "vm_transaction_summary",
    supplier_key: s.supplier_key,
    supplier_name: s.supplier_name,
    report_date: reportDate,
    metrics: s.metrics
      .filter((m) => m.score_contribution > 0)
      .map((m) => ({
        metric_id: m.metric_id,
        value: m.value,
        unit: m.unit,
      })),
    trigger_reason: Array.isArray(s.flag_reasons)
      ? s.flag_reasons.join(" ")
      : "",
    overall_risk_score: s.engine_suggested_risk_score,
  };
}

export async function GET(request: Request) {
  const start = Date.now();
  const businessDate = getBusinessDateNY();
  const runId = randomUUID();

  const url = new URL(request.url);
  const noLlm = url.searchParams.get("no_llm") === "true";

  console.log("[risk-report/dry-run] START", {
    businessDate,
    runId,
    no_llm: noLlm,
  });

  try {
    // Step 1: BigQuery read
    const rowsRaw = await getSupplierRiskInputData({ limit: 5000 });
    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as DailyChangeRow[];

    console.log("[risk-report/dry-run] BigQuery done", {
      rows_length: rows.length,
      ms: Date.now() - start,
    });

    if (rows.length === 0) {
      return NextResponse.json({
        success: true,
        dry_run: true,
        skipped: true,
        reason: "No eligible supplier rows returned from BigQuery",
        report_date: businessDate,
        scanned_supplier_count: 0,
        flagged_supplier_count: 0,
        suppliers: [],
      });
    }

    // Step 2: Risk engine
    const result = flagSuppliers(rows);

    console.log("[risk-report/dry-run] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      ms: Date.now() - start,
    });

    // Step 3: LLM (optional)
    const highRisk = result.flagged.filter(
      (s) => s.engine_suggested_risk_score >= AI_SCORE_THRESHOLD
    );
    const lowRisk = result.flagged.filter(
      (s) => s.engine_suggested_risk_score < AI_SCORE_THRESHOLD
    );

    let aiSuppliers: Awaited<ReturnType<typeof generateRiskReportJSON>>["suppliers"] = [];

    if (noLlm) {
      console.log("[risk-report/dry-run] Skipping LLM (no_llm=true)");
    } else if (highRisk.length > 0) {
      const aiReport = await generateRiskReportJSON(highRisk);
      aiSuppliers = aiReport.suppliers;
      console.log("[risk-report/dry-run] LLM done", {
        ai_suppliers: aiSuppliers.length,
        ms: Date.now() - start,
      });
    }

    const lowRiskSuppliers = lowRisk.map((s) =>
      buildFallbackSupplier(s, businessDate)
    );

    // If no_llm, build fallback for high risk too
    const highRiskFallback = noLlm
      ? highRisk.map((s) => buildFallbackSupplier(s, businessDate))
      : [];

    const allSuppliers = [...aiSuppliers, ...highRiskFallback, ...lowRiskSuppliers];

    // Step 4: NO Supabase writes — dry run ends here
    console.log(
      "[risk-report/dry-run] COMPLETE — no writes to Supabase or agent_run_logs"
    );

    return NextResponse.json({
      success: true,
      dry_run: true,
      no_llm: noLlm,
      report_date: businessDate,
      run_id: runId,
      scanned_supplier_count: result.total,
      flagged_supplier_count: allSuppliers.length,
      ai_processed_count: aiSuppliers.length,
      fallback_count: lowRiskSuppliers.length + highRiskFallback.length,
      duration_ms: Date.now() - start,
      suppliers: allSuppliers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[risk-report/dry-run] ERROR", message);

    // No agent_run_logs write in dry run
    return NextResponse.json(
      {
        success: false,
        dry_run: true,
        error: message,
        report_date: businessDate,
      },
      { status: 500 }
    );
  }
}
