// lib/risk-engine.ts

import {
  RISK_POLICY_VERSION,
  RISK_THRESHOLDS,
  RISK_WEIGHTS,
  mapEngineScore100ToRisk1to10,
} from "@/lib/risk-policy";

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

  today_marketplace_payment?: number | null;
  prev_marketplace_payment?: number | null;
  marketplace_payment_change_pct?: number | null;

  today_due_from_supplier?: number | null;
  prev_due_from_supplier?: number | null;

  negative_net_earning_streak?: number | null;

  trailing_median_receivable?: number | null;
  trailing_median_liability?: number | null;
  trailing_median_marketplace_payment?: number | null;
  trailing_median_chargeback?: number | null;

  days_since_last_marketplace_payment?: number | null;
  historical_median_payment_gap_days?: number | null;

  // Gap between the current record and the immediately preceding record (days).
  // A large gap signals a recently reactivated account after dormancy.
  days_since_prev_record?: number | null;
};

export type MetricResult = {
  metric_id:
    | "RECEIVABLE_ANOMALY"
    | "LIABILITY_ANOMALY"
    | "MARKETPLACE_PAYMENT_DELAY"
    | "CHARGEBACK_ANOMALY"
    | "NET_EARNING"
    | "AVAILABLE_BALANCE"
    | "DUE_FROM_SUPPLIER"
    | "OUTSTANDING_EXPOSURE";
  value: number | null;
  unit: string;
  explanation: string;
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  score_contribution: number;
  triggered: boolean;
};

export type FlaggedSupplier = DailyChangeRow & {
  receivable_flagged: boolean;
  liability_flagged: boolean;
  marketplace_payment_delay_flagged: boolean;
  net_earning_flagged: boolean;
  available_balance_flagged: boolean;
  due_from_supplier_flagged: boolean;
  chargeback_flagged: boolean;

  receivable_vs_history_ratio: number | null;
  liability_vs_history_ratio: number | null;
  chargeback_vs_history_ratio: number | null;
  chargeback_ratio: number | null;
  due_from_supplier_ratio: number | null;
  due_from_supplier_turned_positive: boolean;

  is_active_supplier: boolean;
  is_recently_reactivated: boolean;

  metrics: MetricResult[];
  flag_reasons: string[];

  engine_score_100: number;
  engine_suggested_risk_score: number;
  policy_version: string;
};

