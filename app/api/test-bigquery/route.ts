export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { BigQuery } from "@google-cloud/bigquery";
import { NextResponse } from "next/server";

const bigquery = new BigQuery({
  projectId: "bigqueryexport-183608",
});

export async function GET() {
  try {
    const query = `
      SELECT 
        supplier_name,
        COUNT(*) as txn_count,
        ROUND(SUM(net_earning), 2) as total_net_earning,
        ROUND(SUM(chargeback), 2) as total_chargeback,
        ROUND(SUM(receivable), 2) as total_receivable,
        MIN(xact_post_date) as earliest_txn,
        MAX(xact_post_date) as latest_txn
      FROM PayabilitySheets.vm_transaction_summary
      GROUP BY supplier_name
      ORDER BY total_receivable DESC
      LIMIT 20
    `;

    const [rows] = await bigquery.query({ query });

    return NextResponse.json({
      success: true,
      supplier_count: rows.length,
      data: rows,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}