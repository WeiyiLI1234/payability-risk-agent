export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDailyChangeData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import { generateRiskReportJSON } from "@/lib/ai-report";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { DailyChangeRow, FlaggedSupplier } from "@/lib/risk-engine";

export async function GET() {
  const start = Date.now();
  const reportDate = new Date().toISOString();

  try {
    console.log("[risk-report] START", reportDate);

    const sb = supabaseAdmin();

    // 1) Query BigQuery
    console.log("[risk-report] Querying BigQuery...");
    const rowsRaw = await getDailyChangeData();
    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as DailyChangeRow[];

    console.log("[risk-report] BigQuery done", {
      rows_length: rows.length,
      ms: Date.now() - start,
    });

    // 2) Run risk engine
    console.log("[risk-report] Running risk engine...");
    const result = flagSuppliers(rows);

    console.log("[risk-report] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      ms: Date.now() - start,
    });

    // 3) Generate AI report
    console.log("[risk-report] Generating AI report...");
    const topFlagged: FlaggedSupplier[] = result.flagged.slice(0, 20);
    const report = await generateRiskReportJSON(topFlagged);

    console.log("[risk-report] AI done", {
      ms: Date.now() - start,
    });

    // 4) Save to Supabase: agent_runs
    console.log("[risk-report] Writing agent_runs...");
    const { data: run, error: runErr } = await sb
      .from("agent_runs")
      .insert({
        report_date: reportDate,
        total_suppliers: result.total,
        flagged_count: result.flagged.length,
        ai_report: typeof report === "string" ? report : JSON.stringify(report),
        debug: {
          source: "manual-risk-report",
          rows_length: rows.length,
          execution_time_ms: Date.now() - start,
        },
      })
      .select("id")
      .single();

    if (runErr) {
      console.error("[risk-report] agent_runs insert error", runErr);
      throw new Error(`Supabase insert agent_runs failed: ${runErr.message}`);
    }

    if (!run?.id) {
      throw new Error("Supabase insert agent_runs failed: missing run id");
    }

    // 5) Save flagged suppliers
    let savedFlagged = 0;

    if (topFlagged.length > 0) {
      console.log("[risk-report] Writing agent_flagged_suppliers...");

      const detailRows = topFlagged.map((s) => ({
        run_id: run.id,
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        metrics: s,
        reasons: s.flag_reasons ?? [],
      }));

      const { error: detailErr } = await sb
        .from("agent_flagged_suppliers")
        .insert(detailRows);

      if (detailErr) {
        console.error("[risk-report] flagged details insert error", detailErr);
        throw new Error(
          `Supabase insert agent_flagged_suppliers failed: ${detailErr.message}`
        );
      }

      savedFlagged = detailRows.length;
    }

    console.log("[risk-report] DONE", {
      run_id: run.id,
      total: result.total,
      flagged: result.flagged.length,
      saved_flagged: savedFlagged,
      ms: Date.now() - start,
    });

    return NextResponse.json({
      success: true,
      run_id: run.id,
      report_date: reportDate,

      debug: {
        rows_length: rows.length,
        sample_rows: rows.slice(0, 3),
        execution_time_ms: Date.now() - start,
      },

      summary: {
        total_suppliers: result.total,
        flagged_count: result.flagged.length,
        unflagged_count: result.unflagged,
        saved_to_db: true,
        saved_flagged: savedFlagged,
      },

      ai_report: report,
      flagged_details: result.flagged.slice(0, 10),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[risk-report] ERROR", error);

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: 500 }
    );
  }
}