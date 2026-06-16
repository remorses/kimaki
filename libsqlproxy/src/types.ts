// Hrana v2 protocol types for the libSQL remote protocol.
// Spec: https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md

export type HranaValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string }

export interface HranaStmt {
  sql?: string
  sql_id?: number
  args?: HranaValue[]
  named_args?: Array<{ name: string; value: HranaValue }>
  want_rows?: boolean
}

export interface HranaCondition {
  type: 'ok' | 'error' | 'not' | 'and' | 'or' | 'is_autocommit'
  step?: number
  cond?: HranaCondition
  conds?: HranaCondition[]
}

export interface HranaBatchStep {
  stmt: HranaStmt
  condition?: HranaCondition | null
}

export interface HranaRequest {
  type: string
  stmt?: HranaStmt
  batch?: { steps: HranaBatchStep[] }
  sql?: string
  sql_id?: number
}

export interface HranaPipelineRequest {
  baton: string | null
  requests: HranaRequest[]
}

export interface HranaColInfo {
  name: string
  decltype: string | null
}

export interface HranaExecuteResult {
  cols: HranaColInfo[]
  rows: HranaValue[][]
  affected_row_count: number
  last_insert_rowid: string | null
}

export interface HranaDescribeResult {
  params: Array<{ name: string | null }>
  cols: HranaColInfo[]
  is_explain: boolean
  is_readonly: boolean
}

export interface HranaError {
  message: string
  code: string
}

export type HranaStreamResult =
  | { type: 'ok'; response: { type: string; result?: unknown } }
  | { type: 'error'; error: HranaError }

export interface HranaPipelineResponse {
  baton: string | null
  base_url: string | null
  results: HranaStreamResult[]
}
