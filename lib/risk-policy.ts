export const RISK_POLICY_VERSION = "v4.1.0";

export const RISK_THRESHOLDS = {
  receivableSurge: {
    wowLow: 50,
    wowHigh: 100,
    wowCritical: 200,

    histLow: 2.0,
    histHigh: 4.0,
    histCritical: 8.0,

    minTodayReceivableMedium: 3_000,
    minTodayReceivableHighCrit: 5_000,
    minDeltaReceivable: 2_000,
  },

  receivableDrop: {
    // Any ONE of the following can trigger:
    wowMediumDropPct: 50, // <= -50%
    wowHighDropPct: 70,   // <= -70%

    histMediumMaxRatio: 0.60, // current <= 0.60x trailing median
    histHighMaxRatio: 0.40,   // current <= 0.40x trailing median

    minPrevReceivable: 5_000,
    minTrailingMedianReceivable: 3_000,

    sustainedDownStreakMedium: 2,
    sustainedDownStreakHigh: 3,
  },

  marketplacePaymentDelayDays: {
    medium: 21,
    high: 28,
    critical: 35,
  },

  paymentDelayEligibility: {
    recentTransactionWindowDays: 21,
    minRecentTransactionCount: 2,
    maxDaysSinceLatestTransaction: 14,
  },

  chargebackAnomaly: {
    ratioLow: 0.6,
    ratioHigh: 1.0,
    ratioCritical: 1.8,

    histLow: 2.0,
    histHigh: 4.5,
    histCritical: 10.0,

    minChargebackAmountMedium: 200,
    minChargebackAmountHigh: 500,
    minChargebackDeltaVsMedian: 200,
  },

  negativeNetEarning: {
    medium: -500,
    high: -10_000,
    critical3PeriodSum: -1_000,
  },

  negativeAvailableBalance: {
    medium: -500,
    high: -2_000,
    critical: -7_000,
  },

  dueFromSupplierPct: {
    medium: 0.10,
    high: 0.25,
  },

  dueFromSupplierTurnedPositive: {
    criticalMinAmount: 100,
    criticalMinRatio: 0.05,
  },

  minFlaggedRiskScore: 3,
} as const;

export const RISK_WEIGHTS = {
  receivableSurge: 8,
  receivableDrop: 10,
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