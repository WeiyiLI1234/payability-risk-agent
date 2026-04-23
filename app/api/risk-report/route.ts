export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow } from "@/lib/risk-engine";
import {
  getBusinessDateNY,
  upsertDailySummaryRunLog,
} from "@/lib/agentRunLogs";
import { generateRiskReportJSON } from "@/lib/ai-report";
import { upsertFlaggedSuppliers } from "@/lib/supabase-admin";

export async function GET() {
  const start = Date.now();
  const reportDateIso = new Date().toISOString();
  const businessDate = getBusinessDateNY();
  const runId = randomUUID();

  try {
    console.log("[risk-report] START", { reportDateIso, businessDate, runId });

    const rowsRaw = await getSupplierRiskInputData({ limit: 5000 });
    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as DailyChangeRow[];

    console.log("[risk-report] BigQuery done", {
      rows_length: rows.length,
      ms: Date.now() - start,
    });

    if (rows.length === 0) {
      await upsertDailySummaryRunLog("skipped", businessDate);

      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "No eligible supplier rows returned from BigQuery",
        report_date: businessDate,
        business_date: businessDate,
        scanned_supplier_count: 0,
        flagged_supplier_count: 0,
        suppliers: [],
      });
    }

    // Step 1: Rule engine
    const result = flagSuppliers(rows);

    console.log("[risk-report] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      ms: Date.now() - start,
    });

    // Step 2: AI layer — LLM润色 trigger_reason，轻微校准 overall_risk_score
    const report = await generateRiskReportJSON(result.flagged);

    console.log("[risk-report] AI report done", {
      suppliers_in_report: report.suppliers.length,
      ms: Date.now() - start,
    });

    // Step 3: Write to Supabase
    const { inserted, skipped } = await upsertFlaggedSuppliers(
      report.suppliers.map((s) => ({
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
      report_date: businessDate,
      business_date: businessDate,
      run_id: runId,
      scanned_supplier_count: result.total,
      flagged_supplier_count: report.suppliers.length,
      suppliers: report.suppliers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[risk-report] ERROR", message);

    try {
      await upsertDailySummaryRunLog("failed", businessDate);
    } catch (logError) {
      console.error("[risk-report] failed to write agent_run_logs", logError);
    }

    return NextResponse.json(
      {
        success: false,
        error: message,
        report_date: reportDateIso,
        business_date: businessDate,
      },
      { status: 500 }
    );
  }
}