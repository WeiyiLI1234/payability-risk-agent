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

type GetSupplierRiskInputOptions = {
  supplierKeys?: string[];
  limit?: number;
};

/**
 * Risk-engine input:
 * - Universe = suppliers currently marked Active in v_supplier_summary
 * - No incremental pre-filter on "recent transaction activity"
 * - Latest snapshot + trailing history features are all computed here
 * - Payment delay is activation-aware:
 *   - if there has been no marketplace payment since the latest activation date,
 *     use days_since_last_activation
 *   - otherwise use days_since_last_marketplace_payment
 */
export async function getSupplierRiskInputData(
  options: GetSupplierRiskInputOptions = {}
) {
  const supplierKeys = options.supplierKeys ?? [];
  const limit = options.limit ?? 5000;
  const useSupplierFilter = supplierKeys.length > 0;

  const query = `
    WITH target_suppliers AS (
      SELECT supplier_key
      FROM UNNEST(@supplier_keys) AS supplier_key
    ),

    active_suppliers AS (
      SELECT DISTINCT supplier_key
      FROM \`bigqueryexport-183608.PayabilitySheets.v_supplier_summary\`
      WHERE payability_status = 'Active'
        AND supplier_key IS NOT NULL
        AND (
          @use_supplier_filter = FALSE
          OR supplier_key IN (SELECT supplier_key FROM target_suppliers)
        )
    ),

    activation_dates AS (
      SELECT
        ss.supplier_key,
        MAX(COALESCE(r.reactivation_date, ss.first_purchase_date)) AS last_activation_date
      FROM \`bigqueryexport-183608.PayabilitySheets.v_supplier_summary\` ss
      LEFT JOIN \`bigqueryexport-183608.daniel_sandbox.reactivations\` r
        USING (supplier_key)
      INNER JOIN active_suppliers a
        ON ss.supplier_key = a.supplier_key
      GROUP BY ss.supplier_key
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
        AND liability >= 100
    ),

    trailing_6 AS (
      SELECT
        supplier_key,
        receivable,
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
        APPROX_QUANTILES(chargeback, 100)[OFFSET(50)] AS trailing_median_chargeback
      FROM trailing_6
      WHERE hist_rn BETWEEN 2 AND 7
      GROUP BY supplier_key
    ),

    negative_streak_source AS (
      SELECT
        supplier_key,
        net_earning,
        ROW_NUMBER() OVER (
          PARTITION BY supplier_key
          ORDER BY xact_post_date DESC
        ) AS rn
      FROM base
    ),

    negative_net_stats AS (
      SELECT
        supplier_key,
        COUNTIF(net_earning < 0) AS negative_net_earning_streak,
        SUM(net_earning) AS recent_3_net_earning_sum
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
    ),

    payment_since_activation AS (
      SELECT
        ad.supplier_key,
        COUNTIF(
          b.marketplace_payment > 0
          AND ad.last_activation_date IS NOT NULL
          AND b.xact_post_date >= ad.last_activation_date
        ) AS payment_count_since_activation,
        MAX(
          CASE
            WHEN b.marketplace_payment > 0
              AND ad.last_activation_date IS NOT NULL
              AND b.xact_post_date >= ad.last_activation_date
            THEN b.xact_post_date
            ELSE NULL
          END
        ) AS last_payment_since_activation_date
      FROM activation_dates ad
      LEFT JOIN base b
        ON ad.supplier_key = b.supplier_key
      GROUP BY ad.supplier_key
    ),

    transaction_activity AS (
      SELECT
        supplier_key,
        COUNTIF(
          xact_post_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 21 DAY)
        ) AS transaction_records_last_21d,
        MAX(xact_post_date) AS last_transaction_date
      FROM base
      GROUP BY supplier_key
    ),

    receivable_recent AS (
      SELECT
        supplier_key,
        rn_desc,
        receivable
      FROM supplier_history
      WHERE rn_desc <= 3
    ),

    receivable_trend_raw AS (
      SELECT
        supplier_key,
        MAX(CASE WHEN rn_desc = 1 THEN receivable END) AS receivable_r1,
        MAX(CASE WHEN rn_desc = 2 THEN receivable END) AS receivable_r2,
        MAX(CASE WHEN rn_desc = 3 THEN receivable END) AS receivable_r3
      FROM receivable_recent
      GROUP BY supplier_key
    ),

    receivable_trend AS (
      SELECT
        supplier_key,
        CASE
          WHEN receivable_r1 IS NOT NULL
            AND receivable_r2 IS NOT NULL
            AND receivable_r3 IS NOT NULL
            AND receivable_r1 < receivable_r2
            AND receivable_r2 < receivable_r3
          THEN 3
          WHEN receivable_r1 IS NOT NULL
            AND receivable_r2 IS NOT NULL
            AND receivable_r1 < receivable_r2
          THEN 2
          ELSE 0
        END AS receivable_down_streak_3
      FROM receivable_trend_raw
    )

    SELECT
      l.supplier_key,
      l.supplier_name,

      l.receivable AS today_receivable,
      l.prev_receivable,

      l.liability AS today_liability,

      l.net_earning AS today_net_earning,
      l.chargeback AS today_chargeback,
      l.available_balance AS today_available_balance,
      l.outstanding_bal AS today_outstanding_bal,

      l.due_from_supplier AS today_due_from_supplier,
      l.prev_due_from_supplier,

      CASE
        WHEN l.prev_receivable IS NULL OR l.prev_receivable = 0 THEN NULL
        ELSE ROUND(
          SAFE_DIVIDE(l.receivable - l.prev_receivable, ABS(l.prev_receivable)) * 100,
          2
        )
      END AS receivable_change_pct,

      IF(l.prev_receivable IS NULL, FALSE, TRUE) AS has_prev_week_data,

      tm.trailing_median_receivable,
      tm.trailing_median_chargeback,

      nns.negative_net_earning_streak,
      nns.recent_3_net_earning_sum,

      ad.last_activation_date,
      DATE_DIFF(CURRENT_DATE(), ad.last_activation_date, DAY) AS days_since_last_activation,

      IFNULL(psa.payment_count_since_activation, 0) > 0 AS has_payment_since_activation,
      psa.last_payment_since_activation_date,

      lp.last_marketplace_payment_date,
      DATE_DIFF(CURRENT_DATE(), lp.last_marketplace_payment_date, DAY) AS days_since_last_marketplace_payment,
      pgs.historical_median_payment_gap_days,

      ta.transaction_records_last_21d,
      ta.last_transaction_date,
      DATE_DIFF(CURRENT_DATE(), ta.last_transaction_date, DAY) AS days_since_latest_transaction,

      rt.receivable_down_streak_3

    FROM latest_row l
    LEFT JOIN trailing_medians tm
      ON l.supplier_key = tm.supplier_key
    LEFT JOIN negative_net_stats nns
      ON l.supplier_key = nns.supplier_key
    LEFT JOIN activation_dates ad
      ON l.supplier_key = ad.supplier_key
    LEFT JOIN payment_since_activation psa
      ON l.supplier_key = psa.supplier_key
    LEFT JOIN last_payment lp
      ON l.supplier_key = lp.supplier_key
    LEFT JOIN payment_gap_stats pgs
      ON l.supplier_key = pgs.supplier_key
    LEFT JOIN transaction_activity ta
      ON l.supplier_key = ta.supplier_key
    LEFT JOIN receivable_trend rt
      ON l.supplier_key = rt.supplier_key

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
    types: {
      supplier_keys: ["STRING"],
    },
  });

  return rows;
}

/**
 * Compatibility shim for legacy callers.
 * If no supplierKeys provided, fetches all active suppliers' latest state.
 */
export async function getDailyChangeData() {
  return getSupplierRiskInputData();
}