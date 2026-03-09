// app/api/risk-report/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getChangedSupplierKeys, getSupplierRiskInputData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import type { DailyChangeRow } from "@/lib/risk-engine";
import { generateRiskReportJSON } from "@/lib/ai-report";

export async function GET() {
  const start = Date.now();
  const reportDateIso = new Date().toISOString();

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

    const topFlagged = result.flagged;

    const aiReportJson = await generateRiskReportJSON(topFlagged);

    return NextResponse.json({
      success: true,
      report_date: reportDateIso,
      debug: {
        changed_supplier_count: changedSupplierKeys.length,
        rows_length: rows.length,
        sample_rows: rows.slice(0, 3),
        execution_time_ms: Date.now() - start,
      },
      summary: {
        total_suppliers: result.total,
        flagged_count: result.flagged.length,
        unflagged_count: result.unflagged.length,
      },
      ai_report_json: aiReportJson,
      flagged_details: result.flagged.slice(0, 20),
    });
  } catch (error: any) {
    console.error("[risk-report] ERROR", error);

    return NextResponse.json(
      {
        success: false,
        error: error?.message ?? String(error),
        report_date: reportDateIso,
        debug: { execution_time_ms: Date.now() - start },
      },
      { status: 500 }
    );
  }
}