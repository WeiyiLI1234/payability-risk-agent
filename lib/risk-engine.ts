// lib/risk-engine.ts (v2: tighter WoW + absolute delta gate)

export type DailyChangeRow = {
  supplier_key: string;
  supplier_name: string;

  today_receivable: number;
  prev_receivable: number | null;

  today_liability: number;
  prev_liability: number | null;

  today_net_earning: number; // keep for display/debug only (NOT used for rule decision)
  today_chargeback: number;

  today_available_balance: number;
  today_outstanding_bal: number;

  receivable_change_pct: number | null;
  liability_change_pct: number | null;

  has_prev_week_data: boolean;
};

export type FlaggedSupplier = DailyChangeRow & {
  receivable_flagged: boolean;
  liability_flagged: boolean;
  net_earning_flagged: boolean;
  available_balance_flagged: boolean;
  flag_reasons: string[];
};

export type FlagSuppliersResult = {
  total: number;
  flagged: FlaggedSupplier[];
  unflagged: FlaggedSupplier[];
};

/**
 * =========================
 * THRESHOLDS (tune here)
 * =========================
 *
 * Goal: produce a manageable manual-review list.
 * WoW % change can be noisy -> require BOTH:
 * - pct threshold
 * - material base amount
 * - absolute delta threshold
 */
