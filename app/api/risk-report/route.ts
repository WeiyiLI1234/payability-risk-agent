export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { RISK_THRESHOLDS } from "@/lib/risk-policy";

type ConsolidatedRow = {
  supplier_key: string;
  source: string;
  supplier_name: string | null;
  latest_overall_risk_score: number | null;
  times_flagged: number | null;
  first_flagged_date: string | null;
};

function buildDetailedMetrics(s: FlaggedSupplier) {
  return Array.isArray(s.metrics)
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
    : [];
}

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

function getPolicyVersion(
  flagged: FlaggedSupplier[],
  unflagged: FlaggedSupplier[]
): string | null {
  return flagged[0]?.policy_version ?? unflagged[0]?.policy_version ?? null;
}

function scoreChanged(
  oldScore: number | null | undefined,
  newScore: number | null | undefined
) {
  if (oldScore == null && newScore == null) return false;
  return Number(oldScore ?? null) !== Number(newScore ?? null);
}

export async function GET() {
  const start = Date.now();
  const reportDateIso = new Date().toISOString();
  const reportDate = reportDateIso.slice(0, 10);

  try {
    console.log("[risk-report] START", reportDateIso);

    // Step 1: Fetch supplier data from BigQuery
    const rowsRaw = await getSupplierRiskInputData({ limit: 5000 });
    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as DailyChangeRow[];

    console.log("[risk-report] BigQuery done", {
      rows_length: rows.length,
      ms: Date.now() - start,
    });

    if (rows.length === 0) {
      return NextResponse.json({
        run_id: null,
        scanned_supplier_count: 0,
        flagged_supplier_count: 0,
        changed_supplier_count: 0,
        supplier_rows_inserted: 0,
        consolidated_rows_upserted: 0,
        returned_supplier_count: 0,
        report_date: reportDate,
        suppliers_reviewed: 0,
        suppliers: [],
      });
    }

    // Step 2: Run risk engine
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

    const sb = supabaseAdmin();
    const policyVersion = getPolicyVersion(result.flagged, result.unflagged);

    // Step 3: Save one run row
    const { data: runRow, error: runError } = await sb
      .from("agent_run_daily_summary_report")
      .insert({
        report_date: reportDate,
        total_suppliers: result.total,
        flagged_count: highRiskFlagged.length,
        debug: {
          duration_ms: Date.now() - start,
          policy_version: policyVersion,
          flagged_keys: highRiskFlagged.map((s) => s.supplier_key),
          score_distribution: {
            critical: highRiskFlagged.filter((s) => s.engine_suggested_risk_score >= 8).length,
            high: highRiskFlagged.filter(
              (s) =>
                s.engine_suggested_risk_score >= 5 &&
                s.engine_suggested_risk_score <= 7
            ).length,
            monitor: highRiskFlagged.filter(
              (s) =>
                s.engine_suggested_risk_score >= 3 &&
                s.engine_suggested_risk_score <= 4
            ).length,
          },
        },
      })
      .select("id, created_at")
      .single();

    if (runError) {
      console.error("[risk-report] agent_run_daily_summary_report insert failed", runError);
      throw new Error(`Failed to insert agent_run_daily_summary_report: ${runError.message}`);
    }

    console.log("[risk-report] run row saved", { run_id: runRow.id });

    // Step 4: Read existing latest records from consolidated for this source
    const flaggedKeys = highRiskFlagged.map((s) => s.supplier_key);
    let existingMap = new Map<string, ConsolidatedRow>();

    if (flaggedKeys.length > 0) {
      const { data: existingRows, error: existingError } = await sb
        .from("consolidated_flagged_supplier_list")
        .select(
          "supplier_key, source, supplier_name, latest_overall_risk_score, times_flagged, first_flagged_date"
        )
        .eq("source", "daily_summary_report")
        .in("supplier_key", flaggedKeys);

      if (existingError) {
        console.error("[risk-report] consolidated read failed", existingError);
        throw new Error(
          `Failed to read consolidated_flagged_supplier_list: ${existingError.message}`
        );
      }

      existingMap = new Map(
        (existingRows ?? []).map((row) => [row.supplier_key, row as ConsolidatedRow])
      );
    }

    // Step 5: Only keep NEW suppliers or suppliers whose risk score changed
    const changedFlaggedSuppliers = highRiskFlagged.filter((s) => {
      const existing = existingMap.get(s.supplier_key);
      if (!existing) return true;
      return scoreChanged(existing.latest_overall_risk_score, s.engine_suggested_risk_score);
    });

    console.log("[risk-report] changed/new suppliers", {
      changed_count: changedFlaggedSuppliers.length,
    });

    // Step 6: Append-only insert into daily_summary_report_flagged_suppliers
    let supplierRowsInserted = 0;

    if (changedFlaggedSuppliers.length > 0) {
      const dailyRows = changedFlaggedSuppliers.map((s) => ({
        run_id: runRow.id,
        report_date: reportDate,
        source_table: "vm_transaction_summary",
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        metrics: buildDetailedMetrics(s),
        reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
        trigger_reason: Array.isArray(s.flag_reasons) ? s.flag_reasons.join(" ") : "",
        overall_risk_score: s.engine_suggested_risk_score,
        policy_version: s.policy_version ?? policyVersion,
        source: "daily_summary_report",
      }));

      const { error: dailyInsertError, count } = await sb
        .from("daily_summary_report_flagged_suppliers")
        .insert(dailyRows, { count: "exact" });

      if (dailyInsertError) {
        console.error(
          "[risk-report] daily_summary_report_flagged_suppliers insert failed",
          dailyInsertError
        );
        throw new Error(
          `Failed to insert daily_summary_report_flagged_suppliers: ${dailyInsertError.message}`
        );
      }

      supplierRowsInserted = count ?? dailyRows.length;
    }

    // Step 7: Upsert latest state into consolidated_flagged_supplier_list
    let consolidatedRowsUpserted = 0;

    if (changedFlaggedSuppliers.length > 0) {
      const consolidatedRows = changedFlaggedSuppliers.map((s) => {
        const existing = existingMap.get(s.supplier_key);

        return {
          supplier_key: s.supplier_key,
          source: "daily_summary_report",
          supplier_name: s.supplier_name,
          first_flagged_date: existing?.first_flagged_date ?? reportDate,
          last_flagged_date: reportDate,
          times_flagged: (existing?.times_flagged ?? 0) + 1,
          latest_run_id: runRow.id,
          latest_report_date: reportDate,
          latest_overall_risk_score: s.engine_suggested_risk_score,
          latest_metrics: buildDetailedMetrics(s),
          latest_reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
          latest_trigger_reason: Array.isArray(s.flag_reasons)
            ? s.flag_reasons.join(" ")
            : "",
          policy_version: s.policy_version ?? policyVersion,
          source_table: "vm_transaction_summary",
          updated_at: reportDateIso,
        };
      });

      const { error: upsertError, count } = await sb
        .from("consolidated_flagged_supplier_list")
        .upsert(consolidatedRows, {
          onConflict: "supplier_key,source",
          count: "exact",
        });

      if (upsertError) {
        console.error("[risk-report] consolidated upsert failed", upsertError);
        throw new Error(
          `Failed to upsert consolidated_flagged_supplier_list: ${upsertError.message}`
        );
      }

      consolidatedRowsUpserted = count ?? consolidatedRows.length;
    }

    // Step 8: Return only changed/new suppliers
    const simpleOutput = buildSimpleFlaggedOutput(changedFlaggedSuppliers, reportDate);

    return NextResponse.json({
      run_id: runRow.id,
      scanned_supplier_count: result.total,
      flagged_supplier_count: highRiskFlagged.length,
      changed_supplier_count: changedFlaggedSuppliers.length,
      supplier_rows_inserted: supplierRowsInserted,
      consolidated_rows_upserted: consolidatedRowsUpserted,
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