export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { RISK_THRESHOLDS } from "@/lib/risk-policy";
import {
  getBusinessDateNY,
  upsertDailySummaryRunLog,
} from "@/lib/agent-run-logs";

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
        run_id: null,
        scanned_supplier_count: 0,
        flagged_supplier_count: 0,
        supplier_rows_inserted: 0,
        returned_supplier_count: 0,
        report_date: reportDate,
        business_date: businessDate,
        suppliers_reviewed: 0,
        suppliers: [],
        skipped: true,
        reason: "No eligible supplier rows returned from BigQuery",
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

    const sb = supabaseAdmin();

    const { data: runRow, error: runError } = await sb
      .from("agent_runs")
      .insert({
        report_date: reportDate,
        total_suppliers: result.total,
        flagged_count: highRiskFlagged.length,
        ai_report: JSON.stringify({
          report_date: simpleOutput.report_date,
          suppliers_reviewed: simpleOutput.suppliers_reviewed,
          suppliers: simpleOutput.suppliers.map((s) => ({
            supplier_key: s.supplier_key,
            supplier_name: s.supplier_name,
            overall_risk_score: s.overall_risk_score,
            trigger_reason: s.trigger_reason,
          })),
        }),
        debug: {
          duration_ms: Date.now() - start,
          business_date: businessDate,
          policy_version: result.flagged[0]?.policy_version ?? null,
          flagged_keys: highRiskFlagged.map((s) => s.supplier_key),
          score_distribution: {
            critical: highRiskFlagged.filter((s) => s.engine_suggested_risk_score >= 8).length,
            high: highRiskFlagged.filter(
              (s) =>
                s.engine_suggested_risk_score >= 5 &&
                s.engine_suggested_risk_score <= 7
            ).length,
          },
        },
      })
      .select("id, created_at")
      .single();

    if (runError) {
      throw new Error(`agent_runs insert failed: ${runError.message}`);
    }

    let supplierRowsInserted = 0;

    if (runRow?.id && highRiskFlagged.length > 0) {
      const supplierRows = highRiskFlagged.map((s) => ({
        run_id: runRow.id,
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        metrics: Array.isArray(s.metrics)
          ? s.metrics
              .filter((m) => Number(m?.score_contribution ?? 0) > 0)
              .map((m) => ({
                metric_id: m.metric_id,
                value: m.value,
                unit: m.unit,
                severity: m.severity,
                score_contribution: m.score_contribution,
                explanation: m.explanation,
              }))
          : [],
        reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
        overall_risk_score: s.engine_suggested_risk_score,
      }));

      const { error: suppliersError, count } = await sb
        .from("agent_flagged_suppliers")
        .insert(supplierRows, { count: "exact" });

      if (suppliersError) {
        throw new Error(`agent_flagged_suppliers insert failed: ${suppliersError.message}`);
      }

      supplierRowsInserted = count ?? supplierRows.length;
    }

    await upsertDailySummaryRunLog("success", businessDate);

    return NextResponse.json({
      run_id: runRow?.id ?? null,
      scanned_supplier_count: result.total,
      flagged_supplier_count: highRiskFlagged.length,
      supplier_rows_inserted: supplierRowsInserted,
      returned_supplier_count: simpleOutput.suppliers.length,
      business_date: businessDate,
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