const THRESHOLDS = {
  // Rule 1: WoW absolute % change threshold
  WOW_PCT_THRESHOLD: 50,

  // Rule 1 materiality: require metric "large enough"
  MIN_BASE_RECEIVABLE: 25_000,
  MIN_BASE_LIABILITY: 25_000,

  // Rule 1 delta gate: require absolute move in dollars
  MIN_ABS_DELTA_RECEIVABLE: 10_000,
  MIN_ABS_DELTA_LIABILITY: 10_000,

  // Rule 2: computed net earnings = receivables - chargebacks
  // Add materiality to avoid flagging tiny negatives
  MIN_NEG_NET_EARNING: -5_000,
  MIN_CHARGEBACK_FOR_NET_RULE: 2_000,

  // Rule 3: available balance negative threshold
  MIN_NEG_AVAILABLE_BALANCE: -5_000,
};

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n: number) {
  const x = safeNum(n);
  return `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number) {
  const x = safeNum(n);
  return `${x.toFixed(2)}%`;
}

function baseAbs(today: number, prev: number | null) {
  return Math.max(Math.abs(safeNum(today)), Math.abs(safeNum(prev ?? 0)));
}

export function flagSuppliers(rows: DailyChangeRow[]): FlagSuppliersResult {
  // counters for quick sanity checks
  let wowCount = 0;
  let negNetCount = 0;
  let negBalCount = 0;

  const scored: FlaggedSupplier[] = rows.map((r) => {
    const reasons: string[] = [];

    const todayReceivable = safeNum(r.today_receivable);
    const prevReceivable = r.prev_receivable === null ? null : safeNum(r.prev_receivable);

    const todayLiability = safeNum(r.today_liability);
    const prevLiability = r.prev_liability === null ? null : safeNum(r.prev_liability);

    const receivablePct =
      r.receivable_change_pct === null ? null : safeNum(r.receivable_change_pct);
    const liabilityPct = r.liability_change_pct === null ? null : safeNum(r.liability_change_pct);

    // -------------------------
    // Rule 1: WoW % move + materiality + absolute delta gate
    // -------------------------
    const receivableBase = baseAbs(todayReceivable, prevReceivable);
    const liabilityBase = baseAbs(todayLiability, prevLiability);

    const receivableDelta = Math.abs(todayReceivable - (prevReceivable ?? 0));
    const liabilityDelta = Math.abs(todayLiability - (prevLiability ?? 0));

    const receivable_material = receivableBase >= THRESHOLDS.MIN_BASE_RECEIVABLE;
    const liability_material = liabilityBase >= THRESHOLDS.MIN_BASE_LIABILITY;

    const receivable_flagged =
      receivablePct !== null &&
      Math.abs(receivablePct) >= THRESHOLDS.WOW_PCT_THRESHOLD &&
      receivable_material &&
      receivableDelta >= THRESHOLDS.MIN_ABS_DELTA_RECEIVABLE;

    const liability_flagged =
      liabilityPct !== null &&
      Math.abs(liabilityPct) >= THRESHOLDS.WOW_PCT_THRESHOLD &&
      liability_material &&
      liabilityDelta >= THRESHOLDS.MIN_ABS_DELTA_LIABILITY;

    if (receivable_flagged) {
      reasons.push(
        `Receivables WoW change ${fmtPct(receivablePct!)} (Δ ${fmtMoney(
          receivableDelta
        )}; base ${fmtMoney(receivableBase)}; prev ${fmtMoney(prevReceivable ?? 0)} → today ${fmtMoney(
          todayReceivable
        )})`
      );
    }

    if (liability_flagged) {
      reasons.push(
        `Potential liabilities WoW change ${fmtPct(liabilityPct!)} (Δ ${fmtMoney(
          liabilityDelta
        )}; base ${fmtMoney(liabilityBase)}; prev ${fmtMoney(prevLiability ?? 0)} → today ${fmtMoney(
          todayLiability
        )})`
      );
    }

    // -------------------------
    // Rule 2: Negative Net Earnings (receivables - chargebacks) + materiality
    // -------------------------
    const todayChargeback = safeNum(r.today_chargeback);
    const computed_net_earning = todayReceivable - todayChargeback;

    const net_material = todayChargeback >= THRESHOLDS.MIN_CHARGEBACK_FOR_NET_RULE;
    const net_earning_flagged =
      net_material && computed_net_earning <= THRESHOLDS.MIN_NEG_NET_EARNING;

    if (net_earning_flagged) {
      reasons.push(
        `Negative net earnings (receivables - chargebacks) ${fmtMoney(
          computed_net_earning
        )} (receivables ${fmtMoney(todayReceivable)} - chargebacks ${fmtMoney(todayChargeback)})`
      );
    }

    // -------------------------
    // Rule 3: Negative available balance (with threshold)
    // -------------------------
    const todayAvail = safeNum(r.today_available_balance);
    const available_balance_flagged = todayAvail <= THRESHOLDS.MIN_NEG_AVAILABLE_BALANCE;

    if (available_balance_flagged) {
      reasons.push(`Negative available balance: ${fmtMoney(todayAvail)}`);
    }

    if (receivable_flagged || liability_flagged) wowCount++;
    if (net_earning_flagged) negNetCount++;
    if (available_balance_flagged) negBalCount++;

    const flagged =
      receivable_flagged || liability_flagged || net_earning_flagged || available_balance_flagged;

    return {
      ...r,
      receivable_flagged,
      liability_flagged,
      net_earning_flagged,
      available_balance_flagged,
      flag_reasons: flagged ? reasons : [],
    };
  });

  // Sort: more triggers first, then largest WoW swing, then exposure proxy
  scored.sort((a, b) => {
    const aTriggers =
      Number(a.receivable_flagged) +
      Number(a.liability_flagged) +
      Number(a.net_earning_flagged) +
      Number(a.available_balance_flagged);
    const bTriggers =
      Number(b.receivable_flagged) +
      Number(b.liability_flagged) +
      Number(b.net_earning_flagged) +
      Number(b.available_balance_flagged);

    if (bTriggers !== aTriggers) return bTriggers - aTriggers;

    const aMaxWow = Math.max(
      Math.abs(a.receivable_change_pct ?? 0),
      Math.abs(a.liability_change_pct ?? 0)
    );
    const bMaxWow = Math.max(
      Math.abs(b.receivable_change_pct ?? 0),
      Math.abs(b.liability_change_pct ?? 0)
    );
    if (bMaxWow !== aMaxWow) return bMaxWow - aMaxWow;

    const aExposure =
      safeNum(a.today_outstanding_bal) +
      Math.abs(safeNum(a.today_liability)) +
      safeNum(a.today_receivable);
    const bExposure =
      safeNum(b.today_outstanding_bal) +
      Math.abs(safeNum(b.today_liability)) +
      safeNum(b.today_receivable);
    return bExposure - aExposure;
  });

  const flagged = scored.filter((x) => x.flag_reasons.length > 0);
  const unflagged = scored.filter((x) => x.flag_reasons.length === 0);

  console.log("[risk-engine] triggers", {
    total: rows.length,
    flagged: flagged.length,
    wow: wowCount,
    neg_net_earning: negNetCount,
    neg_available_balance: negBalCount,
  });

  return { total: rows.length, flagged, unflagged };
}