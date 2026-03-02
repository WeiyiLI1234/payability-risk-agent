export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDailyChangeData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";
import { generateRiskReport } from "@/lib/ai-report";

export async function GET() {
  const start = Date.now();

  try {
    console.log("[risk-report] START", new Date().toISOString());

    // 1️⃣ Query BigQuery
    console.log("[risk-report] Querying BigQuery...");
    const rows = await getDailyChangeData();

    console.log("[risk-report] BigQuery done", {
      rows_length: rows?.length ?? 0,
      ms: Date.now() - start,
    });

    // 2️⃣ Run risk engine
    console.log("[risk-report] Running risk engine...");
    const result = flagSuppliers(rows);

    console.log("[risk-report] Risk engine done", {
      total: result.total,
      flagged: result.flagged.length,
      ms: Date.now() - start,
    });

    // 3️⃣ Generate AI summary (limit to 20 to avoid huge prompt)
    console.log("[risk-report] Generating AI report...");
    const report = await generateRiskReport(
      result.flagged.slice(0, 20)
    );

    console.log("[risk-report] AI done", {
      ms: Date.now() - start,
    });

    // 4️⃣ Return structured JSON
    return NextResponse.json({
      success: true,
      report_date: new Date().toISOString(),

      debug: {
        rows_length: rows?.length ?? 0,
        sample_rows: rows?.slice(0, 3) ?? [],
        execution_time_ms: Date.now() - start,
      },

      summary: {
        total_suppliers: result.total,
        flagged_count: result.flagged.length,
        unflagged_count: result.unflagged.length,
      },

      ai_report: report,

      flagged_details: result.flagged.slice(0, 10),
    });
  } catch (error: any) {
    console.error("[risk-report] ERROR", error);

    return NextResponse.json(
      {
        success: false,
        error: error?.message ?? String(error),
      },
      { status: 500 }
    );
  }
}