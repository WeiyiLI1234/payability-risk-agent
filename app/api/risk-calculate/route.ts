export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getDailyChangeData } from "@/lib/bigquery";
import { flagSuppliers } from "@/lib/risk-engine";

export async function GET() {
  try {
    const rows = await getDailyChangeData();
    const result = flagSuppliers(rows);

    return NextResponse.json({
      success: true,
      report_date: new Date().toISOString(),
      summary: {
        total_suppliers: result.total,
        flagged_count: result.flagged.length,
        unflagged_count: result.unflagged.length,
      },
      flagged_suppliers: result.flagged,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
