// app/api/risk-report/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getChangedSupplierKeys, getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { RISK_THRESHOLDS } from "@/lib/risk-policy";

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
  const reportDate = reportDateIso.slice(0, 10);

  try {
    console.log("[risk-report] START", reportDateIso);

    // ── Step 1: Fetch from BigQuery ───────────────────────────────────────────
    const changedSupplierKeys = await getChangedSupplierKeys(2);

    console.log("[risk-report] changed suppliers", {
      count: changedSupplierKeys.length,
      ms: Date.now() - start,
    });

    const rowsRaw = await getSupplierRiskInputData({
      supplierKeys: changedSupplierKeys,
      limit: 2000,
    });

    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as DailyChangeRow[];

    console.log("[risk-report] BigQuery done", {
      rows_length: rows.length,
      ms: Date.now() - start,
    });

    // ── Step 2: Run risk engine ───────────────────────────────────────────────
    const result = flagSuppliers(rows);

    console.log("[risk-report] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      unflagged: result.unflagged.length,
      ms: Date.now() - start,
    });

    // Scheme B safety net: only keep suppliers with risk_score >= minFlaggedRiskScore
    const highRiskFlagged = result.flagged.filter(
      (s) => s.engine_suggested_risk_score >= RISK_THRESHOLDS.minFlaggedRiskScore
    );

    const simpleOutput = buildSimpleFlaggedOutput(highRiskFlagged, reportDate);

    console.log("[risk-report] simpleOutput size (bytes)", JSON.stringify(simpleOutput).length);

    // ── Step 3: Insert summary row into agent_runs ────────────────────────────
    const sb = supabaseAdmin();
    console.log("[risk-report] Supabase client initialized");

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
          policy_version: result.flagged[0]?.policy_version ?? null,
          flagged_keys: highRiskFlagged.map((s) => s.supplier_key),
          score_distribution: {
            critical: highRiskFlagged.filter((s) => s.engine_suggested_risk_score >= 8).length,
            high: highRiskFlagged.filter(
              (s) =>
                s.engine_suggested_risk_score >= 5 && s.engine_suggested_risk_score <= 7
            ).length,
          },
        },
      })
      .select("id, created_at")
      .single();

    if (runError) {
      console.error("[risk-report] agent_runs insert failed", runError);
    } else {
      console.log("[risk-report] agent_runs row saved, run_id:", runRow?.id);
    }

    // ── Step 4: Insert one row per flagged supplier into agent_flagged_suppliers
    // Only runs if we successfully got a run_id and have flagged suppliers.
    let supplierRowsInserted = 0;

    if (runRow?.id && highRiskFlagged.length > 0) {
      const supplierRows = highRiskFlagged.map((s) => ({
        run_id: runRow.id,
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        // metrics: triggered metrics only, with full context for analyst review
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
        // reasons: raw array of flag reason strings
        reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
        overall_risk_score: s.engine_suggested_risk_score,
      }));

      const { error: suppliersError, count } = await sb
        .from("agent_flagged_suppliers")
        .insert(supplierRows, { count: "exact" });

      if (suppliersError) {
        console.error("[risk-report] agent_flagged_suppliers insert failed", suppliersError);
      } else {
        supplierRowsInserted = count ?? supplierRows.length;
        console.log("[risk-report] agent_flagged_suppliers rows inserted:", supplierRowsInserted);
      }
    }

    // ── Step 5: Return result ─────────────────────────────────────────────────
    return NextResponse.json({
      run_id: runRow?.id ?? null,
      scanned_supplier_count: result.total,
      flagged_supplier_count: highRiskFlagged.length,
      supplier_rows_inserted: supplierRowsInserted,
      returned_supplier_count: simpleOutput.suppliers.length,
      ...simpleOutput,
    });
  } catch (error: any) {
    console.error("[risk-report] ERROR", error);

    return NextResponse.json(
      {
        success: false,
        error: error?.message ?? String(error),
        report_date: reportDateIso,
      },
      { status: 500 }
    );
  }
}