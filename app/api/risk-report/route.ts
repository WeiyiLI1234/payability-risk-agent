export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";
import { RISK_THRESHOLDS } from "@/lib/risk-policy";
import {
  getBusinessDateNY,
  upsertDailySummaryRunLog,
} from "@/lib/agentRunLogs";
import { upsertFlaggedSuppliers } from "@/lib/supabase-admin";

function buildSimpleFlaggedOutput(flagged: FlaggedSupplier[], reportDate: string) {
  return {
    report_date: reportDate,
    suppliers_reviewed: flagged.length,
    suppliers: flagged.map((s) => ({
      table_name: "vm_transaction_summary",
      supplier_key: s.supplier_key,
      supplier_name: s.supplier_name,
      report_date: reportDate,
      metrics: Array.isArray(s.metrics)
        ? s.metrics
            .filter((m) => Number(m?.score_contribution ?? 0) > 0)
            .map((m) => ({
              metric_id: m.metric_id,
              value: m.value,
              unit: m.unit,
            }))
        : [],
      trigger_reason: Array.isArray(s.flag_reasons)
        ? s.flag_reasons.join(" ")
        : "",
      overall_risk_score: s.engine_suggested_risk_score,
      reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
    })),
  };
}

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

    const result = flagSuppliers(rows);

    console.log("[risk-report] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      ms: Date.now() - start,
    });

    const simpleOutput = buildSimpleFlaggedOutput(result.flagged, businessDate);

    // Write flagged suppliers to Supabase
    await upsertFlaggedSuppliers(
      simpleOutput.suppliers.map((s) => ({
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        overall_risk_score: s.overall_risk_score,
        metrics: s.metrics,
        reasons: s.reasons,
      })),
      businessDate,
      runId
    );

    console.log("[risk-report] Supabase upsert done", {
      count: simpleOutput.suppliers.length,
      ms: Date.now() - start,
    });

    await upsertDailySummaryRunLog("success", businessDate);

    return NextResponse.json({
      success: true,
      report_date: businessDate,
      business_date: businessDate,
      run_id: runId,
      scanned_supplier_count: result.total,
      flagged_supplier_count: result.flagged.length,
      suppliers: simpleOutput.suppliers,
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