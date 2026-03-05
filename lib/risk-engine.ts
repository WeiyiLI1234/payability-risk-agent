// lib/risk-engine.ts (v3: 1-10 risk score)

export type DailyChangeRow = {
  supplier_key: string;
  supplier_name: string;

  today_receivable: number;
  prev_receivable: number | null;

  today_liability: number;
  prev_liability: number | null;

  today_net_earning: number;
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
  risk_score: number; // 1-10, 1 = lowest risk, 10 = highest risk
};

export type FlagSuppliersResult = {
  total: number;
  flagged: FlaggedSupplier[];
  unflagged: FlaggedSupplier[];
};

const THRESHOLDS = {
  WOW_PCT_THRESHOLD: 50,
  MIN_BASE_RECEIVABLE: 25_000,
  MIN_BASE_LIABILITY: 25_000,
  MIN_ABS_DELTA_RECEIVABLE: 10_000,
  MIN_ABS_DELTA_LIABILITY: 10_000,
  MIN_NEG_NET_EARNING: -5_000,
  MIN_CHARGEBACK_FOR_NET_RULE: 2_000,
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

/**
 * Calculate risk score 1-10 based on how many rules triggered and severity.
 * 1 = lowest risk, 10 = highest risk.
 *
 * Scoring:
 * - Each flag type adds base points
 * - Severity (magnitude of change, size of exposure) adds more points
 * - Capped at 10
 */
function calculateRiskScore(
  receivable_flagged: boolean,
  liability_flagged: boolean,
  net_earning_flagged: boolean,
  available_balance_flagged: boolean,
  receivablePct: number | null,
  liabilityPct: number | null,
  computedNetEarning: number,
  availableBalance: number,
  outstandingBal: number,
  receivable: number
): number {
  let score = 0;

  // --- Base points per flag triggered ---
  // WoW receivable spike: +2
  if (receivable_flagged) score += 2;
  // WoW liability spike: +2
  if (liability_flagged) score += 2;
  // Negative net earnings: +2
  if (net_earning_flagged) score += 2;
  // Negative available balance: +2
  if (available_balance_flagged) score += 2;

  // --- Severity modifiers ---

  // Extreme WoW swings (>100%) add extra point each
  if (receivablePct !== null && Math.abs(receivablePct) > 100) score += 1;
  if (liabilityPct !== null && Math.abs(liabilityPct) > 100) score += 1;

  // Deeply negative net earnings (< -50K) adds a point
  if (computedNetEarning < -50_000) score += 1;

  // Large outstanding balance (> 500K) with other flags adds exposure risk
  if (outstandingBal > 500_000 && score >= 2) score += 1;

  // Chargeback exceeds receivable (chargeback ratio > 100%)
  if (receivable > 0 && computedNetEarning < 0 && Math.abs(computedNetEarning) > receivable) {
    score += 1;
  }

  // Clamp to 1-10 (minimum 1 since they're already flagged)
  return Math.max(1, Math.min(10, score));
}

export function flagSuppliers(rows: DailyChangeRow[]): FlagSuppliersResult {
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
    const liabilityPct =
      r.liability_change_pct === null ? null : safeNum(r.liability_change_pct);

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

    const isFlagged =
      receivable_flagged || liability_flagged || net_earning_flagged || available_balance_flagged;

    // Calculate risk score for flagged suppliers
    const risk_score = isFlagged
      ? calculateRiskScore(
          receivable_flagged,
          liability_flagged,
          net_earning_flagged,
          available_balance_flagged,
          receivablePct,
          liabilityPct,
          computed_net_earning,
          todayAvail,
          safeNum(r.today_outstanding_bal),
          todayReceivable
        )
      : 0;

    return {
      ...r,
      receivable_flagged,
      liability_flagged,
      net_earning_flagged,
      available_balance_flagged,
      flag_reasons: isFlagged ? reasons : [],
      risk_score,
    };
  });

  // Sort: highest risk score first, then by exposure
  scored.sort((a, b) => {
    if (b.risk_score !== a.risk_score) return b.risk_score - a.risk_score;

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
    score_distribution: {
      "8-10 (critical)": flagged.filter((x) => x.risk_score >= 8).length,
      "5-7 (high)": flagged.filter((x) => x.risk_score >= 5 && x.risk_score <= 7).length,
      "1-4 (moderate)": flagged.filter((x) => x.risk_score >= 1 && x.risk_score <= 4).length,
    },
  });

  return { total: rows.length, flagged, unflagged };
}