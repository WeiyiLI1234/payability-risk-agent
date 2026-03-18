// lib/bigquery.ts

import { BigQuery } from "@google-cloud/bigquery";

function getBigQueryClient() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || "bigqueryexport-183608";

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    return new BigQuery({ projectId, credentials });
  }

  return new BigQuery({ projectId });
}

const bigquery = getBigQueryClient();

/**
 * 增量入口：
 * 找出最近 N 天有新记录的 supplier。
 * Only returns suppliers with payability_status = 'Active'.
 */
export async function getChangedSupplierKeys(daysBack = 2): Promise<string[]> {
  const query = `
    SELECT DISTINCT t.supplier_key
    FROM \`bigqueryexport-183608.PayabilitySheets.vm_transaction_summary\` t
    INNER JOIN \`bigqueryexport-183608.PayabilitySheets.v_supplier_summary\` s
      ON t.supplier_key = s.supplier_key
    WHERE t.xact_post_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days_back DAY)
      AND t.xact_post_date <= CURRENT_DATE()
      AND t.supplier_key IS NOT NULL
      AND s.payability_status = 'Active'
  `;

  const [rows] = await bigquery.query({
    query,
    params: { days_back: daysBack },
  });

  return (rows as Array<{ supplier_key: string }>).map((r) => r.supplier_key);
}

type GetSupplierRiskInputOptions = {
  supplierKeys?: string[];
  limit?: number;
};

