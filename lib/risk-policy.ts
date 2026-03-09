// lib/risk-policy.ts

export const RISK_POLICY_VERSION = "v3.0.0";

export const RISK_THRESHOLDS = {
  receivableAnomaly: {
    wowLow: 50,
    wowHigh: 100,
    wowCritical: 200,

    histLow: 2.0,
    histHigh: 4.0,
    histCritical: 8.0,
  },

  liabilityAnomaly: {
    wowLow: 50,
    wowHigh: 100,
    wowCritical: 200,

    histLow: 1.5,
    histHigh: 2.8,
    histCritical: 4.2,
  },

  chargebackAnomaly: {
    ratioLow: 0.6,
    ratioHigh: 1.0,
    ratioCritical: 1.8,

    histLow: 2.0,
    histHigh: 4.5,
    histCritical: 10.0,
  },

  marketplacePaymentDelayDays: {
    low: 14,
    high: 21,
    critical: 28,
  },

  negativeNetEarning: {
    low: -5_000,
    high: -50_000,
  },

  negativeAvailableBalance: {
    low: 0,
    medium: -500,
    high: -2_000,
    critical: -7_000,
  },

  dueFromSupplierPct: {
    medium: 0.10,
    high: 0.25,
  },

  materiality: {
    minBaseReceivable: 25_000,
    minBaseLiability: 25_000,
    minAbsDeltaReceivable: 10_000,
    minAbsDeltaLiability: 10_000,
  },
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