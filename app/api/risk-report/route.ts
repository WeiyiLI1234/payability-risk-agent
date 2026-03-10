// app/api/risk-report/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getChangedSupplierKeys, getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";

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

    const result = flagSuppliers(rows);

    console.log("[risk-report] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      unflagged: result.unflagged.length,
      ms: Date.now() - start,
    });

    const simpleOutput = buildSimpleFlaggedOutput(result.flagged, reportDate);

    return NextResponse.json({
      scanned_supplier_count: result.total,
      flagged_supplier_count: result.flagged.length,
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