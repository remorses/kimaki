// Usage counter Durable Object with SQLite storage for Kimaki Pro.
// One DO instance per org (via idFromName(orgId)).
// Records cost per request in a single RPC call and enforces spending limits.

import { DurableObject } from 'cloudflare:workers'

// Fraction of subscription revenue allocated to inference costs.
// At 0.80, we cut off usage when Fireworks costs reach 80% of $49 = $39.20/month.
export const COST_LIMIT_RATIO = 0.80

// Monthly subscription price in dollars
export const SUBSCRIPTION_PRICE_USD = 49

// Monthly cost ceiling per org in dollars
export const MONTHLY_COST_LIMIT_USD = SUBSCRIPTION_PRICE_USD * COST_LIMIT_RATIO

export interface UsageSnapshot {
  totalCostUsd: number
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
}

export class UsageCounter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cost_usd REAL NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT 'kimaki',
        created_at INTEGER NOT NULL
      )
    `)
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_created
      ON usage_events (created_at)
    `)
  }

  /**
   * Record a single request's usage. Combines all metrics into one RPC call.
   * Returns the updated monthly cost so the caller can check limits.
   */
  async record(params: {
    costUsd: number
    inputTokens: number
    outputTokens: number
    model?: string
  }): Promise<{ monthlyCostUsd: number; limitExceeded: boolean }> {
    const now = Date.now()
    this.ctx.storage.sql.exec(
      `INSERT INTO usage_events (cost_usd, input_tokens, output_tokens, model, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      params.costUsd,
      params.inputTokens,
      params.outputTokens,
      params.model ?? 'kimaki',
      now,
    )

    const monthStart = getMonthStartMs()
    const row = this.ctx.storage.sql
      .exec(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost FROM usage_events WHERE created_at >= ?`,
        monthStart,
      )
      .one()
    const monthlyCostUsd = row.total_cost as number

    return {
      monthlyCostUsd,
      limitExceeded: monthlyCostUsd >= MONTHLY_COST_LIMIT_USD,
    }
  }

  /**
   * Check current month's usage without recording anything.
   * Used for pre-flight limit checks and dashboard display.
   */
  async getMonthlyUsage(): Promise<UsageSnapshot> {
    const monthStart = getMonthStartMs()
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
          COALESCE(SUM(cost_usd), 0) AS total_cost,
          COUNT(*) AS total_requests,
          COALESCE(SUM(input_tokens), 0) AS total_input,
          COALESCE(SUM(output_tokens), 0) AS total_output
        FROM usage_events WHERE created_at >= ?`,
        monthStart,
      )
      .one()

    return {
      totalCostUsd: row.total_cost as number,
      totalRequests: row.total_requests as number,
      totalInputTokens: row.total_input as number,
      totalOutputTokens: row.total_output as number,
    }
  }

  /** Prune events older than a given timestamp. */
  async pruneOlderThan(beforeMs: number): Promise<number> {
    this.ctx.storage.sql.exec(
      `DELETE FROM usage_events WHERE created_at < ?`,
      beforeMs,
    )
    const row = this.ctx.storage.sql.exec(`SELECT changes() AS deleted`).one()
    return row.deleted as number
  }
}

/** Returns epoch ms for the 1st of the current UTC month. */
function getMonthStartMs(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
}
