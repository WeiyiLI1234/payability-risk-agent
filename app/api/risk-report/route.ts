export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";
import { RISK_THRESHOLDS } from "@/lib/risk-policy";
import {
  getBusinessDateNY,
  upsertDailySummaryRunLog,
} from "../../../lib/agentRunLogs";

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
      trigger_reason: Array.isArray(s.flag_reasons) ? s.flag_reasons.join(" ") : "",
      overall_risk_score: s.engine_suggested_risk_score,
    })),
  };
}

export async function GET() {
  const start = Date.now();
  const reportDateIso = new Date().toISOString();
  const businessDate = getBusinessDateNY();
  const reportDate = businessDate;

  try {
    console.log("[risk-report] START", {
      reportDateIso,
      businessDate,
    });

    const rowsRaw = await getSupplierRiskInputData({
      limit: 5000,
    });

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
        report_date: reportDate,
        business_date: businessDate,
        scanned_supplier_count: 0,
        flagged_supplier_count: 0,
        returned_supplier_count: 0,
        suppliers_reviewed: 0,
        suppliers: [],
      });
    }

    const result = flagSuppliers(rows);

    console.log("[risk-report] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      unflagged: result.unflagged.length,
      ms: Date.now() - start,
    });

    const highRiskFlagged = result.flagged.filter(
      (s) => s.engine_suggested_risk_score >= RISK_THRESHOLDS.minFlaggedRiskScore
    );

    const simpleOutput = buildSimpleFlaggedOutput(highRiskFlagged, reportDate);

    await upsertDailySummaryRunLog("success", businessDate);

    return NextResponse.json({
      success: true,
      business_date: businessDate,
      scanned_supplier_count: result.total,
      flagged_supplier_count: highRiskFlagged.length,
      returned_supplier_count: simpleOutput.suppliers.length,
      ...simpleOutput,
    });
  } catch (error: any) {
    console.error("[risk-report] ERROR", error);

    try {
      await upsertDailySummaryRunLog("failed", businessDate);
    } catch (logError) {
      console.error("[risk-report] failed to write agent_run_logs", logError);
    }

    return NextResponse.json(
      {
        success: false,
        error: error?.message ?? String(error),
        report_date: reportDateIso,
        business_date: businessDate,
      },
      { status: 500 }
    );
  }
}