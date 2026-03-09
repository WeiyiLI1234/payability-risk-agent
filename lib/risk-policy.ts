// lib/risk-policy.ts

export const RISK_POLICY_VERSION = "v2.0.0";

export const RISK_THRESHOLDS = {
  receivableWowPct: { low: 50, high: 200 },
  liabilityWowPct: { low: 50, high: 200 },

  marketplacePaymentDropPct: {
    low: -50,
    high: -80,
  },

  chargebackRatio: {
    low: 0.6,
    high: 1.0,
    critical: 1.8,
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

  outstandingExposure: {
    high: 500_000,
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
  receivableSpike: 8,
  liabilitySpike: 10,
  marketplacePaymentDrop: 10,
  chargebackRatio: 18,
  negativeNetEarning: 15,
  negativeAvailableBalance: 20,
  dueFromSupplierPositive: 19,
  outstandingExposure: 5,
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