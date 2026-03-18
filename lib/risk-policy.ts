// lib/risk-policy.ts

export const RISK_POLICY_VERSION = "v3.3.0";

export const RISK_THRESHOLDS = {
  receivableAnomaly: {
    wowLow: 50,
    wowHigh: 100,
    wowCritical: 200,

    histLow: 2.0,
    histHigh: 4.0,
    histCritical: 8.0,

    // Absolute gates
    // MEDIUM: today_receivable >= $3,000 AND (today - prev) >= $2,000
    // HIGH / CRITICAL: today_receivable >= $5,000 AND (today - prev) >= $2,000
    minTodayReceivableMedium: 3_000,
    minTodayReceivableHighCrit: 5_000,
    minDeltaReceivable: 2_000,
  },

  liabilityAnomaly: {
    wowLow: 50,
    wowHigh: 100,
    wowCritical: 200,

    histLow: 1.5,
    histHigh: 2.8,
    histCritical: 4.2,

    // Absolute gates
    // today_liability >= $10,000 AND absolute delta >= $5,000
    minAbsLiability: 10_000,
    minDeltaLiability: 5_000,
  },

  chargebackAnomaly: {
    ratioLow: 0.6,
    ratioHigh: 1.0,
    ratioCritical: 1.8,

    histLow: 2.0,
    histHigh: 4.5,
    histCritical: 10.0,

    // Absolute gates — at least one must be true
    // MEDIUM: today_chargeback >= $200 OR delta_vs_median >= $200
    // HIGH / CRITICAL: today_chargeback >= $500 OR delta_vs_median >= $200
    minChargebackAmountMedium: 200,
    minChargebackAmountHigh: 500,
    minChargebackDeltaVsMedian: 200,
  },

  marketplacePaymentDelayDays: {
    low: 14,
    high: 21,
    critical: 28,
  },

  negativeNetEarning: {
    low: -200,
    high: -50_000,
  },

  negativeAvailableBalance: {
    // LOW tier removed (was < 0)
    medium: -500,
    high: -2_000,
    critical: -7_000,
  },

  dueFromSupplierPct: {
    // LOW tier removed (was any > 0)
    medium: 0.10,
    high: 0.25,
  },

  // Active-supplier gate — used by payment-delay and chargeback metrics.
  // A supplier is active if any one of these is true:
  //   - had a marketplace payment within the last 30 days
  //   - currently has a positive receivable
  //   - outstanding balance >= $1,000
  activeSupplier: {
    maxDaysSincePayment: 30,
    minOutstandingBal: 1_000,
  },

  // Reactivation suppression for MARKETPLACE_PAYMENT_DELAY.
  // If the gap between the current record and the immediately preceding record
  // exceeds this threshold (days), the supplier is considered recently reactivated
  // after a dormant period. In that case, payment delay is suppressed because
  // the long gap since the last payment reflects dormancy, not a true delay.
  reactivationGapDays: 90,

  // Scheme B: a supplier is only flagged when the engine score
  // maps to at least this risk level on the 1–10 scale.
  minFlaggedRiskScore: 5,
} as const;

export const RISK_WEIGHTS = {
  receivableAnomaly: 8,
  liabilityAnomaly: 10,
  marketplacePaymentDelay: 12,
  chargebackAnomaly: 18,
  negativeNetEarning: 15,
  negativeAvailableBalance: 20,
  dueFromSupplierPositive: 19,
} as const;

export function mapEngineScore100ToRisk1to10(score: number): number {
  if (score >= 90) return 10;
  if (score >= 80) return 9;
  if (score >= 70) return 8;
  if (score >= 60) return 7;
  if (score >= 50) return 6;
  if (score >= 40) return 5;
  if (score >= 30) return 4;
  if (score >= 20) return 3;
  if (score >= 10) return 2;
  return 1;
}