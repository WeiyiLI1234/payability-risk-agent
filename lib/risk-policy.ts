// lib/risk-policy.ts

export const RISK_POLICY_VERSION = "v3.2.0";

export const RISK_THRESHOLDS = {
  receivableAnomaly: {
    wowLow: 50,
    wowHigh: 100,
    wowCritical: 200,

    histLow: 2.0,
    histHigh: 4.0,
    histCritical: 8.0,

    // Absolute gates — replace old flat materiality block
    // MEDIUM: today_receivable >= 3000 AND (today - prev) >= 2000
    // HIGH / CRITICAL: today_receivable >= 5000 AND (today - prev) >= 2000
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
    // today_liability >= 10 000 AND absolute delta >= 5 000
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
    // today_chargeback >= 200 (MEDIUM) or >= 500 (HIGH / CRITICAL)
    // OR today_chargeback - trailing_median_chargeback >= 200
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
    low: -200,        // loosened from -5 000 — catches any meaningful negative period
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

  // Active-supplier gate — used by payment-delay and chargeback metrics
  activeSupplier: {
    maxDaysSincePayment: 30,   // last marketplace payment within 30 days
    minOutstandingBal: 1_000,  // or has substantial outstanding balance
  },

  // Scheme B: a supplier is only flagged when the engine score
  // maps to at least this risk level on the 1–10 scale
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