export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL || "https://payability-risk-agent.vercel.app";

  try {
    const riskRes = await fetch(`${baseUrl}/api/risk-report`);

    if (!riskRes.ok) {
      const body = await riskRes.text();
      throw new Error(`Risk report failed with status ${riskRes.status}: ${body}`);
    }

    const riskData = await riskRes.json();

    console.log("[cron] Risk report done", {
      scanned: riskData.scanned_supplier_count,
      flagged: riskData.flagged_supplier_count,
    });

    return NextResponse.json({
      success: true,
      risk: {
        scanned: riskData.scanned_supplier_count,
        flagged: riskData.flagged_supplier_count,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron] ERROR", message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}