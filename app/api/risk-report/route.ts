export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";
import {
  getBusinessDateNY,
  upsertDailySummaryRunLog,
} from "@/lib/agentRunLogs";
import { generateRiskReportJSON } from "@/lib/ai-report";
import { upsertFlaggedSuppliers } from "@/lib/supabase-admin";

const AI_SCORE_THRESHOLD = 6; // score >= 6 走 LLM，其余直接拼装

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
  const reportDateIso = new Date().toISOString();
  const businessDate = getBusinessDateNY();
  const runId = randomUUID();

  // Dry-run: ?dry_run=true in URL, or DAILY_SUMMARY_DRY_RUN=true env var
  const url = new URL(request.url);
  const isDryRun =
    url.searchParams.get("dry_run") === "true" ||
    process.env.DAILY_SUMMARY_DRY_RUN === "true";

  try {
    console.log("[risk-report] START", {
      reportDateIso,
      businessDate,
      runId,
      dry_run: isDryRun,
    });

    const rowsRaw = await getSupplierRiskInputData({ limit: 5000 });
    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as DailyChangeRow[];

    console.log("[risk-report] BigQuery done", {
      rows_length: rows.length,
      ms: Date.now() - start,
    });

    if (rows.length === 0) {
      if (!isDryRun) {
        await upsertDailySummaryRunLog("skipped", businessDate);
      } else {
        console.log("[risk-report] DRY RUN — skipping agent_run_logs write");
      }

      return NextResponse.json({
        success: true,
        dry_run: isDryRun,
        skipped: true,
        reason: "No eligible supplier rows returned from BigQuery",
        report_date: businessDate,
        business_date: businessDate,
        scanned_supplier_count: 0,
        flagged_supplier_count: 0,
        suppliers: [],
      });
    }

    const result = flagSuppliers(rows);

    console.log("[risk-report] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      ms: Date.now() - start,
    });

    // Split: high risk → LLM, low risk → fallback
    const highRisk = result.flagged.filter(
      (s) => s.engine_suggested_risk_score >= AI_SCORE_THRESHOLD
    );
    const lowRisk = result.flagged.filter(
      (s) => s.engine_suggested_risk_score < AI_SCORE_THRESHOLD
    );

    console.log("[risk-report] AI split", {
      high_risk: highRisk.length,
      low_risk: lowRisk.length,
      ms: Date.now() - start,
    });

    // Only send high risk suppliers to LLM
    const aiReport =
      highRisk.length > 0
        ? await generateRiskReportJSON(highRisk)
        : { suppliers: [] };

    console.log("[risk-report] AI report done", {
      ai_suppliers: aiReport.suppliers.length,
      ms: Date.now() - start,
    });

    // Low risk suppliers use fallback (no LLM)
    const lowRiskSuppliers = lowRisk.map((s) =>
      buildFallbackSupplier(s, businessDate)
    );

    const allSuppliers = [...aiReport.suppliers, ...lowRiskSuppliers];

    if (isDryRun) {
      // DRY RUN — skip all Supabase writes
      console.log(
        "[risk-report] DRY RUN — skipping Supabase writes and agent_run_logs"
      );
      return NextResponse.json({
        success: true,
        dry_run: true,
        report_date: businessDate,
        business_date: businessDate,
        run_id: runId,
        scanned_supplier_count: result.total,
        flagged_supplier_count: allSuppliers.length,
        ai_processed_count: aiReport.suppliers.length,
        fallback_count: lowRiskSuppliers.length,
        suppliers: allSuppliers,
      });
    }

    // Write to Supabase (production only)
    const { inserted, skipped } = await upsertFlaggedSuppliers(
      allSuppliers.map((s) => ({
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        overall_risk_score: s.overall_risk_score,
        metrics: s.metrics,
        reasons: [s.trigger_reason],
      })),
      businessDate,
      runId
    );

    console.log("[risk-report] Supabase upsert done", {
      inserted,
      skipped,
      ms: Date.now() - start,
    });

    await upsertDailySummaryRunLog("success", businessDate);

    return NextResponse.json({
      success: true,
      dry_run: false,
      report_date: businessDate,
      business_date: businessDate,
      run_id: runId,
      scanned_supplier_count: result.total,
      flagged_supplier_count: allSuppliers.length,
      ai_processed_count: aiReport.suppliers.length,
      fallback_count: lowRiskSuppliers.length,
      suppliers: allSuppliers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[risk-report] ERROR", message);

    if (!isDryRun) {
      try {
        await upsertDailySummaryRunLog("failed", businessDate);
      } catch (logError) {
        console.error("[risk-report] failed to write agent_run_logs", logError);
      }
    }

    return NextResponse.json(
      {
        success: false,
        dry_run: isDryRun,
        error: message,
        report_date: reportDateIso,
        business_date: businessDate,
      },
      { status: 500 }
    );
  }
}
