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
  marketplace_payment_gap_ratio?: number | null;
};

export type MetricResult = {
  metric_id:
    | "RECEIVABLE_WOW_CHANGE"
    | "RECEIVABLE_VS_HISTORY"
    | "LIABILITY_WOW_CHANGE"
    | "LIABILITY_VS_HISTORY"
    | "MARKETPLACE_PAYMENT_CHANGE"
    | "MARKETPLACE_PAYMENT_GAP"
    | "CHARGEBACK_RATIO"
    | "CHARGEBACK_VS_HISTORY"
    | "NET_EARNING"
    | "AVAILABLE_BALANCE"
    | "OUTSTANDING_EXPOSURE"
    | "DUE_FROM_SUPPLIER";
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
  marketplace_payment_flagged: boolean;
  marketplace_payment_gap_flagged: boolean;
  net_earning_flagged: boolean;
  available_balance_flagged: boolean;
  due_from_supplier_flagged: boolean;
  chargeback_flagged: boolean;

  receivable_vs_history_ratio: number | null;
  liability_vs_history_ratio: number | null;
  marketplace_payment_vs_history_ratio: number | null;
  chargeback_vs_history_ratio: number | null;
  chargeback_ratio: number | null;
  due_from_supplier_ratio: number | null;
  due_from_supplier_turned_positive: boolean;

  metrics: MetricResult[];
  flag_reasons: string[];

  engine_score_100: number;
  engine_suggested_risk_score: number; // 1-10
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

function baseAbs(today: number, prev: number | null) {
  return Math.max(Math.abs(safeNum(today)), Math.abs(safeNum(prev ?? 0)));
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
    const marketplacePaymentChangePct =
      r.marketplace_payment_change_pct === null || r.marketplace_payment_change_pct === undefined
        ? null
        : safeNum(r.marketplace_payment_change_pct);

    const todayMarketplacePayment =
      r.today_marketplace_payment === null || r.today_marketplace_payment === undefined
        ? null
        : safeNum(r.today_marketplace_payment);

    const prevMarketplacePayment =
      r.prev_marketplace_payment === null || r.prev_marketplace_payment === undefined
        ? null
        : safeNum(r.prev_marketplace_payment);

    const todayDueFromSupplier =
      r.today_due_from_supplier === null || r.today_due_from_supplier === undefined
        ? 0
        : safeNum(r.today_due_from_supplier);

    const prevDueFromSupplier =
      r.prev_due_from_supplier === null || r.prev_due_from_supplier === undefined
        ? 0
        : safeNum(r.prev_due_from_supplier);

    const trailingMedianReceivable =
      r.trailing_median_receivable === null || r.trailing_median_receivable === undefined
        ? null
        : safeNum(r.trailing_median_receivable);

    const trailingMedianLiability =
      r.trailing_median_liability === null || r.trailing_median_liability === undefined
        ? null
        : safeNum(r.trailing_median_liability);

    const trailingMedianMarketplacePayment =
      r.trailing_median_marketplace_payment === null ||
      r.trailing_median_marketplace_payment === undefined
        ? null
        : safeNum(r.trailing_median_marketplace_payment);

    const trailingMedianChargeback =
      r.trailing_median_chargeback === null || r.trailing_median_chargeback === undefined
        ? null
        : safeNum(r.trailing_median_chargeback);

    const negativeNetEarningStreak =
      r.negative_net_earning_streak === null || r.negative_net_earning_streak === undefined
        ? 0
        : safeNum(r.negative_net_earning_streak);

    const daysSinceLastMarketplacePayment =
      r.days_since_last_marketplace_payment === null ||
      r.days_since_last_marketplace_payment === undefined
        ? null
        : safeNum(r.days_since_last_marketplace_payment);

    const historicalMedianPaymentGapDays =
      r.historical_median_payment_gap_days === null ||
      r.historical_median_payment_gap_days === undefined
        ? null
        : safeNum(r.historical_median_payment_gap_days);

    const marketplacePaymentGapRatio =
      r.marketplace_payment_gap_ratio === null || r.marketplace_payment_gap_ratio === undefined
        ? null
        : safeNum(r.marketplace_payment_gap_ratio);

    const receivableVsHistoryRatio = safeRatio(todayReceivable, trailingMedianReceivable ?? 0);
    const liabilityVsHistoryRatio = safeRatio(todayLiability, trailingMedianLiability ?? 0);
    const marketplacePaymentVsHistoryRatio = safeRatio(
      todayMarketplacePayment ?? 0,
      trailingMedianMarketplacePayment ?? 0
    );
    const chargebackVsHistoryRatio = safeRatio(todayChargeback, trailingMedianChargeback ?? 0);

    const dueFromSupplierRatio = safeRatio(todayDueFromSupplier, outstandingBal);
    const dueFromSupplierTurnedPositive = todayDueFromSupplier > 0 && prevDueFromSupplier <= 0;
    const chargebackRatio = safeRatio(todayChargeback, todayReceivable);

    // -------------------------
    // 1) Receivable WoW change
    // -------------------------
    const receivableBase = baseAbs(todayReceivable, prevReceivable);
    const receivableDelta = Math.abs(todayReceivable - (prevReceivable ?? 0));
    const receivableMaterial =
      receivableBase >= RISK_THRESHOLDS.materiality.minBaseReceivable &&
      receivableDelta >= RISK_THRESHOLDS.materiality.minAbsDeltaReceivable;

    let receivable_flagged = false;
    let receivableSeverity: MetricResult["severity"] = "NONE";
    let receivableScore = 0;

    if (
      receivablePct !== null &&
      receivableMaterial &&
      Math.abs(receivablePct) >= RISK_THRESHOLDS.receivableWowPct.high
    ) {
      receivable_flagged = true;
      receivableSeverity = "HIGH";
      receivableScore = Math.round(RISK_WEIGHTS.receivableSpike * 0.7);
      reasons.push(
        `Receivables moved sharply by ${fmtPct(receivablePct)} from ${fmtMoney(prevReceivable ?? 0)} to ${fmtMoney(todayReceivable)}.`
      );
    } else if (
      receivablePct !== null &&
      receivableMaterial &&
      Math.abs(receivablePct) >= RISK_THRESHOLDS.receivableWowPct.low
    ) {
      receivable_flagged = true;
      receivableSeverity = "MEDIUM";
      receivableScore = Math.round(RISK_WEIGHTS.receivableSpike * 0.4);
      reasons.push(`Receivables showed a material change of ${fmtPct(receivablePct)} versus the prior record.`);
    }

    engineScore += receivableScore;
    metrics.push({
      metric_id: "RECEIVABLE_WOW_CHANGE",
      value: receivablePct,
      unit: "%",
      explanation:
        receivablePct === null
          ? "No prior receivable record is available for comparison."
          : `Receivables moved from ${fmtMoney(prevReceivable ?? 0)} to ${fmtMoney(todayReceivable)}, a ${fmtPct(receivablePct)} change.`,
      severity: receivableSeverity,
      score_contribution: receivableScore,
      triggered: receivable_flagged,
    });

    // -------------------------
    // 2) Receivable vs history
    // -------------------------
    let receivableVsHistorySeverity: MetricResult["severity"] = "NONE";
    let receivableVsHistoryScore = 0;

    if (receivableVsHistoryRatio !== null && receivableVsHistoryRatio > 8) {
      receivableVsHistorySeverity = "CRITICAL";
      receivableVsHistoryScore = Math.round(RISK_WEIGHTS.receivableSpike * 0.9);
      receivable_flagged = true;
      reasons.push(
        `Receivables are ${receivableVsHistoryRatio.toFixed(2)}x the trailing historical median, indicating an anomalous spike.`
      );
    } else if (receivableVsHistoryRatio !== null && receivableVsHistoryRatio > 4) {
      receivableVsHistorySeverity = "HIGH";
      receivableVsHistoryScore = Math.round(RISK_WEIGHTS.receivableSpike * 0.7);
      receivable_flagged = true;
      reasons.push(
        `Receivables are elevated at ${receivableVsHistoryRatio.toFixed(2)}x the trailing historical median.`
      );
    } else if (receivableVsHistoryRatio !== null && receivableVsHistoryRatio > 2) {
      receivableVsHistorySeverity = "MEDIUM";
      receivableVsHistoryScore = Math.round(RISK_WEIGHTS.receivableSpike * 0.4);
      receivable_flagged = true;
      reasons.push(
        `Receivables are above normal history at ${receivableVsHistoryRatio.toFixed(2)}x the trailing median.`
      );
    }

    engineScore += receivableVsHistoryScore;
    metrics.push({
      metric_id: "RECEIVABLE_VS_HISTORY",
      value: receivableVsHistoryRatio,
      unit: "ratio",
      explanation:
        receivableVsHistoryRatio === null
          ? "Historical receivable baseline is unavailable."
          : `Current receivable is ${receivableVsHistoryRatio.toFixed(2)}x the trailing median.`,
      severity: receivableVsHistorySeverity,
      score_contribution: receivableVsHistoryScore,
      triggered: receivableVsHistoryScore > 0,
    });

    // -------------------------
    // 3) Liability WoW change
    // -------------------------
    const liabilityBase = baseAbs(todayLiability, prevLiability);
    const liabilityDelta = Math.abs(todayLiability - (prevLiability ?? 0));
    const liabilityMaterial =
      liabilityBase >= RISK_THRESHOLDS.materiality.minBaseLiability &&
      liabilityDelta >= RISK_THRESHOLDS.materiality.minAbsDeltaLiability;

    let liability_flagged = false;
    let liabilitySeverity: MetricResult["severity"] = "NONE";
    let liabilityScore = 0;

    if (
      liabilityPct !== null &&
      liabilityMaterial &&
      Math.abs(liabilityPct) >= RISK_THRESHOLDS.liabilityWowPct.high
    ) {
      liability_flagged = true;
      liabilitySeverity = "HIGH";
      liabilityScore = Math.round(RISK_WEIGHTS.liabilitySpike * 0.7);
      reasons.push(
        `Liabilities moved sharply by ${fmtPct(liabilityPct)} from ${fmtMoney(prevLiability ?? 0)} to ${fmtMoney(todayLiability)}.`
      );
    } else if (
      liabilityPct !== null &&
      liabilityMaterial &&
      Math.abs(liabilityPct) >= RISK_THRESHOLDS.liabilityWowPct.low
    ) {
      liability_flagged = true;
      liabilitySeverity = "MEDIUM";
      liabilityScore = Math.round(RISK_WEIGHTS.liabilitySpike * 0.4);
      reasons.push(`Liabilities showed a material change of ${fmtPct(liabilityPct)} versus the prior record.`);
    }

    engineScore += liabilityScore;
    metrics.push({
      metric_id: "LIABILITY_WOW_CHANGE",
      value: liabilityPct,
      unit: "%",
      explanation:
        liabilityPct === null
          ? "No prior liability record is available for comparison."
          : `Liabilities moved from ${fmtMoney(prevLiability ?? 0)} to ${fmtMoney(todayLiability)}, a ${fmtPct(liabilityPct)} change.`,
      severity: liabilitySeverity,
      score_contribution: liabilityScore,
      triggered: liability_flagged,
    });

    // -------------------------
    // 4) Liability vs history
    // -------------------------
    let liabilityVsHistorySeverity: MetricResult["severity"] = "NONE";
    let liabilityVsHistoryScore = 0;

    if (liabilityVsHistoryRatio !== null && liabilityVsHistoryRatio > 4.2) {
      liabilityVsHistorySeverity = "CRITICAL";
      liabilityVsHistoryScore = Math.round(RISK_WEIGHTS.liabilitySpike * 0.9);
      liability_flagged = true;
      reasons.push(
        `Liabilities are ${liabilityVsHistoryRatio.toFixed(2)}x the trailing historical median, indicating a sharp increase in risk burden.`
      );
    } else if (liabilityVsHistoryRatio !== null && liabilityVsHistoryRatio > 2.8) {
      liabilityVsHistorySeverity = "HIGH";
      liabilityVsHistoryScore = Math.round(RISK_WEIGHTS.liabilitySpike * 0.7);
      liability_flagged = true;
      reasons.push(
        `Liabilities are elevated at ${liabilityVsHistoryRatio.toFixed(2)}x the trailing historical median.`
      );
    } else if (liabilityVsHistoryRatio !== null && liabilityVsHistoryRatio > 1.5) {
      liabilityVsHistorySeverity = "MEDIUM";
      liabilityVsHistoryScore = Math.round(RISK_WEIGHTS.liabilitySpike * 0.4);
      liability_flagged = true;
      reasons.push(
        `Liabilities are above normal history at ${liabilityVsHistoryRatio.toFixed(2)}x the trailing median.`
      );
    }

    engineScore += liabilityVsHistoryScore;
    metrics.push({
      metric_id: "LIABILITY_VS_HISTORY",
      value: liabilityVsHistoryRatio,
      unit: "ratio",
      explanation:
        liabilityVsHistoryRatio === null
          ? "Historical liability baseline is unavailable."
          : `Current liability is ${liabilityVsHistoryRatio.toFixed(2)}x the trailing median.`,
      severity: liabilityVsHistorySeverity,
      score_contribution: liabilityVsHistoryScore,
      triggered: liabilityVsHistoryScore > 0,
    });

    // -------------------------
    // 5) Marketplace payment amount deterioration
    // -------------------------
    let marketplace_payment_flagged = false;
    let marketplacePaymentSeverity: MetricResult["severity"] = "NONE";
    let marketplacePaymentScore = 0;

    if (
      marketplacePaymentChangePct !== null &&
      marketplacePaymentChangePct <= RISK_THRESHOLDS.marketplacePaymentDropPct.high
    ) {
      marketplace_payment_flagged = true;
      marketplacePaymentSeverity = "HIGH";
      marketplacePaymentScore = Math.round(RISK_WEIGHTS.marketplacePaymentDrop * 0.7);
      reasons.push(
        `Marketplace payment dropped materially by ${fmtPct(marketplacePaymentChangePct)} from ${fmtMoney(prevMarketplacePayment ?? 0)} to ${fmtMoney(todayMarketplacePayment ?? 0)}.`
      );
    } else if (
      marketplacePaymentChangePct !== null &&
      marketplacePaymentChangePct <= RISK_THRESHOLDS.marketplacePaymentDropPct.low
    ) {
      marketplace_payment_flagged = true;
      marketplacePaymentSeverity = "MEDIUM";
      marketplacePaymentScore = Math.round(RISK_WEIGHTS.marketplacePaymentDrop * 0.45);
      reasons.push(`Marketplace payment decreased by ${fmtPct(marketplacePaymentChangePct)} versus the prior record.`);
    }

    if (
      marketplacePaymentVsHistoryRatio !== null &&
      trailingMedianMarketplacePayment !== null &&
      trailingMedianMarketplacePayment > 0
    ) {
      if (todayMarketplacePayment === 0) {
        marketplace_payment_flagged = true;
        marketplacePaymentSeverity = "HIGH";
        marketplacePaymentScore = Math.max(
          marketplacePaymentScore,
          Math.round(RISK_WEIGHTS.marketplacePaymentDrop * 0.8)
        );
        reasons.push(`Marketplace payment is zero despite a positive historical payment baseline.`);
      } else if (marketplacePaymentVsHistoryRatio < 0.2) {
        marketplace_payment_flagged = true;
        marketplacePaymentSeverity = "HIGH";
        marketplacePaymentScore = Math.max(
          marketplacePaymentScore,
          Math.round(RISK_WEIGHTS.marketplacePaymentDrop * 0.7)
        );
        reasons.push(
          `Marketplace payment is only ${(marketplacePaymentVsHistoryRatio * 100).toFixed(1)}% of its trailing historical median.`
        );
      } else if (marketplacePaymentVsHistoryRatio < 0.5) {
        marketplace_payment_flagged = true;
        marketplacePaymentSeverity = "MEDIUM";
        marketplacePaymentScore = Math.max(
          marketplacePaymentScore,
          Math.round(RISK_WEIGHTS.marketplacePaymentDrop * 0.4)
        );
        reasons.push(
          `Marketplace payment is materially below its trailing history at ${(marketplacePaymentVsHistoryRatio * 100).toFixed(1)}% of median.`
        );
      }
    }

    engineScore += marketplacePaymentScore;
    metrics.push({
      metric_id: "MARKETPLACE_PAYMENT_CHANGE",
      value: marketplacePaymentChangePct,
      unit: "%",
      explanation:
        marketplacePaymentChangePct === null
          ? "Marketplace payment amount trend is unavailable because prior payment data is missing or zero."
          : `Marketplace payment changed from ${fmtMoney(prevMarketplacePayment ?? 0)} to ${fmtMoney(todayMarketplacePayment ?? 0)}, a ${fmtPct(marketplacePaymentChangePct)} move.`,
      severity: marketplacePaymentSeverity,
      score_contribution: marketplacePaymentScore,
      triggered: marketplace_payment_flagged,
    });

    // -------------------------
    // 6) Marketplace payment frequency deterioration
    // -------------------------
    let marketplace_payment_gap_flagged = false;
    let marketplacePaymentGapSeverity: MetricResult["severity"] = "NONE";
    let marketplacePaymentGapScore = 0;

    if (marketplacePaymentGapRatio !== null && marketplacePaymentGapRatio > 5) {
      marketplace_payment_gap_flagged = true;
      marketplacePaymentGapSeverity = "CRITICAL";
      marketplacePaymentGapScore = RISK_WEIGHTS.marketplacePaymentDrop;
      reasons.push(
        `Marketplace payment cadence appears severely delayed: ${daysSinceLastMarketplacePayment} days since last payment versus a historical median gap of ${historicalMedianPaymentGapDays} days (${marketplacePaymentGapRatio.toFixed(2)}x).`
      );
    } else if (marketplacePaymentGapRatio !== null && marketplacePaymentGapRatio > 3) {
      marketplace_payment_gap_flagged = true;
      marketplacePaymentGapSeverity = "HIGH";
      marketplacePaymentGapScore = Math.round(RISK_WEIGHTS.marketplacePaymentDrop * 0.7);
      reasons.push(
        `Marketplace payment cadence is materially slower than history at ${marketplacePaymentGapRatio.toFixed(2)}x normal gap.`
      );
    } else if (marketplacePaymentGapRatio !== null && marketplacePaymentGapRatio > 1.5) {
      marketplace_payment_gap_flagged = true;
      marketplacePaymentGapSeverity = "MEDIUM";
      marketplacePaymentGapScore = Math.round(RISK_WEIGHTS.marketplacePaymentDrop * 0.4);
      reasons.push(
        `Marketplace payments appear slower than normal with a gap ratio of ${marketplacePaymentGapRatio.toFixed(2)}x.`
      );
    }

    engineScore += marketplacePaymentGapScore;
    metrics.push({
      metric_id: "MARKETPLACE_PAYMENT_GAP",
      value: marketplacePaymentGapRatio,
      unit: "ratio",
      explanation:
        marketplacePaymentGapRatio === null
          ? "Marketplace payment cadence baseline is unavailable."
          : `Days since last marketplace payment is ${daysSinceLastMarketplacePayment}, versus a historical median payment gap of ${historicalMedianPaymentGapDays} days (${marketplacePaymentGapRatio.toFixed(2)}x).`,
      severity: marketplacePaymentGapSeverity,
      score_contribution: marketplacePaymentGapScore,
      triggered: marketplace_payment_gap_flagged,
    });

    // -------------------------
    // 7) Chargeback ratio
    // -------------------------
    let chargeback_flagged = false;
    let chargebackSeverity: MetricResult["severity"] = "NONE";
    let chargebackScore = 0;

    if (chargebackRatio !== null && chargebackRatio > RISK_THRESHOLDS.chargebackRatio.critical) {
      chargeback_flagged = true;
      chargebackSeverity = "CRITICAL";
      chargebackScore = Math.round(RISK_WEIGHTS.chargebackRatio * 0.9);
      reasons.push(
        `Chargeback ratio is extremely high at ${chargebackRatio.toFixed(2)}x receivables (${fmtMoney(todayChargeback)} / ${fmtMoney(todayReceivable)}).`
      );
    } else if (chargebackRatio !== null && chargebackRatio > RISK_THRESHOLDS.chargebackRatio.high) {
      chargeback_flagged = true;
      chargebackSeverity = "HIGH";
      chargebackScore = Math.round(RISK_WEIGHTS.chargebackRatio * 0.7);
      reasons.push(`Chargeback ratio is elevated at ${chargebackRatio.toFixed(2)}x receivables.`);
    } else if (chargebackRatio !== null && chargebackRatio > RISK_THRESHOLDS.chargebackRatio.low) {
      chargeback_flagged = true;
      chargebackSeverity = "MEDIUM";
      chargebackScore = Math.round(RISK_WEIGHTS.chargebackRatio * 0.4);
      reasons.push(`Chargebacks are consuming a large share of receivables at ${chargebackRatio.toFixed(2)}x.`);
    }

    engineScore += chargebackScore;
    metrics.push({
      metric_id: "CHARGEBACK_RATIO",
      value: chargebackRatio,
      unit: "ratio",
      explanation:
        chargebackRatio === null
          ? "Chargeback ratio cannot be computed because receivables are zero."
          : `Chargeback ratio is ${chargebackRatio.toFixed(2)} based on chargebacks ${fmtMoney(todayChargeback)} and receivables ${fmtMoney(todayReceivable)}.`,
      severity: chargebackSeverity,
      score_contribution: chargebackScore,
      triggered: chargeback_flagged,
    });

    // -------------------------
    // 8) Chargeback vs history
    // -------------------------
    let chargebackVsHistorySeverity: MetricResult["severity"] = "NONE";
    let chargebackVsHistoryScore = 0;

    if (chargebackVsHistoryRatio !== null && chargebackVsHistoryRatio > 10) {
      chargeback_flagged = true;
      chargebackVsHistorySeverity = "CRITICAL";
      chargebackVsHistoryScore = Math.round(RISK_WEIGHTS.chargebackRatio * 0.7);
      reasons.push(
        `Chargebacks are ${chargebackVsHistoryRatio.toFixed(2)}x the trailing historical median.`
      );
    } else if (chargebackVsHistoryRatio !== null && chargebackVsHistoryRatio > 4.5) {
      chargeback_flagged = true;
      chargebackVsHistorySeverity = "HIGH";
      chargebackVsHistoryScore = Math.round(RISK_WEIGHTS.chargebackRatio * 0.5);
      reasons.push(
        `Chargebacks are elevated at ${chargebackVsHistoryRatio.toFixed(2)}x the trailing historical median.`
      );
    } else if (chargebackVsHistoryRatio !== null && chargebackVsHistoryRatio > 2) {
      chargeback_flagged = true;
      chargebackVsHistorySeverity = "MEDIUM";
      chargebackVsHistoryScore = Math.round(RISK_WEIGHTS.chargebackRatio * 0.3);
      reasons.push(
        `Chargebacks are above normal history at ${chargebackVsHistoryRatio.toFixed(2)}x the trailing median.`
      );
    }

    engineScore += chargebackVsHistoryScore;
    metrics.push({
      metric_id: "CHARGEBACK_VS_HISTORY",
      value: chargebackVsHistoryRatio,
      unit: "ratio",
      explanation:
        chargebackVsHistoryRatio === null
          ? "Historical chargeback baseline is unavailable."
          : `Current chargeback is ${chargebackVsHistoryRatio.toFixed(2)}x the trailing median.`,
      severity: chargebackVsHistorySeverity,
      score_contribution: chargebackVsHistoryScore,
      triggered: chargebackVsHistoryScore > 0,
    });

    // -------------------------
    // 9) Negative net earning
    // -------------------------
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
      reasons.push(`Net earning has been negative for ${negativeNetEarningStreak} consecutive records.`);
    } else if (negativeNetEarningStreak >= 2) {
      net_earning_flagged = true;
      netSeverity = "HIGH";
      netScore = Math.max(netScore, RISK_WEIGHTS.negativeNetEarning);
      reasons.push(`Net earning has been negative for ${negativeNetEarningStreak} consecutive records.`);
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

    // -------------------------
    // 10) Negative available balance
    // -------------------------
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
    } else if (todayAvail < RISK_THRESHOLDS.negativeAvailableBalance.low) {
      available_balance_flagged = true;
      availSeverity = "LOW";
      availScore = Math.round(RISK_WEIGHTS.negativeAvailableBalance * 0.35);
      reasons.push(`Available balance has turned negative at ${fmtMoney(todayAvail)}.`);
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

    // -------------------------
    // 11) Outstanding exposure
    // -------------------------
    let outSeverity: MetricResult["severity"] = "NONE";
    let outScore = 0;

    if (outstandingBal > RISK_THRESHOLDS.outstandingExposure.high && engineScore > 0) {
      outSeverity = "HIGH";
      outScore = RISK_WEIGHTS.outstandingExposure;
      reasons.push(
        `Outstanding exposure is large at ${fmtMoney(outstandingBal)}, increasing the impact of other risk signals.`
      );
    }

    engineScore += outScore;
    metrics.push({
      metric_id: "OUTSTANDING_EXPOSURE",
      value: outstandingBal,
      unit: "$",
      explanation: `Outstanding exposure is ${fmtMoney(outstandingBal)}.`,
      severity: outSeverity,
      score_contribution: outScore,
      triggered: outScore > 0,
    });

    // -------------------------
    // 12) Due from supplier positive
    // -------------------------
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
    } else if (todayDueFromSupplier > 0) {
      due_from_supplier_flagged = true;
      dfsSeverity = "LOW";
      dfsScore = Math.round(RISK_WEIGHTS.dueFromSupplierPositive * 0.35);
      reasons.push(`Due from supplier is positive at ${fmtMoney(todayDueFromSupplier)}.`);
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
          : "Due from supplier is zero or not available.",
      severity: dfsSeverity,
      score_contribution: dfsScore,
      triggered: due_from_supplier_flagged,
    });

    // hard escalation floor
    const hardTriggerCount =
      Number(dueFromSupplierTurnedPositive) +
      Number(negativeNetEarningStreak >= 3) +
      Number(todayAvail <= RISK_THRESHOLDS.negativeAvailableBalance.high) +
      Number(chargebackRatio !== null && chargebackRatio > RISK_THRESHOLDS.chargebackRatio.critical) +
      Number(marketplacePaymentGapRatio !== null && marketplacePaymentGapRatio > 5);

    if (hardTriggerCount >= 2) {
      engineScore = Math.max(engineScore, 85);
    } else if (hardTriggerCount === 1) {
      engineScore = Math.max(engineScore, 65);
    }

    const engine_score_100 = clamp100(engineScore);
    const engine_suggested_risk_score = mapEngineScore100ToRisk1to10(engine_score_100);

    const isFlagged = metrics.some((m) => m.triggered);

    return {
      ...r,
      receivable_flagged,
      liability_flagged,
      marketplace_payment_flagged,
      marketplace_payment_gap_flagged,
      net_earning_flagged,
      available_balance_flagged,
      due_from_supplier_flagged,
      chargeback_flagged,

      receivable_vs_history_ratio: receivableVsHistoryRatio,
      liability_vs_history_ratio: liabilityVsHistoryRatio,
      marketplace_payment_vs_history_ratio: marketplacePaymentVsHistoryRatio,
      chargeback_vs_history_ratio: chargebackVsHistoryRatio,
      chargeback_ratio: chargebackRatio,
      due_from_supplier_ratio: dueFromSupplierRatio,
      due_from_supplier_turned_positive: dueFromSupplierTurnedPositive,

      metrics,
      flag_reasons: isFlagged ? reasons : [],

      engine_score_100,
      engine_suggested_risk_score,
      policy_version: RISK_POLICY_VERSION,
    };
  });

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
        (x) => x.engine_suggested_risk_score >= 5 && x.engine_suggested_risk_score <= 7
      ).length,
      "1-4 (moderate)": flagged.filter((x) => x.engine_suggested_risk_score <= 4).length,
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