// app/api/cron/daily-risk/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDailyChangeData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import { generateRiskReport } from "@/lib/ai-report";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { FlaggedSupplier, DailyChangeRow } from "@/lib/risk-engine";

export async function GET() {
  const start = Date.now();
  const reportDate = new Date().toISOString();

  try {
    console.log("[cron/daily-risk] START", reportDate);

    // Create supabase client once
    const sb = supabaseAdmin();

    // 1) BigQuery
    console.log("[cron/daily-risk] Querying BigQuery...");
    const rowsRaw = await getDailyChangeData();
    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as DailyChangeRow[];
    console.log("[cron/daily-risk] BigQuery done", {
      rows_length: rows.length,
      ms: Date.now() - start,
    });

    // 2) Risk Engine
    console.log("[cron/daily-risk] Running risk engine...");
    const result = flagSuppliers(rows);
    console.log("[cron/daily-risk] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      unflagged: result.unflagged.length,
      ms: Date.now() - start,
    });

    // 3) AI report (limit top 20)
    console.log("[cron/daily-risk] Generating AI report...");
    const topFlagged: FlaggedSupplier[] = result.flagged.slice(0, 20);
    const report = await generateRiskReport(topFlagged);
    console.log("[cron/daily-risk] AI report done", { ms: Date.now() - start });

    // 4) Insert agent_runs
    console.log("[cron/daily-risk] Writing agent_runs...");
    const { data: run, error: runErr } = await sb
      .from("agent_runs")
      .insert({
        report_date: reportDate,
        total_suppliers: result.total,
        flagged_count: result.flagged.length,
        ai_report: report,
        debug: {
          rows_length: rows.length,
          execution_time_ms: Date.now() - start,
        },
      })
      .select("id")
      .single();

    if (runErr) {
      console.error("[cron/daily-risk] agent_runs insert error", runErr);
      throw new Error(`Supabase insert agent_runs failed: ${runErr.message}`);
    }

    if (!run?.id) {
      throw new Error("Supabase insert agent_runs failed: missing run id");
    }

    // 4b) Insert flagged details (top 20)
    let savedFlagged = 0;
    if (topFlagged.length > 0) {
      console.log("[cron/daily-risk] Writing agent_flagged_suppliers...");

      const detailRows = topFlagged.map((s) => ({
        run_id: run.id,
        supplier_key: s.supplier_key,
        supplier_name: s.supplier_name,
        metrics: s, // store the full metrics blob
        reasons: s.flag_reasons ?? [],
      }));

      const { error: detailErr } = await sb.from("agent_flagged_suppliers").insert(detailRows);

      if (detailErr) {
        console.error("[cron/daily-risk] flagged details insert error", detailErr);
        throw new Error(`Supabase insert agent_flagged_suppliers failed: ${detailErr.message}`);
      }

      savedFlagged = detailRows.length;
    }

    console.log("[cron/daily-risk] DONE", {
      run_id: run.id,
      total: result.total,
      flagged: result.flagged.length,
      unflagged: result.unflagged.length,
      saved_flagged: savedFlagged,
      ms: Date.now() - start,
    });

    return NextResponse.json({
      ok: true,
      run_id: run.id,
      report_date: reportDate,
      summary: {
        total_suppliers: result.total,
        flagged_count: result.flagged.length,
        unflagged_count: result.unflagged.length,
        saved_to_db: true,
        saved_flagged: savedFlagged,
      },
      ai_report: report,
      debug: {
        rows_length: rows.length,
        execution_time_ms: Date.now() - start,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[cron/daily-risk] ERROR", e);

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}