export type FlagSuppliersResult = {
  total: number;
  flagged: FlaggedSupplier[];
  unflagged: FlaggedSupplier[];
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

function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function flagSuppliers(rows: DailyChangeRow[]): FlagSuppliersResult {
  const scored: FlaggedSupplier[] = rows.map((r) => {
    const reasons: string[] = [];
    const metrics: MetricResult[] = [];
    let engineScore = 0;

    // ── Base values ──────────────────────────────────────────────────────────
    const todayReceivable = safeNum(r.today_receivable);
    const prevReceivable = r.prev_receivable === null ? null : safeNum(r.prev_receivable);

    const todayLiability = safeNum(r.today_liability);
    const prevLiability = r.prev_liability === null ? null : safeNum(r.prev_liability);

    const todayChargeback = safeNum(r.today_chargeback);
    const computedNetEarning =
      r.today_net_earning !== null && Number.isFinite(r.today_net_earning)
        ? safeNum(r.today_net_earning)
        : todayReceivable - todayChargeback;

    const todayAvail = safeNum(r.today_available_balance);
    const outstandingBal = safeNum(r.today_outstanding_bal);

    const receivablePct =
      r.receivable_change_pct === null ? null : safeNum(r.receivable_change_pct);
    const liabilityPct =
      r.liability_change_pct === null ? null : safeNum(r.liability_change_pct);

    const todayDueFromSupplier =
      r.today_due_from_supplier == null ? 0 : safeNum(r.today_due_from_supplier);
    const prevDueFromSupplier =
      r.prev_due_from_supplier == null ? 0 : safeNum(r.prev_due_from_supplier);

    const trailingMedianReceivable =
      r.trailing_median_receivable == null ? null : safeNum(r.trailing_median_receivable);
    const trailingMedianLiability =
      r.trailing_median_liability == null ? null : safeNum(r.trailing_median_liability);
    const trailingMedianChargeback =
      r.trailing_median_chargeback == null ? null : safeNum(r.trailing_median_chargeback);

    const negativeNetEarningStreak =
      r.negative_net_earning_streak == null ? 0 : safeNum(r.negative_net_earning_streak);

    const daysSinceLastMarketplacePayment =
      r.days_since_last_marketplace_payment == null
        ? null
        : safeNum(r.days_since_last_marketplace_payment);

    const daysSincePrevRecord =
      r.days_since_prev_record == null ? null : safeNum(r.days_since_prev_record);

    // ── Derived ratios ───────────────────────────────────────────────────────
    const receivableVsHistoryRatio = safeRatio(todayReceivable, trailingMedianReceivable ?? 0);
    const liabilityVsHistoryRatio = safeRatio(todayLiability, trailingMedianLiability ?? 0);
    const chargebackVsHistoryRatio = safeRatio(todayChargeback, trailingMedianChargeback ?? 0);
    const chargebackDeltaVsMedian =
      trailingMedianChargeback !== null ? todayChargeback - trailingMedianChargeback : null;

    const dueFromSupplierRatio = safeRatio(todayDueFromSupplier, outstandingBal);
    const dueFromSupplierTurnedPositive = todayDueFromSupplier > 0 && prevDueFromSupplier <= 0;
    const chargebackRatio = safeRatio(todayChargeback, todayReceivable);

    // ── Active-supplier gate ─────────────────────────────────────────────────
    // Applies to MARKETPLACE_PAYMENT_DELAY and CHARGEBACK_ANOMALY.
    const isActiveSupplier =
      todayReceivable > 0 ||
      (daysSinceLastMarketplacePayment !== null &&
        daysSinceLastMarketplacePayment <= RISK_THRESHOLDS.activeSupplier.maxDaysSincePayment) ||
      outstandingBal >= RISK_THRESHOLDS.activeSupplier.minOutstandingBal;

    // ── Reactivation gate ─────────────────────────────────────────────────────
    // If the gap between the current record and the immediately preceding record
    // exceeds the threshold, the supplier recently resumed activity after dormancy.
    // This suppresses MARKETPLACE_PAYMENT_DELAY, which would otherwise fire simply
    // because the account was inactive for a long time — not because of a true delay.
    const isRecentlyReactivated =
      daysSincePrevRecord !== null &&
      daysSincePrevRecord > RISK_THRESHOLDS.reactivationGapDays;

    // =========================================================================
    // 1) RECEIVABLE_ANOMALY
    // =========================================================================
    const receivableDeltaAbsolute = todayReceivable - (prevReceivable ?? 0);

    const receivableAbsGateMedium =
      todayReceivable >= RISK_THRESHOLDS.receivableAnomaly.minTodayReceivableMedium &&
      receivableDeltaAbsolute >= RISK_THRESHOLDS.receivableAnomaly.minDeltaReceivable;

    const receivableAbsGateHighCrit =
      todayReceivable >= RISK_THRESHOLDS.receivableAnomaly.minTodayReceivableHighCrit &&
      receivableDeltaAbsolute >= RISK_THRESHOLDS.receivableAnomaly.minDeltaReceivable;

    let receivable_flagged = false;
    let receivableSeverity: MetricResult["severity"] = "NONE";
    let receivableScore = 0;

    if (
      receivablePct !== null &&
      receivableVsHistoryRatio !== null &&
      receivableAbsGateHighCrit &&
      Math.abs(receivablePct) >= RISK_THRESHOLDS.receivableAnomaly.wowCritical &&
      receivableVsHistoryRatio >= RISK_THRESHOLDS.receivableAnomaly.histCritical
    ) {
      receivable_flagged = true;
      receivableSeverity = "CRITICAL";
      receivableScore = Math.round(RISK_WEIGHTS.receivableAnomaly * 0.9);
      reasons.push(
        `Receivable anomaly is severe: WoW change ${fmtPct(receivablePct)} and current level is ${receivableVsHistoryRatio.toFixed(2)}x trailing median.`
      );
    } else if (
      receivablePct !== null &&
      receivableVsHistoryRatio !== null &&
      receivableAbsGateHighCrit &&
      Math.abs(receivablePct) >= RISK_THRESHOLDS.receivableAnomaly.wowHigh &&
      receivableVsHistoryRatio >= RISK_THRESHOLDS.receivableAnomaly.histHigh
    ) {
      receivable_flagged = true;
      receivableSeverity = "HIGH";
      receivableScore = Math.round(RISK_WEIGHTS.receivableAnomaly * 0.7);
      reasons.push(
        `Receivable anomaly is material: WoW change ${fmtPct(receivablePct)} and current level is ${receivableVsHistoryRatio.toFixed(2)}x trailing median.`
      );
    } else if (
      receivablePct !== null &&
      receivableVsHistoryRatio !== null &&
      receivableAbsGateMedium &&
      Math.abs(receivablePct) >= RISK_THRESHOLDS.receivableAnomaly.wowLow &&
      receivableVsHistoryRatio >= RISK_THRESHOLDS.receivableAnomaly.histLow
    ) {
      receivable_flagged = true;
      receivableSeverity = "MEDIUM";
      receivableScore = Math.round(RISK_WEIGHTS.receivableAnomaly * 0.45);
      reasons.push(
        `Receivables moved ${fmtPct(receivablePct)} and are ${receivableVsHistoryRatio.toFixed(2)}x trailing median.`
      );
    }

    engineScore += receivableScore;
    metrics.push({
      metric_id: "RECEIVABLE_ANOMALY",
      value: receivablePct,
      unit: "%",
      explanation:
        receivablePct === null
          ? "Receivable anomaly cannot be assessed because prior record is unavailable."
          : receivableVsHistoryRatio === null
          ? `Receivables changed by ${fmtPct(receivablePct)}, but historical baseline is unavailable.`
          : `Receivables changed by ${fmtPct(receivablePct)} and current level is ${receivableVsHistoryRatio.toFixed(2)}x trailing median.`,
      severity: receivableSeverity,
      score_contribution: receivableScore,
      triggered: receivable_flagged,
    });

    // =========================================================================
    // 2) LIABILITY_ANOMALY
    // =========================================================================
    const liabilityDeltaAbsolute = Math.abs(todayLiability - (prevLiability ?? 0));

    const liabilityAbsGate =
      todayLiability >= RISK_THRESHOLDS.liabilityAnomaly.minAbsLiability &&
      liabilityDeltaAbsolute >= RISK_THRESHOLDS.liabilityAnomaly.minDeltaLiability;

    let liability_flagged = false;
    let liabilitySeverity: MetricResult["severity"] = "NONE";
    let liabilityScore = 0;

    if (
      liabilityPct !== null &&
      liabilityVsHistoryRatio !== null &&
      liabilityAbsGate &&
      Math.abs(liabilityPct) >= RISK_THRESHOLDS.liabilityAnomaly.wowCritical &&
      liabilityVsHistoryRatio >= RISK_THRESHOLDS.liabilityAnomaly.histCritical
    ) {
      liability_flagged = true;
      liabilitySeverity = "CRITICAL";
      liabilityScore = Math.round(RISK_WEIGHTS.liabilityAnomaly * 0.9);
      reasons.push(
        `Liability anomaly is severe: change ${fmtPct(liabilityPct)} and current level is ${liabilityVsHistoryRatio.toFixed(2)}x trailing median.`
      );
    } else if (
      liabilityPct !== null &&
      liabilityVsHistoryRatio !== null &&
      liabilityAbsGate &&
      Math.abs(liabilityPct) >= RISK_THRESHOLDS.liabilityAnomaly.wowHigh &&
      liabilityVsHistoryRatio >= RISK_THRESHOLDS.liabilityAnomaly.histHigh
    ) {
      liability_flagged = true;
      liabilitySeverity = "HIGH";
      liabilityScore = Math.round(RISK_WEIGHTS.liabilityAnomaly * 0.7);
      reasons.push(
        `Liability anomaly is material: change ${fmtPct(liabilityPct)} and current level is ${liabilityVsHistoryRatio.toFixed(2)}x trailing median.`
      );
    } else if (
      liabilityPct !== null &&
      liabilityVsHistoryRatio !== null &&
      liabilityAbsGate &&
      Math.abs(liabilityPct) >= RISK_THRESHOLDS.liabilityAnomaly.wowLow &&
      liabilityVsHistoryRatio >= RISK_THRESHOLDS.liabilityAnomaly.histLow
    ) {
      liability_flagged = true;
      liabilitySeverity = "MEDIUM";
      liabilityScore = Math.round(RISK_WEIGHTS.liabilityAnomaly * 0.45);
      reasons.push(
        `Liabilities moved ${fmtPct(liabilityPct)} and are ${liabilityVsHistoryRatio.toFixed(2)}x trailing median.`
      );
    }

    engineScore += liabilityScore;
    metrics.push({
      metric_id: "LIABILITY_ANOMALY",
      value: liabilityPct,
      unit: "%",
      explanation:
        liabilityPct === null
          ? "Liability anomaly cannot be assessed because prior record is unavailable."
          : liabilityVsHistoryRatio === null
          ? `Liabilities changed by ${fmtPct(liabilityPct)}, but historical baseline is unavailable.`
          : `Liabilities changed by ${fmtPct(liabilityPct)} and current level is ${liabilityVsHistoryRatio.toFixed(2)}x trailing median.`,
      severity: liabilitySeverity,
      score_contribution: liabilityScore,
      triggered: liability_flagged,
    });

    // =========================================================================
    // 3) MARKETPLACE_PAYMENT_DELAY
    //    Skipped if:
    //      - supplier is not active (isActiveSupplier = false)
    //      - supplier recently reactivated after dormancy (isRecentlyReactivated = true)
    // =========================================================================
    let marketplace_payment_delay_flagged = false;
    let paymentDelaySeverity: MetricResult["severity"] = "NONE";
    let paymentDelayScore = 0;
    let paymentDelayExplanation: string;

    if (!isActiveSupplier) {
      paymentDelayExplanation =
        "Marketplace payment delay check skipped — supplier does not meet active-supplier criteria.";
    } else if (isRecentlyReactivated) {
      paymentDelayExplanation =
        `Marketplace payment delay check suppressed — supplier appears to have recently reactivated after a dormant period (${daysSincePrevRecord} day gap between records). The long time since last payment reflects inactivity, not a true delay.`;
    } else {
      if (
        daysSinceLastMarketplacePayment !== null &&
        daysSinceLastMarketplacePayment > RISK_THRESHOLDS.marketplacePaymentDelayDays.critical
      ) {
        marketplace_payment_delay_flagged = true;
        paymentDelaySeverity = "CRITICAL";
        paymentDelayScore = RISK_WEIGHTS.marketplacePaymentDelay;
        reasons.push(
          `Marketplace payment appears severely delayed at ${daysSinceLastMarketplacePayment} days since the last positive payment.`
        );
      } else if (
        daysSinceLastMarketplacePayment !== null &&
        daysSinceLastMarketplacePayment > RISK_THRESHOLDS.marketplacePaymentDelayDays.high
      ) {
        marketplace_payment_delay_flagged = true;
        paymentDelaySeverity = "HIGH";
        paymentDelayScore = Math.round(RISK_WEIGHTS.marketplacePaymentDelay * 0.7);
        reasons.push(
          `Marketplace payment delay is elevated at ${daysSinceLastMarketplacePayment} days since the last positive payment.`
        );
      } else if (
        daysSinceLastMarketplacePayment !== null &&
        daysSinceLastMarketplacePayment > RISK_THRESHOLDS.marketplacePaymentDelayDays.low
      ) {
        marketplace_payment_delay_flagged = true;
        paymentDelaySeverity = "MEDIUM";
        paymentDelayScore = Math.round(RISK_WEIGHTS.marketplacePaymentDelay * 0.45);
        reasons.push(
          `Marketplace payment has not arrived for ${daysSinceLastMarketplacePayment} days, exceeding the expected two-week cadence.`
        );
      }

      paymentDelayExplanation =
        daysSinceLastMarketplacePayment === null
          ? "Marketplace payment delay cannot be assessed because no historical positive payment was found."
          : `It has been ${daysSinceLastMarketplacePayment} days since the last positive marketplace payment.`;
    }

    engineScore += paymentDelayScore;
    metrics.push({
      metric_id: "MARKETPLACE_PAYMENT_DELAY",
      value: daysSinceLastMarketplacePayment,
      unit: "days",
      explanation: paymentDelayExplanation,
      severity: paymentDelaySeverity,
      score_contribution: paymentDelayScore,
      triggered: marketplace_payment_delay_flagged,
    });

    // =========================================================================
    // 4) CHARGEBACK_ANOMALY
    //    Only evaluated for active suppliers.
    // =========================================================================
    const chargebackAbsGateMedium =
      todayChargeback >= RISK_THRESHOLDS.chargebackAnomaly.minChargebackAmountMedium ||
      (chargebackDeltaVsMedian !== null &&
        chargebackDeltaVsMedian >= RISK_THRESHOLDS.chargebackAnomaly.minChargebackDeltaVsMedian);

    const chargebackAbsGateHigh =
      todayChargeback >= RISK_THRESHOLDS.chargebackAnomaly.minChargebackAmountHigh ||
      (chargebackDeltaVsMedian !== null &&
        chargebackDeltaVsMedian >= RISK_THRESHOLDS.chargebackAnomaly.minChargebackDeltaVsMedian);

    let chargeback_flagged = false;
    let chargebackSeverity: MetricResult["severity"] = "NONE";
    let chargebackScore = 0;

    if (isActiveSupplier) {
      if (
        chargebackRatio !== null &&
        chargebackVsHistoryRatio !== null &&
        chargebackAbsGateHigh &&
        chargebackRatio >= RISK_THRESHOLDS.chargebackAnomaly.ratioCritical &&
        chargebackVsHistoryRatio >= RISK_THRESHOLDS.chargebackAnomaly.histCritical
      ) {
        chargeback_flagged = true;
        chargebackSeverity = "CRITICAL";
        chargebackScore = Math.round(RISK_WEIGHTS.chargebackAnomaly * 0.9);
        reasons.push(
          `Chargeback anomaly is severe: ratio is ${chargebackRatio.toFixed(2)} and chargebacks are ${chargebackVsHistoryRatio.toFixed(2)}x trailing median.`
        );
      } else if (
        chargebackRatio !== null &&
        chargebackVsHistoryRatio !== null &&
        chargebackAbsGateHigh &&
        chargebackRatio >= RISK_THRESHOLDS.chargebackAnomaly.ratioHigh &&
        chargebackVsHistoryRatio >= RISK_THRESHOLDS.chargebackAnomaly.histHigh
      ) {
        chargeback_flagged = true;
        chargebackSeverity = "HIGH";
        chargebackScore = Math.round(RISK_WEIGHTS.chargebackAnomaly * 0.7);
        reasons.push(
          `Chargeback anomaly is material: ratio is ${chargebackRatio.toFixed(2)} and chargebacks are ${chargebackVsHistoryRatio.toFixed(2)}x trailing median.`
        );
      } else if (
        chargebackRatio !== null &&
        chargebackVsHistoryRatio !== null &&
        chargebackAbsGateMedium &&
        chargebackRatio >= RISK_THRESHOLDS.chargebackAnomaly.ratioLow &&
        chargebackVsHistoryRatio >= RISK_THRESHOLDS.chargebackAnomaly.histLow
      ) {
        chargeback_flagged = true;
        chargebackSeverity = "MEDIUM";
        chargebackScore = Math.round(RISK_WEIGHTS.chargebackAnomaly * 0.45);
        reasons.push(
          `Chargebacks are elevated: ratio is ${chargebackRatio.toFixed(2)} and chargebacks are ${chargebackVsHistoryRatio.toFixed(2)}x trailing median.`
        );
      }
    }

    engineScore += chargebackScore;
    metrics.push({
      metric_id: "CHARGEBACK_ANOMALY",
      value: chargebackRatio,
      unit: "ratio",
      explanation: !isActiveSupplier
        ? "Chargeback anomaly check skipped — supplier does not meet active-supplier criteria."
        : chargebackRatio === null
        ? "Chargeback anomaly cannot be assessed because receivables are zero."
        : chargebackVsHistoryRatio === null
        ? `Chargeback ratio is ${chargebackRatio.toFixed(2)}, but historical baseline is unavailable.`
        : `Chargeback ratio is ${chargebackRatio.toFixed(2)} and chargebacks are ${chargebackVsHistoryRatio.toFixed(2)}x trailing median.`,
      severity: chargebackSeverity,
      score_contribution: chargebackScore,
      triggered: chargeback_flagged,
    });

    // =========================================================================
    // 5) NET_EARNING
    // =========================================================================
    let net_earning_flagged = false;
    let netSeverity: MetricResult["severity"] = "NONE";
    let netScore = 0;

    if (computedNetEarning <= RISK_THRESHOLDS.negativeNetEarning.high) {
      net_earning_flagged = true;
      netSeverity = "HIGH";
      netScore = RISK_WEIGHTS.negativeNetEarning;
      reasons.push(`Net earning is deeply negative at ${fmtMoney(computedNetEarning)}.`);
    } else if (computedNetEarning <= RISK_THRESHOLDS.negativeNetEarning.low) {
      net_earning_flagged = true;
      netSeverity = "MEDIUM";
      netScore = Math.round(RISK_WEIGHTS.negativeNetEarning * 0.6);
      reasons.push(`Net earning is negative at ${fmtMoney(computedNetEarning)}.`);
    }

    if (negativeNetEarningStreak >= 3) {
      net_earning_flagged = true;
      netSeverity = "CRITICAL";
      netScore = Math.max(netScore, RISK_WEIGHTS.negativeNetEarning + 8);
      reasons.push(
        `Net earning has been negative for ${negativeNetEarningStreak} consecutive records.`
      );
    } else if (negativeNetEarningStreak >= 2) {
      net_earning_flagged = true;
      netSeverity = "HIGH";
      netScore = Math.max(netScore, RISK_WEIGHTS.negativeNetEarning);
      reasons.push(
        `Net earning has been negative for ${negativeNetEarningStreak} consecutive records.`
      );
    }

    engineScore += netScore;
    metrics.push({
      metric_id: "NET_EARNING",
      value: computedNetEarning,
      unit: "$",
      explanation: `Net earning is ${fmtMoney(computedNetEarning)} (${fmtMoney(todayReceivable)} receivables minus ${fmtMoney(todayChargeback)} chargebacks).`,
      severity: netSeverity,
      score_contribution: netScore,
      triggered: net_earning_flagged,
    });

    // =========================================================================
    // 6) AVAILABLE_BALANCE — minimum trigger is MEDIUM at <= -$500
    // =========================================================================
    let available_balance_flagged = false;
    let availSeverity: MetricResult["severity"] = "NONE";
    let availScore = 0;

    if (todayAvail <= RISK_THRESHOLDS.negativeAvailableBalance.critical) {
      available_balance_flagged = true;
      availSeverity = "CRITICAL";
      availScore = RISK_WEIGHTS.negativeAvailableBalance + 5;
      reasons.push(`Available balance is extremely negative at ${fmtMoney(todayAvail)}.`);
    } else if (todayAvail <= RISK_THRESHOLDS.negativeAvailableBalance.high) {
      available_balance_flagged = true;
      availSeverity = "HIGH";
      availScore = RISK_WEIGHTS.negativeAvailableBalance;
      reasons.push(`Available balance is materially negative at ${fmtMoney(todayAvail)}.`);
    } else if (todayAvail <= RISK_THRESHOLDS.negativeAvailableBalance.medium) {
      available_balance_flagged = true;
      availSeverity = "MEDIUM";
      availScore = Math.round(RISK_WEIGHTS.negativeAvailableBalance * 0.65);
      reasons.push(`Available balance is moderately negative at ${fmtMoney(todayAvail)}.`);
    }

    engineScore += availScore;
    metrics.push({
      metric_id: "AVAILABLE_BALANCE",
      value: todayAvail,
      unit: "$",
      explanation: `Available balance stands at ${fmtMoney(todayAvail)}.`,
      severity: availSeverity,
      score_contribution: availScore,
      triggered: available_balance_flagged,
    });

    // =========================================================================
    // 7) DUE_FROM_SUPPLIER — minimum trigger is MEDIUM at >= 10% of outstanding
    // =========================================================================
    let due_from_supplier_flagged = false;
    let dfsSeverity: MetricResult["severity"] = "NONE";
    let dfsScore = 0;

    if (dueFromSupplierTurnedPositive) {
      due_from_supplier_flagged = true;
      dfsSeverity = "CRITICAL";
      dfsScore = RISK_WEIGHTS.dueFromSupplierPositive + 6;
      reasons.push(
        `Due from supplier turned positive at ${fmtMoney(todayDueFromSupplier)}, suggesting part of the exposure is no longer covered by marketplace remittance.`
      );
    } else if (
      todayDueFromSupplier > 0 &&
      dueFromSupplierRatio !== null &&
      dueFromSupplierRatio >= RISK_THRESHOLDS.dueFromSupplierPct.high
    ) {
      due_from_supplier_flagged = true;
      dfsSeverity = "HIGH";
      dfsScore = RISK_WEIGHTS.dueFromSupplierPositive;
      reasons.push(
        `Due from supplier is ${fmtMoney(todayDueFromSupplier)}, or ${(dueFromSupplierRatio * 100).toFixed(1)}% of outstanding exposure.`
      );
    } else if (
      todayDueFromSupplier > 0 &&
      dueFromSupplierRatio !== null &&
      dueFromSupplierRatio >= RISK_THRESHOLDS.dueFromSupplierPct.medium
    ) {
      due_from_supplier_flagged = true;
      dfsSeverity = "MEDIUM";
      dfsScore = Math.round(RISK_WEIGHTS.dueFromSupplierPositive * 0.65);
      reasons.push(
        `Due from supplier is positive and accounts for ${(dueFromSupplierRatio * 100).toFixed(1)}% of outstanding exposure.`
      );
    }

    engineScore += dfsScore;
    metrics.push({
      metric_id: "DUE_FROM_SUPPLIER",
      value: todayDueFromSupplier,
      unit: "$",
      explanation:
        todayDueFromSupplier > 0
          ? `Due from supplier is ${fmtMoney(todayDueFromSupplier)}${
              dueFromSupplierRatio !== null
                ? `, representing ${(dueFromSupplierRatio * 100).toFixed(1)}% of outstanding exposure.`
                : "."
            }`
          : "Due from supplier is zero or not applicable.",
      severity: dfsSeverity,
      score_contribution: dfsScore,
      triggered: due_from_supplier_flagged,
    });

    // =========================================================================
    // 8) OUTSTANDING_EXPOSURE — context only, no score contribution
    // =========================================================================
    metrics.push({
      metric_id: "OUTSTANDING_EXPOSURE",
      value: outstandingBal,
      unit: "$",
      explanation: `Outstanding exposure is ${fmtMoney(outstandingBal)} and is provided as contextual information only.`,
      severity: "NONE",
      score_contribution: 0,
      triggered: false,
    });

    // ── Hard escalation floor ─────────────────────────────────────────────────
    const hardTriggerCount =
      Number(dueFromSupplierTurnedPositive) +
      Number(negativeNetEarningStreak >= 3) +
      Number(todayAvail <= RISK_THRESHOLDS.negativeAvailableBalance.high) +
      Number(chargebackSeverity === "CRITICAL") +
      Number(
        !isRecentlyReactivated &&
          daysSinceLastMarketplacePayment !== null &&
          daysSinceLastMarketplacePayment > RISK_THRESHOLDS.marketplacePaymentDelayDays.critical
      );

    if (hardTriggerCount >= 2) {
      engineScore = Math.max(engineScore, 85);
    } else if (hardTriggerCount === 1) {
      engineScore = Math.max(engineScore, 65);
    }

    const engine_score_100 = clamp100(engineScore);
    const engine_suggested_risk_score = mapEngineScore100ToRisk1to10(engine_score_100);

    // ── Scheme B: weak signals accumulate but cannot flag on their own ────────
    const anyTriggered = metrics.some((m) => m.triggered);
    const isFlagged =
      anyTriggered &&
      engine_suggested_risk_score >= RISK_THRESHOLDS.minFlaggedRiskScore;

    return {
      ...r,
      receivable_flagged,
      liability_flagged,
      marketplace_payment_delay_flagged,
      net_earning_flagged,
      available_balance_flagged,
      due_from_supplier_flagged,
      chargeback_flagged,

      receivable_vs_history_ratio: receivableVsHistoryRatio,
      liability_vs_history_ratio: liabilityVsHistoryRatio,
      chargeback_vs_history_ratio: chargebackVsHistoryRatio,
      chargeback_ratio: chargebackRatio,
      due_from_supplier_ratio: dueFromSupplierRatio,
      due_from_supplier_turned_positive: dueFromSupplierTurnedPositive,

      is_active_supplier: isActiveSupplier,
      is_recently_reactivated: isRecentlyReactivated,

      metrics,
      flag_reasons: isFlagged ? reasons : [],

      engine_score_100,
      engine_suggested_risk_score,
      policy_version: RISK_POLICY_VERSION,
    };
  });

  // ── Sort: risk score → engine score → outstanding balance ────────────────
  scored.sort((a, b) => {
    if (b.engine_suggested_risk_score !== a.engine_suggested_risk_score) {
      return b.engine_suggested_risk_score - a.engine_suggested_risk_score;
    }
    if (b.engine_score_100 !== a.engine_score_100) {
      return b.engine_score_100 - a.engine_score_100;
    }
    return safeNum(b.today_outstanding_bal) - safeNum(a.today_outstanding_bal);
  });

  const flagged = scored.filter((x) => x.flag_reasons.length > 0);
  const unflagged = scored.filter((x) => x.flag_reasons.length === 0);

  console.log("[risk-engine] triggers", {
    total: rows.length,
    flagged: flagged.length,
    score_distribution: {
      "8-10 (critical)": flagged.filter((x) => x.engine_suggested_risk_score >= 8).length,
      "5-7 (high)": flagged.filter(
        (x) =>
          x.engine_suggested_risk_score >= 5 && x.engine_suggested_risk_score <= 7
      ).length,
    },
    policy_version: RISK_POLICY_VERSION,
  });

  return { total: rows.length, flagged, unflagged };
}

export async function generateRiskReport(flagged: FlaggedSupplier[]) {
  const { generateRiskReportJSON } = await import("@/lib/ai-report");
  const json = await generateRiskReportJSON(flagged);
  return JSON.stringify(json, null, 2);
}