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

  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://payability-risk-agent.vercel.app";

    // Step 1: Run risk report
    const riskRes = await fetch(`${baseUrl}/api/risk-report`);
    const riskData = await riskRes.json();

    console.log("[cron] Risk report done", {
      flagged: riskData.flagged_supplier_count,
    });

    // Step 2: Send Slack alert
    const slackRes = await fetch(`${baseUrl}/api/slack-alert`);
    const slackData = await slackRes.json();

    console.log("[cron] Slack alert done", slackData);

    return NextResponse.json({
      success: true,
      risk: {
        scanned: riskData.scanned_supplier_count,
        flagged: riskData.flagged_supplier_count,
      },
      slack: slackData,
    });
  } catch (error: any) {
    console.error("[cron] ERROR", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}