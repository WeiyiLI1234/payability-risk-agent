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
  supplier_name: string | null;
  metrics: any[] | null;
  reasons: string[] | null;
  overall_risk_score: number | null;
  source: string;
};

type ChangeSummary = {
  supplier_key: string;
  change_type: "new" | "changed";
  changed_fields: string[];
  old_score: number | null;
  new_score: number | null;
  old_reasons: string[];
  new_reasons: string[];
  change_detail: string;
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

function normalizeReasons(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((r) => String(r ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function reasonsChanged(oldReasons: unknown, newReasons: unknown): boolean {
  const oldNorm = normalizeReasons(oldReasons);
  const newNorm = normalizeReasons(newReasons);
  return JSON.stringify(oldNorm) !== JSON.stringify(newNorm);
}

function scoreChanged(
  oldScore: number | null | undefined,
  newScore: number | null | undefined
): boolean {
  if (oldScore == null && newScore == null) return false;
  return Number(oldScore ?? null) !== Number(newScore ?? null);
}

function buildChangeDetail(params: {
  isNew: boolean;
  oldScore: number | null;
  newScore: number | null;
  oldReasons: string[];
  newReasons: string[];
}): { changedFields: string[]; detail: string } {
  const { isNew, oldScore, newScore, oldReasons, newReasons } = params;

  if (isNew) {
    return {
      changedFields: ["new_supplier"],
      detail: `New flagged supplier. Risk score = ${newScore ?? "N/A"}. Trigger reason = ${
        newReasons.length > 0 ? newReasons.join("; ") : "N/A"
      }.`,
    };
  }

  const changedFields: string[] = [];
  const parts: string[] = [];

  if (scoreChanged(oldScore, newScore)) {
    changedFields.push("overall_risk_score");
    parts.push(`risk score changed from ${oldScore ?? "N/A"} to ${newScore ?? "N/A"}`);
  }

  if (reasonsChanged(oldReasons, newReasons)) {
    changedFields.push("trigger_reason");
    parts.push(
      `trigger reason changed from [${
        oldReasons.length > 0 ? oldReasons.join("; ") : "N/A"
      }] to [${newReasons.length > 0 ? newReasons.join("; ") : "N/A"}]`
    );
  }

  return {
    changedFields,
    detail: parts.length > 0 ? parts.join("; ") + "." : "No material change detected.",
  };
}

function getPolicyVersion(
  flagged: FlaggedSupplier[],
  unflagged: FlaggedSupplier[]
): string | null {
  return flagged[0]?.policy_version ?? unflagged[0]?.policy_version ?? null;
}

export async function GET() {
  const start = Date.now();
  const reportDateIso = new Date().toISOString();
  const reportDate = reportDateIso.slice(0, 10);

  try {
    console.log("[risk-report] START", reportDateIso);

    // Step 1: Fetch supplier data
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

    // Step 3: Save one run summary row
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
        },
      })
      .select("id, created_at")
      .single();

    if (runError) {
      console.error("[risk-report] agent_run_daily_summary_report insert failed", runError);
      throw new Error(`Failed to insert agent_run_daily_summary_report: ${runError.message}`);
    }

    console.log("[risk-report] run row saved", { run_id: runRow.id });

    // Step 4: Read current consolidated rows for this source
    const flaggedKeys = highRiskFlagged.map((s) => s.supplier_key);
    let existingMap = new Map<string, ConsolidatedRow>();

    if (flaggedKeys.length > 0) {
      const { data: existingRows, error: existingError } = await sb
        .from("consolidated_flagged_supplier_list")
        .select("supplier_key, supplier_name, metrics, reasons, overall_risk_score, source")
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

    // Step 5: Keep only NEW suppliers or suppliers whose score / reasons changed
    const changedFlaggedSuppliers = highRiskFlagged.filter((s) => {
      const existing = existingMap.get(s.supplier_key);
      if (!existing) return true;

      const scoreDiff = scoreChanged(
        existing.overall_risk_score,
        s.engine_suggested_risk_score
      );

      const reasonsDiff = reasonsChanged(
        existing.reasons,
        Array.isArray(s.flag_reasons) ? s.flag_reasons : []
      );

      return scoreDiff || reasonsDiff;
    });

    console.log("[risk-report] changed/new suppliers", {
      changed_count: changedFlaggedSuppliers.length,
    });

    // Step 6: Append-only insert into daily_summary_report_flagged_suppliers
    let supplierRowsInserted = 0;

    if (changedFlaggedSuppliers.length > 0) {
      const dailyRows = changedFlaggedSuppliers.map((s) => ({
        run_id: runRow.id,
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        metrics: buildDetailedMetrics(s),
        reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
        overall_risk_score: s.engine_suggested_risk_score,
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
      const consolidatedRows = changedFlaggedSuppliers.map((s) => ({
        run_id: runRow.id,
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        metrics: buildDetailedMetrics(s),
        reasons: Array.isArray(s.flag_reasons) ? s.flag_reasons : [],
        overall_risk_score: s.engine_suggested_risk_score,
        source: "daily_summary_report",
      }));

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

    // Step 8: Build detailed change summary for API response
    const supplierChanges: ChangeSummary[] = changedFlaggedSuppliers.map((s) => {
      const existing = existingMap.get(s.supplier_key);
      const oldReasons = normalizeReasons(existing?.reasons);
      const newReasons = normalizeReasons(Array.isArray(s.flag_reasons) ? s.flag_reasons : []);

      const summary = buildChangeDetail({
        isNew: !existing,
        oldScore: existing?.overall_risk_score ?? null,
        newScore: s.engine_suggested_risk_score ?? null,
        oldReasons,
        newReasons,
      });

      return {
        supplier_key: s.supplier_key,
        change_type: existing ? "changed" : "new",
        changed_fields: summary.changedFields,
        old_score: existing?.overall_risk_score ?? null,
        new_score: s.engine_suggested_risk_score ?? null,
        old_reasons: oldReasons,
        new_reasons: newReasons,
        change_detail: summary.detail,
      };
    });

    // Step 9: Return only changed/new suppliers, with change summary
    const responseSuppliers = changedFlaggedSuppliers.map((s) => {
      const change = supplierChanges.find((c) => c.supplier_key === s.supplier_key);

      return {
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
        change_type: change?.change_type ?? "changed",
        changed_fields: change?.changed_fields ?? [],
        change_detail: change?.change_detail ?? "",
        previous_overall_risk_score: change?.old_score ?? null,
        previous_trigger_reasons: change?.old_reasons ?? [],
      };
    });

    return NextResponse.json({
      run_id: runRow.id,
      scanned_supplier_count: result.total,
      flagged_supplier_count: highRiskFlagged.length,
      changed_supplier_count: changedFlaggedSuppliers.length,
      supplier_rows_inserted: supplierRowsInserted,
      consolidated_rows_upserted: consolidatedRowsUpserted,
      report_date: reportDate,
      suppliers_reviewed: responseSuppliers.length,
      suppliers: responseSuppliers,
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