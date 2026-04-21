// lib/supabase-admin.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("SUPABASE_URL is required (missing env var).");
  }
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required (missing env var).");
  }

  _client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  return _client;
}

type FlaggedSupplierRow = {
  supplier_key: string;
  supplier_name: string;
  overall_risk_score: number;
  metrics: object[];
  reasons: string[];
};

export async function upsertFlaggedSuppliers(
  suppliers: FlaggedSupplierRow[],
  businessDate: string,
  runId: string
): Promise<{ inserted: number; skipped: number }> {
  if (suppliers.length === 0) return { inserted: 0, skipped: 0 };

  const sb = supabaseAdmin();

  // Delete today's existing records for these suppliers before reinserting
  const { error: deleteError } = await sb
    .from("consolidated_flagged_supplier_list")
    .delete()
    .eq("created_date", businessDate)
    .in(
      "supplier_key",
      suppliers.map((s) => s.supplier_key)
    );

  if (deleteError) {
    throw new Error(
      `consolidated_flagged_supplier_list delete failed: ${deleteError.message}`
    );
  }

  const rows = suppliers.map((s) => ({
    supplier_key: s.supplier_key,
    supplier_name: s.supplier_name,
    overall_risk_score: s.overall_risk_score,
    metrics: s.metrics,
    reasons: s.reasons,
    source: "risk_agent",
    status: "flagged",
    created_date: businessDate,
    run_id: runId,
    created_at: new Date().toISOString(),
  }));

  const { error: insertError } = await sb
    .from("consolidated_flagged_supplier_list")
    .insert(rows);

  if (insertError) {
    throw new Error(
      `consolidated_flagged_supplier_list insert failed: ${insertError.message}`
    );
  }

  return { inserted: suppliers.length, skipped: 0 };
}