export async function getSupplierRiskInputData(
  options: GetSupplierRiskInputOptions = {}
) {
  const supplierKeys = options.supplierKeys ?? [];
  const limit = options.limit ?? 2000;
  const useSupplierFilter = supplierKeys.length > 0;

  const query = `
    WITH target_suppliers AS (
      SELECT supplier_key
      FROM UNNEST(@supplier_keys) AS supplier_key
    ),

    -- Only include suppliers that are currently Active in v_supplier_summary.
    -- Suspended and Pending suppliers are excluded entirely from the risk engine.
    active_suppliers AS (
      SELECT DISTINCT supplier_key
      FROM \`bigqueryexport-183608.PayabilitySheets.v_supplier_summary\`
      WHERE payability_status = 'Active'
    ),

    base AS (
      SELECT
        t.supplier_key,
        t.supplier_name,
        t.xact_post_date,

        IFNULL(t.receivable, 0) AS receivable,
        IFNULL(t.potential_liability, 0) AS liability,
        IFNULL(t.net_earning, 0) AS net_earning,
        IFNULL(t.chargeback, 0) AS chargeback,
        IFNULL(t.available_balance, 0) AS available_balance,
        IFNULL(t.outstanding_bal, 0) AS outstanding_bal,
        IFNULL(t.marketplace_payment, 0) AS marketplace_payment,
        IFNULL(t.due_from_supplier, 0) AS due_from_supplier
      FROM \`bigqueryexport-183608.PayabilitySheets.vm_transaction_summary\` t
      INNER JOIN active_suppliers a
        ON t.supplier_key = a.supplier_key
      WHERE t.xact_post_date <= CURRENT_DATE()
        AND (
          @use_supplier_filter = FALSE
          OR t.supplier_key IN (SELECT supplier_key FROM target_suppliers)
        )
    ),

    supplier_history AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date DESC
        ) AS rn_desc,

        LAG(receivable) OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date
        ) AS prev_receivable,

        LAG(liability) OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date
        ) AS prev_liability,

        LAG(marketplace_payment) OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date
        ) AS prev_marketplace_payment,

        LAG(due_from_supplier) OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date
        ) AS prev_due_from_supplier
      FROM base
    ),

    latest_row AS (
      SELECT *
      FROM supplier_history
      WHERE rn_desc = 1
        AND liability >= 1000  -- skip suppliers with today_liability < $1,000
    ),

    trailing_6 AS (
      SELECT
        supplier_key,
        xact_post_date,
        receivable,
        liability,
        marketplace_payment,
        chargeback,
        ROW_NUMBER() OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date DESC
        ) AS hist_rn
      FROM base
    ),

    trailing_medians AS (
      SELECT
        supplier_key,
        APPROX_QUANTILES(receivable, 100)[OFFSET(50)] AS trailing_median_receivable,
        APPROX_QUANTILES(liability, 100)[OFFSET(50)] AS trailing_median_liability,
        APPROX_QUANTILES(marketplace_payment, 100)[OFFSET(50)] AS trailing_median_marketplace_payment,
        APPROX_QUANTILES(chargeback, 100)[OFFSET(50)] AS trailing_median_chargeback
      FROM trailing_6
      WHERE hist_rn BETWEEN 2 AND 7
      GROUP BY supplier_key
    ),

    negative_streak_source AS (
      SELECT
        supplier_key,
        xact_post_date,
        net_earning,
        ROW_NUMBER() OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date DESC
        ) AS rn
      FROM base
    ),

    negative_net_streak AS (
      SELECT
        supplier_key,
        COUNTIF(net_earning < 0) AS negative_net_earning_streak
      FROM negative_streak_source
      WHERE rn <= 3
      GROUP BY supplier_key
    ),

    payment_events AS (
      SELECT
        supplier_key,
        xact_post_date,
        marketplace_payment,
        LAG(xact_post_date) OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date
        ) AS prev_payment_date,
        ROW_NUMBER() OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date DESC
        ) AS payment_rn_desc
      FROM base
      WHERE marketplace_payment > 0
    ),

    payment_gaps AS (
      SELECT
        supplier_key,
        xact_post_date,
        DATE_DIFF(xact_post_date, prev_payment_date, DAY) AS payment_gap_days
      FROM payment_events
      WHERE prev_payment_date IS NOT NULL
    ),

    payment_gap_stats AS (
      SELECT
        supplier_key,
        APPROX_QUANTILES(payment_gap_days, 100)[OFFSET(50)] AS historical_median_payment_gap_days
      FROM payment_gaps
      GROUP BY supplier_key
    ),

    last_payment AS (
      SELECT
        supplier_key,
        xact_post_date AS last_marketplace_payment_date
      FROM payment_events
      WHERE payment_rn_desc = 1
    )

    SELECT
      l.supplier_key,
      l.supplier_name,

      l.receivable AS today_receivable,
      l.prev_receivable,

      l.liability AS today_liability,
      l.prev_liability,

      l.net_earning AS today_net_earning,
      l.chargeback AS today_chargeback,
      l.available_balance AS today_available_balance,
      l.outstanding_bal AS today_outstanding_bal,

      l.marketplace_payment AS today_marketplace_payment,
      l.prev_marketplace_payment,

      l.due_from_supplier AS today_due_from_supplier,
      l.prev_due_from_supplier,

      CASE
        WHEN l.prev_receivable IS NULL OR l.prev_receivable = 0 THEN NULL
        ELSE ROUND(
          SAFE_DIVIDE(l.receivable - l.prev_receivable, ABS(l.prev_receivable)) * 100,
          2
        )
      END AS receivable_change_pct,

      CASE
        WHEN l.prev_liability IS NULL OR l.prev_liability = 0 THEN NULL
        ELSE ROUND(
          SAFE_DIVIDE(l.liability - l.prev_liability, ABS(l.prev_liability)) * 100,
          2
        )
      END AS liability_change_pct,

      CASE
        WHEN l.prev_marketplace_payment IS NULL OR l.prev_marketplace_payment = 0 THEN NULL
        ELSE ROUND(
          SAFE_DIVIDE(
            l.marketplace_payment - l.prev_marketplace_payment,
            ABS(l.prev_marketplace_payment)
          ) * 100,
          2
        )
      END AS marketplace_payment_change_pct,

      IF(l.prev_receivable IS NULL, FALSE, TRUE) AS has_prev_week_data,

      tm.trailing_median_receivable,
      tm.trailing_median_liability,
      tm.trailing_median_marketplace_payment,
      tm.trailing_median_chargeback,

      ns.negative_net_earning_streak,

      DATE_DIFF(CURRENT_DATE(), lp.last_marketplace_payment_date, DAY) AS days_since_last_marketplace_payment,
      pgs.historical_median_payment_gap_days

    FROM latest_row l
    LEFT JOIN trailing_medians tm
      ON l.supplier_key = tm.supplier_key
    LEFT JOIN negative_net_streak ns
      ON l.supplier_key = ns.supplier_key
    LEFT JOIN last_payment lp
      ON l.supplier_key = lp.supplier_key
    LEFT JOIN payment_gap_stats pgs
      ON l.supplier_key = pgs.supplier_key

    ORDER BY l.outstanding_bal DESC
    LIMIT @limit
  `;

  const [rows] = await bigquery.query({
    query,
    params: {
      supplier_keys: supplierKeys,
      use_supplier_filter: useSupplierFilter,
      limit,
    },
  });

  return rows;
}

/**
 * 兼容旧调用。
 * 若不传 supplierKeys，则拉全量最新状态。
 */
export async function getDailyChangeData() {
  return getSupplierRiskInputData();
}