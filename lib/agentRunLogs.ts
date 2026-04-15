import { supabaseAdmin } from "@/lib/supabase-admin";

export type AgentRunStatus = "success" | "failed" | "skipped";

export function getBusinessDateNY(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function upsertDailySummaryRunLog(
  status: AgentRunStatus,
  businessDate?: string
) {
  const sb = supabaseAdmin();
  const resolvedBusinessDate = businessDate ?? getBusinessDateNY();

  const { error } = await sb.from("agent_run_logs").upsert(
    {
      agent_key: "daily_summary_report",
      business_date: resolvedBusinessDate,
      status,
      finished_at: new Date().toISOString(),
    },
    {
      onConflict: "agent_key,business_date",
    }
  );

  if (error) {
    throw new Error(`agent_run_logs upsert failed: ${error.message}`);
  }
}