'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import type { TraceExample, TraceLogItem, TraceMetric, TraceSpan } from './fake-data'

type TraceExplorerClientProps = {
  traces: TraceExample[]
}

type TabKey = 'summary' | 'attributes' | 'context' | 'logs-events'

type SpanNode = TraceSpan & {
  depth: number
  children: SpanNode[]
}

type TimelineWindow = {
  start: number
  end: number
}

type TraceDemo = {
  id: string
  title: string
  description: string
  traceId: string
  spanId?: string
  collapsedSpanIds?: string[]
  focusMode?: 'full-trace' | 'selected-span'
}

export function TraceExplorerClient({ traces }: TraceExplorerClientProps) {
  const initialHash = useMemo(() => {
    return readTraceHash()
  }, [])
  const [selectedTraceId, setSelectedTraceId] = useState(initialHash.traceId ?? traces[0]?.id ?? '')
  const selectedTrace = traces.find((trace) => trace.id === selectedTraceId) ?? traces[0]
  const previousTraceId = useRef(selectedTraceId)
  const tree = useMemo(() => {
    return selectedTrace ? buildTraceTree({ spans: selectedTrace.spans }) : []
  }, [selectedTrace])
  const fullFlattened = useMemo(() => {
    return flattenTree({ nodes: tree })
  }, [tree])
  const [collapsedSpanIds, setCollapsedSpanIds] = useState<string[]>([])
  const flattened = useMemo(() => {
    return flattenVisibleTree({ nodes: tree, collapsedSpanIds })
  }, [collapsedSpanIds, tree])
  const [selectedSpanId, setSelectedSpanId] = useState(initialHash.spanId ?? selectedTrace?.spans[0]?.id ?? '')
  const [activeTab, setActiveTab] = useState<TabKey>('summary')
  const [timelineWindow, setTimelineWindow] = useState<TimelineWindow | null>(null)
  const [hoveredSpanId, setHoveredSpanId] = useState<string | null>(null)
  const [showCriticalPath, setShowCriticalPath] = useState(true)

  const stableSelectedSpan = useMemo(() => {
    const span = fullFlattened.find((node) => node.id === selectedSpanId)
    return span ?? fullFlattened[0] ?? null
  }, [fullFlattened, selectedSpanId])

  const timelineRange = useMemo(() => {
    if (fullFlattened.length === 0) {
      return { start: 0, end: 1, total: 1 }
    }

    const start = Math.min(...fullFlattened.map((span) => span.startNs))
    const end = Math.max(...fullFlattened.map((span) => span.startNs + span.durationNs))
    return {
      start,
      end,
      total: Math.max(1, end - start),
    }
  }, [fullFlattened])

  const clampedTimelineWindow = useMemo(() => {
    return clampTimelineWindow({
      timelineRange,
      window: timelineWindow,
    })
  }, [timelineRange, timelineWindow])

  const criticalPathSpanIds = useMemo(() => {
    return getCriticalPathSpanIds({ nodes: tree })
  }, [tree])

  const visibleTimelineSpans = useMemo(() => {
    return flattened.filter((span) => {
      return span.startNs < clampedTimelineWindow.end && span.startNs + span.durationNs > clampedTimelineWindow.start
    })
  }, [clampedTimelineWindow.end, clampedTimelineWindow.start, flattened])

  const hoveredSpan = useMemo(() => {
    if (!hoveredSpanId) {
      return null
    }

    return fullFlattened.find((span) => span.id === hoveredSpanId) ?? null
  }, [fullFlattened, hoveredSpanId])

  const demos = useMemo<TraceDemo[]>(() => {
    return [
      {
        id: 'fanout',
        title: 'Fanout example',
        description: 'Parallel services start within the first 60ms and rejoin into one renderer span.',
        traceId: 'trace-service-fanout',
      },
      {
        id: 'cold-start-tail',
        title: 'Cold start bottleneck',
        description: 'Long bootstrap + late upload failure show tail latency clearly.',
        traceId: 'trace-cold-start',
        spanId: 'span-export-upload',
        focusMode: 'selected-span',
      },
      {
        id: 'streaming-window',
        title: 'Streaming response',
        description: 'Long-lived model stream with first-token and body-stream subspans.',
        traceId: 'trace-streaming-chat',
        spanId: 'span-chat-model',
        focusMode: 'selected-span',
      },
      {
        id: 'collapse-noise',
        title: 'Collapsed tree',
        description: 'Hide deep child spans to inspect the top-level lanes only.',
        traceId: 'trace-service-fanout',
        collapsedSpanIds: ['span-dashboard-usage'],
      },
    ]
  }, [])

  useEffect(() => {
    if (!fullFlattened.some((node) => node.id === selectedSpanId)) {
      setSelectedSpanId(fullFlattened[0]?.id ?? '')
    }
  }, [fullFlattened, selectedSpanId])

  useEffect(() => {
    if (!stableSelectedSpan) {
      return
    }

    const ancestorIds = getAncestorIds({ nodes: fullFlattened, spanId: stableSelectedSpan.id })
    if (ancestorIds.every((spanId) => !collapsedSpanIds.includes(spanId))) {
      return
    }

    setCollapsedSpanIds((current) => {
      return current.filter((spanId) => !ancestorIds.includes(spanId))
    })
  }, [collapsedSpanIds, fullFlattened, stableSelectedSpan])

  useEffect(() => {
    if (previousTraceId.current === selectedTraceId) {
      return
    }

    previousTraceId.current = selectedTraceId
    setCollapsedSpanIds([])
    setTimelineWindow(null)
    setHoveredSpanId(null)
  }, [selectedTraceId])

  useEffect(() => {
    if (!selectedTrace || !stableSelectedSpan) {
      return
    }

    if (typeof window === 'undefined') {
      return
    }

    const params = new URLSearchParams()
    params.set('trace', selectedTrace.id)
    params.set('span', stableSelectedSpan.id)
    window.history.replaceState(null, '', `#${params.toString()}`)
  }, [selectedTrace, stableSelectedSpan])

  useEffect(() => {
    if (!initialHash.traceId) {
      return
    }

    const hashTrace = traces.find((trace) => trace.id === initialHash.traceId)
    if (!hashTrace) {
      return
    }

    setSelectedTraceId(hashTrace.id)
    setSelectedSpanId(initialHash.spanId ?? hashTrace.spans[0]?.id ?? '')
  }, [initialHash.spanId, initialHash.traceId, traces])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement
      if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
        return
      }

      if (!stableSelectedSpan) {
        return
      }

      const currentIndex = flattened.findIndex((span) => span.id === stableSelectedSpan.id)
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const nextSpan = flattened[Math.min(flattened.length - 1, currentIndex + 1)]
        if (nextSpan) {
          setSelectedSpanId(nextSpan.id)
        }
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const previousSpan = flattened[Math.max(0, currentIndex - 1)]
        if (previousSpan) {
          setSelectedSpanId(previousSpan.id)
        }
      }
      if (event.key === '+') {
        event.preventDefault()
        setTimelineWindow((current) => zoomTimelineWindow({
          timelineRange,
          window: current,
          nextScale: 0.75,
          focusAt: stableSelectedSpan.startNs + stableSelectedSpan.durationNs / 2,
        }))
      }
      if (event.key === '-') {
        event.preventDefault()
        setTimelineWindow((current) => zoomTimelineWindow({
          timelineRange,
          window: current,
          nextScale: 1.35,
          focusAt: stableSelectedSpan.startNs + stableSelectedSpan.durationNs / 2,
        }))
      }
      if (event.key === '[') {
        event.preventDefault()
        setTimelineWindow((current) => panTimelineWindow({ direction: -1, timelineRange, window: current }))
      }
      if (event.key === ']') {
        event.preventDefault()
        setTimelineWindow((current) => panTimelineWindow({ direction: 1, timelineRange, window: current }))
      }
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setTimelineWindow(focusTimelineWindowOnSpan({ span: stableSelectedSpan, timelineRange }))
      }
      if (event.key.toLowerCase() === 'c') {
        event.preventDefault()
        if (stableSelectedSpan.children.length === 0) {
          return
        }
        setCollapsedSpanIds((current) => toggleCollapsedSpan({ collapsedSpanIds: current, spanId: stableSelectedSpan.id }))
      }
      if (event.key === '0') {
        event.preventDefault()
        setTimelineWindow(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [flattened, stableSelectedSpan, timelineRange])

  if (!selectedTrace || !stableSelectedSpan) {
    return null
  }

  return (
    <div className="mx-auto grid min-h-screen max-w-[1800px] gap-6 px-6 py-6 xl:grid-cols-[320px_minmax(0,1fr)_540px]">
      <aside className="flex flex-col gap-4">
        <section className="rounded bg-white p-4 shadow-elevation-3 border border-elevation-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-tertiary">Trace examples</div>
              <h1 className="mt-2 text-2xl font-semibold text-primary">Better Stack traces</h1>
            </div>
            <span className="inline-flex items-center rounded-full border border-elevation-5 px-3 py-1 text-xs font-medium text-secondary">
              React + Spiceflow
            </span>
          </div>
          <p className="mt-3 text-sm leading-6 text-secondary">
            Standalone recreation of the Better Stack traces surface with fake telemetry, tabs, logs, and span drilldown.
          </p>
        </section>

        <div className="flex flex-col gap-3">
          {traces.map((trace) => {
            const active = trace.id === selectedTrace.id

            return (
              <button
                key={trace.id}
                type="button"
                onClick={() => {
                  setSelectedTraceId(trace.id)
                  setSelectedSpanId(trace.spans[0]?.id ?? '')
                  setActiveTab('summary')
                }}
                className={[
                  'rounded bg-white p-4 text-left shadow-elevation-3 border border-elevation-4 transition',
                  active ? 'ring-2 ring-[var(--brand-primary-200)] border-[var(--brand-primary-200)]' : 'hover:border-[var(--elevation-5)]',
                ].join(' ')}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-primary">{trace.title}</div>
                    <div className="mt-1 text-xs text-secondary">{trace.service}</div>
                  </div>
                  <StatusPill status={trace.status} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-secondary">
                  <TraceMeta label="Trace" value={trace.traceId.slice(0, 14)} />
                  <TraceMeta label="Duration" value={trace.durationLabel} />
                  <TraceMeta label="Env" value={trace.environment} />
                  <TraceMeta label="Started" value={trace.startedAt.slice(11, 23)} />
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      <main className="flex min-w-0 flex-col gap-6">
        <section className="rounded bg-white shadow-elevation-3 border border-elevation-4">
          <div className="border-b border-elevation-4 px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-tertiary">Trace</div>
                <div className="mt-1 text-xl font-semibold text-primary">{selectedTrace.title}</div>
              </div>
              <span className="inline-flex items-center rounded-full border border-elevation-5 px-3 py-1 text-xs font-medium text-secondary">
                {selectedTrace.traceId}
              </span>
              <span className="inline-flex items-center rounded-full border border-elevation-5 px-3 py-1 text-xs font-medium text-secondary">
                {selectedTrace.service}
              </span>
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-sm text-secondary">
              <span>{selectedTrace.startedAt}</span>
              <span>{selectedTrace.durationLabel}</span>
              <span>{selectedTrace.environment}</span>
              <span>{flattened.length} spans</span>
            </div>
          </div>

          <div className="grid gap-px bg-[var(--elevation-5)] md:grid-cols-3">
            {selectedTrace.metrics.map((metric) => {
              return <MetricCard key={metric.label} metric={metric} />
            })}
          </div>
          <div className="grid gap-px border-t border-elevation-4 bg-[var(--elevation-5)] md:grid-cols-4">
            <TraceHighlightCard label="Root service" value={selectedTrace.service} />
            <TraceHighlightCard label="Source" value={selectedTrace.sourceId} />
            <TraceHighlightCard label="Status" value={selectedTrace.status} />
            <TraceHighlightCard label="Selected span" value={stableSelectedSpan.title} />
          </div>
        </section>

        <section className="overflow-hidden rounded bg-white shadow-elevation-3 border border-elevation-4">
          <div className="border-b border-elevation-4 px-5 py-4">
            <div className="text-sm font-semibold text-primary">Trace timeline</div>
            <p className="mt-1 text-sm text-secondary">
              The timeline now supports zooming, panning, collapsing tree branches, critical path highlighting, a minimap brush, keyboard navigation, and deep-linkable selection.
            </p>
          </div>

          <TimelinePlaybook
            demos={demos}
            onSelectDemo={({ demo }) => {
              const nextTrace = traces.find((trace) => trace.id === demo.traceId)
              if (!nextTrace) {
                return
              }

              setSelectedTraceId(nextTrace.id)
              setActiveTab('summary')
              setCollapsedSpanIds(demo.collapsedSpanIds ?? [])
              const nextSelectedSpan = nextTrace.spans.find((span) => span.id === demo.spanId) ?? nextTrace.spans[0]
              if (!nextSelectedSpan) {
                return
              }
              setSelectedSpanId(nextSelectedSpan.id)
              setTimelineWindow(
                demo.focusMode === 'selected-span'
                  ? focusTimelineWindowOnSpan({
                      span: nextSelectedSpan,
                      timelineRange: getTraceRange({ spans: nextTrace.spans }),
                    })
                  : null,
              )
            }}
          />

          <TraceTimeline
            allSpans={fullFlattened}
            criticalPathSpanIds={criticalPathSpanIds}
            hoveredSpanId={hoveredSpanId}
            range={timelineRange}
            selectedSpanId={stableSelectedSpan.id}
            showCriticalPath={showCriticalPath}
            spans={visibleTimelineSpans}
            timelineWindow={clampedTimelineWindow}
            collapsedSpanIds={collapsedSpanIds}
            onSelectSpan={({ spanId }) => {
              setSelectedSpanId(spanId)
            }}
            onFitSelected={() => {
              setTimelineWindow(focusTimelineWindowOnSpan({ span: stableSelectedSpan, timelineRange }))
            }}
            onHoverSpan={({ spanId }) => {
              setHoveredSpanId(spanId)
            }}
            onPanWindow={({ direction }) => {
              setTimelineWindow((current) => panTimelineWindow({ direction, timelineRange, window: current }))
            }}
            onResetWindow={() => {
              setTimelineWindow(null)
            }}
            onSetTimelineWindow={({ nextWindow }) => {
              setTimelineWindow(nextWindow)
            }}
            onToggleCollapse={({ spanId }) => {
              setCollapsedSpanIds((current) => toggleCollapsedSpan({ collapsedSpanIds: current, spanId }))
            }}
            onToggleCriticalPath={() => {
              setShowCriticalPath((current) => !current)
            }}
            onZoomWindow={({ focusAt, nextScale }) => {
              setTimelineWindow((current) => zoomTimelineWindow({ focusAt, nextScale, timelineRange, window: current }))
            }}
          />

          <TimelineLegend
            hoveredSpan={hoveredSpan}
            selectedSpan={stableSelectedSpan}
            showCriticalPath={showCriticalPath}
          />
        </section>

        <section className="rounded bg-white shadow-elevation-3 border border-elevation-4">
          <div className="border-b border-elevation-4 px-5 py-4">
            <div className="text-sm font-semibold text-primary">Span list</div>
            <p className="mt-1 text-sm text-secondary">
              Child spans, service names, start times, and durations mirror the data shown in Better Stack&apos;s summary tab.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full font-medium">
              <thead className="text-tertiary">
                <tr>
                  <td className="px-[18px] py-[14px] leading-none">Span</td>
                  <td className="px-[18px] py-[14px] leading-none">Service</td>
                  <td className="px-[18px] py-[14px] leading-none text-right">Start time</td>
                  <td className="px-[18px] py-[14px] leading-none text-right">Duration</td>
                </tr>
              </thead>
              <tbody>
                {flattened.map((span) => {
                  const isActive = span.id === stableSelectedSpan.id
                  return (
                    <tr
                      key={span.id}
                      className={isActive ? 'bg-elevation-3' : 'hover:bg-elevation-2'}
                    >
                      <td className="px-[18px] py-[14px] max-w-[360px] truncate leading-none whitespace-nowrap border-t border-elevation-4">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedSpanId(span.id)
                          }}
                          className="flex items-center gap-3 text-left"
                        >
                          <span className="text-tertiary" style={{ width: span.depth * 16 }} />
                          <KindBadge kind={span.kind} />
                          <span className="truncate text-primary">{span.title}</span>
                        </button>
                      </td>
                      <td className="px-[18px] py-[14px] max-w-[220px] truncate leading-none whitespace-nowrap border-t border-elevation-4 text-secondary">
                        {span.service}
                      </td>
                      <td className="px-[18px] py-[14px] border-t border-elevation-4 text-right tabular-nums text-secondary">
                        {span.startLabel}
                      </td>
                      <td className="px-[18px] py-[14px] border-t border-elevation-4 text-right tabular-nums text-primary">
                        {span.durationLabel}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <aside className="min-w-0">
        <SpanPanel
          activeTab={activeTab}
          selectedSpan={stableSelectedSpan}
          trace={selectedTrace}
          onSelectTab={({ tab }) => {
            setActiveTab(tab)
          }}
          onSelectSpan={({ spanId }) => {
            setSelectedSpanId(spanId)
          }}
        />
      </aside>
    </div>
  )
}

function TraceMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-elevation-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.18em] text-tertiary">{label}</div>
      <div className="mt-1 truncate text-primary">{value}</div>
    </div>
  )
}

function StatusPill({ status }: { status: TraceExample['status'] }) {
  const className = status === 'healthy' ? 'bg-emerald-500/12 text-emerald-700 border-emerald-500/25' : 'bg-amber-500/12 text-amber-700 border-amber-500/25'
  return <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${className}`}>{status}</span>
}

function TraceHighlightCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-5 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-tertiary">{label}</div>
      <div className="mt-2 truncate text-sm font-semibold text-primary">{value}</div>
    </div>
  )
}

function MetricCard({ metric }: { metric: TraceMetric }) {
  return (
    <div className="bg-white px-5 py-4">
      <div className="flex items-center gap-2 text-sm font-medium text-secondary">
        <span>{metric.label}</span>
        <span className="inline-flex size-4 items-center justify-center rounded-full border border-elevation-5 text-[10px] text-tertiary">i</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-primary">{metric.value}</div>
      <SparkBars series={metric.series} />
      <p className="mt-3 text-xs leading-5 text-tertiary">{metric.tooltip}</p>
    </div>
  )
}

function SparkBars({ series }: { series: number[] }) {
  const max = Math.max(...series, 1)

  return (
    <div className="mt-4 flex h-14 items-end gap-1.5">
      {series.map((value, index) => {
        const height = Math.max(6, (value / max) * 100)
        return (
          <div key={`${value}-${index}`} className="flex grow items-end">
            <div
              className="w-full rounded-t bg-[linear-gradient(180deg,rgba(111,128,255,0.52)_0%,rgba(111,128,255,0.08)_100%)] border border-[rgba(111,128,255,0.18)]"
              style={{ height: `${height}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}

function TraceTimeline({
  allSpans,
  collapsedSpanIds,
  criticalPathSpanIds,
  hoveredSpanId,
  spans,
  range,
  selectedSpanId,
  showCriticalPath,
  timelineWindow,
  onFitSelected,
  onHoverSpan,
  onPanWindow,
  onResetWindow,
  onSelectSpan,
  onSetTimelineWindow,
  onToggleCollapse,
  onToggleCriticalPath,
  onZoomWindow,
}: {
  allSpans: SpanNode[]
  collapsedSpanIds: string[]
  criticalPathSpanIds: string[]
  hoveredSpanId: string | null
  spans: SpanNode[]
  range: { start: number; end: number; total: number }
  selectedSpanId: string
  showCriticalPath: boolean
  timelineWindow: TimelineWindow
  onFitSelected: () => void
  onHoverSpan: ({ spanId }: { spanId: string | null }) => void
  onPanWindow: ({ direction }: { direction: -1 | 1 }) => void
  onResetWindow: () => void
  onSelectSpan: ({ spanId }: { spanId: string }) => void
  onSetTimelineWindow: ({ nextWindow }: { nextWindow: TimelineWindow }) => void
  onToggleCollapse: ({ spanId }: { spanId: string }) => void
  onToggleCriticalPath: () => void
  onZoomWindow: ({ focusAt, nextScale }: { focusAt: number; nextScale: number }) => void
}) {
  const ticks = Array.from({ length: 9 }, (_, index) => {
    return Math.round(timelineWindow.start + ((timelineWindow.end - timelineWindow.start) / 8) * index)
  })
  const maxDepth = Math.max(...spans.map((span) => span.depth), 0)
  const concurrency = calculateMaxConcurrency({ spans })
  const minimapSpans = allSpans

  return (
    <div className="rounded-t overflow-hidden bg-neutral-40 font-mono text-xs md:text-sm dark:bg-neutral-600">
      <div className="grid gap-px border-b border-neutral-60 bg-white/60 px-6 py-3 md:grid-cols-4 dark:border-neutral-600 dark:bg-white/5">
        <TimelineStat label="Total span range" value={formatTimelineTick({ value: range.total })} />
        <TimelineStat label="Parallel lanes" value={String(concurrency)} />
        <TimelineStat label="Nested levels" value={String(maxDepth + 1)} />
        <TimelineStat label="Rendered spans" value={String(spans.length)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-60 bg-white/65 px-6 py-3 dark:border-neutral-600 dark:bg-white/5">
        <TimelineControlButton label="Zoom in" onClick={() => onZoomWindow({ focusAt: timelineWindow.start + (timelineWindow.end - timelineWindow.start) / 2, nextScale: 0.7 })} />
        <TimelineControlButton label="Zoom out" onClick={() => onZoomWindow({ focusAt: timelineWindow.start + (timelineWindow.end - timelineWindow.start) / 2, nextScale: 1.35 })} />
        <TimelineControlButton label="Pan left" onClick={() => onPanWindow({ direction: -1 })} />
        <TimelineControlButton label="Pan right" onClick={() => onPanWindow({ direction: 1 })} />
        <TimelineControlButton label="Fit selected" onClick={onFitSelected} />
        <TimelineControlButton label="Reset view" onClick={onResetWindow} />
        <TimelineControlButton label={showCriticalPath ? 'Hide critical path' : 'Show critical path'} onClick={onToggleCriticalPath} />
        <div className="ml-auto text-xs text-secondary">
          wheel = zoom, `[`/`]` = pan, `c` = collapse, `f` = fit selected
        </div>
      </div>
      <TimelineMinimap
        collapsedSpanIds={collapsedSpanIds}
        range={range}
        spans={minimapSpans}
        timelineWindow={timelineWindow}
        onSetTimelineWindow={onSetTimelineWindow}
      />
      <div className="relative h-9 border-b border-neutral-60 dark:border-neutral-600">
        <div className="relative z-10 h-full flex items-center">
          <div className="grid grow grid-cols-[220px_minmax(0,1fr)] gap-4 px-6">
            <div className="flex items-center text-[11px] uppercase tracking-[0.18em] text-tertiary">Span lane</div>
            <div className="flex justify-between items-center whitespace-nowrap font-sans">
            {ticks.map((tick) => {
              return (
                <div key={tick} className="w-[1px] flex justify-center text-secondary">
                  {formatTimelineTick({ value: tick })}
                </div>
              )
            })}
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-20 px-6 pb-7 pt-4">
        {spans.map((span) => {
          const clipped = getClippedTimelineSpan({ span, timelineWindow })
          if (!clipped) {
            return null
          }

          const left = ((clipped.start - timelineWindow.start) / Math.max(1, timelineWindow.end - timelineWindow.start)) * 100
          const width = Math.max(1.2, (clipped.duration / Math.max(1, timelineWindow.end - timelineWindow.start)) * 100)
          const outside = width < 14
          const selected = span.id === selectedSpanId
          const hovered = span.id === hoveredSpanId
          const collapsed = collapsedSpanIds.includes(span.id)
          const onCriticalPath = criticalPathSpanIds.includes(span.id)
          const lineColor = span.status === 'error' ? 'bg-[rgba(239,68,68,0.75)]' : 'bg-[rgba(70,96,255,0.75)]'

          return (
            <div key={span.id} className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 border-b border-white/40 py-2 last:border-b-0 dark:border-white/8">
              <button
                type="button"
                onClick={() => {
                  onSelectSpan({ spanId: span.id })
                }}
                className={[
                  'flex min-w-0 items-center gap-3 rounded px-2 py-2 text-left transition',
                  selected ? 'bg-white/70 dark:bg-white/10' : 'hover:bg-white/45 dark:hover:bg-white/8',
                ].join(' ')}
                onMouseEnter={() => {
                  onHoverSpan({ spanId: span.id })
                }}
                onMouseLeave={() => {
                  onHoverSpan({ spanId: null })
                }}
              >
                <span className="block h-full w-px bg-neutral-60" style={{ marginLeft: `${span.depth * 14}px` }} />
                {span.children.length > 0 ? (
                  <span
                    className="inline-flex size-5 items-center justify-center rounded border border-elevation-5 bg-white/60 text-[10px] text-secondary"
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleCollapse({ spanId: span.id })
                    }}
                  >
                    {collapsed ? '+' : '-'}
                  </span>
                ) : null}
                <span className="inline-flex rounded-full border border-elevation-5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-secondary">
                  {span.kind}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-primary">{span.title}</div>
                  <div className="mt-1 truncate text-xs text-secondary">
                    {span.service} · {span.startLabel} · {span.durationLabel}
                  </div>
                </div>
              </button>

              <div className="relative h-12">
                <div className="absolute inset-0 flex justify-between pointer-events-none">
                  {ticks.slice(0, -1).map((tick) => {
                    return <div key={`grid-${span.id}-${tick}`} className="w-px border-l border-dashed border-neutral-60/90 dark:border-neutral-600" />
                  })}
                  <div className="w-px border-l border-dashed border-neutral-60/90 dark:border-neutral-600" />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onSelectSpan({ spanId: span.id })
                  }}
                  onMouseEnter={() => {
                    onHoverSpan({ spanId: span.id })
                  }}
                  onMouseLeave={() => {
                    onHoverSpan({ spanId: null })
                  }}
                  onWheel={(event) => {
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    const offset = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
                    const focusAt = timelineWindow.start + (timelineWindow.end - timelineWindow.start) * offset
                    onZoomWindow({
                      focusAt,
                      nextScale: event.deltaY > 0 ? 1.18 : 0.84,
                    })
                  }}
                  className={[
                    'pointer-events-auto absolute top-1/2 flex h-[24px] -translate-y-1/2 items-center justify-start whitespace-nowrap border shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]',
                    selected ? 'border-black dark:border-white' : 'border-white/25',
                    hovered ? 'ring-2 ring-white/70' : '',
                    lineColor,
                    showCriticalPath && onCriticalPath ? 'outline outline-2 outline-[rgba(250,204,21,0.95)]' : '',
                  ].join(' ')}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    borderRadius: '4px',
                  }}
                >
                  <div className="pl-[3px]">
                    <div
                      className={[
                        'font-sans font-medium text-[11px]',
                        outside ? 'text-primary' : 'px-[2px] h-[14px] rounded-[2px] flex items-center border border-white/30 bg-white/20 text-white',
                      ].join(' ')}
                    >
                      {span.durationLabel}
                    </div>
                  </div>
                  <div className={`pl-2 text-[12px] ${outside ? 'text-primary' : 'text-white'}`}>{span.title}</div>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TimelineControlButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick()
      }}
      className="inline-flex items-center rounded-full border border-elevation-5 bg-white/70 px-3 py-1 text-xs font-medium text-secondary transition hover:bg-white"
    >
      {label}
    </button>
  )
}

function TimelineMinimap({
  collapsedSpanIds,
  range,
  spans,
  timelineWindow,
  onSetTimelineWindow,
}: {
  collapsedSpanIds: string[]
  range: { start: number; end: number; total: number }
  spans: SpanNode[]
  timelineWindow: TimelineWindow
  onSetTimelineWindow: ({ nextWindow }: { nextWindow: TimelineWindow }) => void
}) {
  const [brushAnchor, setBrushAnchor] = useState<number | null>(null)

  return (
    <div className="border-b border-neutral-60 bg-white/55 px-6 py-4 dark:border-neutral-600 dark:bg-white/5">
      <div className="mb-2 flex items-center justify-between gap-4 text-[11px] uppercase tracking-[0.18em] text-tertiary">
        <span>Overview brush</span>
        <span>{collapsedSpanIds.length} collapsed lanes</span>
      </div>
      <div
        className="relative h-20 overflow-hidden rounded border border-elevation-5 bg-[linear-gradient(180deg,rgba(255,255,255,0.55)_0%,rgba(255,255,255,0.24)_100%)]"
        onMouseLeave={() => {
          setBrushAnchor(null)
        }}
        onMouseDown={(event) => {
          const nextPoint = getTimelinePointFromEvent({ event, element: event.currentTarget, range })
          setBrushAnchor(nextPoint)
        }}
        onMouseMove={(event) => {
          if (brushAnchor === null) {
            return
          }
          const nextPoint = getTimelinePointFromEvent({ event, element: event.currentTarget, range })
          onSetTimelineWindow({
            nextWindow: normalizeTimelineWindow({
              start: Math.min(brushAnchor, nextPoint),
              end: Math.max(brushAnchor, nextPoint),
              fallbackRange: range,
            }),
          })
        }}
        onMouseUp={(event) => {
          const nextPoint = getTimelinePointFromEvent({ event, element: event.currentTarget, range })
          onSetTimelineWindow({
            nextWindow: normalizeTimelineWindow({
              start: Math.min(brushAnchor ?? nextPoint, nextPoint),
              end: Math.max(brushAnchor ?? nextPoint, nextPoint),
              fallbackRange: range,
            }),
          })
          setBrushAnchor(null)
        }}
      >
        {spans.map((span, index) => {
          const left = ((span.startNs - range.start) / range.total) * 100
          const width = Math.max(0.8, (span.durationNs / range.total) * 100)
          const top = 8 + (index % 6) * 10
          return (
            <div
              key={`minimap-${span.id}`}
              className={`absolute h-2 rounded-full ${span.status === 'error' ? 'bg-[rgba(239,68,68,0.55)]' : 'bg-[rgba(70,96,255,0.52)]'}`}
              style={{ left: `${left}%`, top: `${top}px`, width: `${width}%` }}
            />
          )
        })}
        <div
          className="absolute inset-y-0 rounded border-2 border-[var(--brand-primary-200)] bg-[rgba(79,109,255,0.12)]"
          style={{
            left: `${((timelineWindow.start - range.start) / range.total) * 100}%`,
            width: `${((timelineWindow.end - timelineWindow.start) / range.total) * 100}%`,
          }}
        />
      </div>
      <p className="mt-2 text-xs text-secondary">Drag inside the minimap to brush a new visible window for the timeline.</p>
    </div>
  )
}

function TimelineLegend({
  hoveredSpan,
  selectedSpan,
  showCriticalPath,
}: {
  hoveredSpan: SpanNode | null
  selectedSpan: SpanNode
  showCriticalPath: boolean
}) {
  const activeSpan = hoveredSpan ?? selectedSpan

  return (
    <div className="grid gap-px border-t border-elevation-4 bg-[var(--elevation-5)] md:grid-cols-[minmax(0,1fr)_260px]">
      <div className="bg-white px-5 py-4">
        <div className="text-[11px] uppercase tracking-[0.18em] text-tertiary">Timeline inspector</div>
        <div className="mt-2 text-sm font-semibold text-primary">{activeSpan.title}</div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-secondary">
          <span className="inline-flex rounded-full border border-elevation-5 px-2 py-1">{activeSpan.service}</span>
          <span className="inline-flex rounded-full border border-elevation-5 px-2 py-1">{activeSpan.startLabel}</span>
          <span className="inline-flex rounded-full border border-elevation-5 px-2 py-1">{activeSpan.durationLabel}</span>
          <span className="inline-flex rounded-full border border-elevation-5 px-2 py-1">{activeSpan.status}</span>
        </div>
        <p className="mt-3 text-sm leading-6 text-secondary">{activeSpan.summary}</p>
      </div>
      <div className="bg-white px-5 py-4">
        <div className="text-[11px] uppercase tracking-[0.18em] text-tertiary">Legend</div>
        <div className="mt-3 flex flex-col gap-2 text-sm text-secondary">
          <div className="flex items-center gap-2"><span className="block h-3 w-8 rounded bg-[rgba(70,96,255,0.75)]" />Successful span</div>
          <div className="flex items-center gap-2"><span className="block h-3 w-8 rounded bg-[rgba(239,68,68,0.75)]" />Failed span</div>
          <div className="flex items-center gap-2"><span className="block h-3 w-8 rounded border-2 border-[rgba(250,204,21,0.95)] bg-[rgba(70,96,255,0.75)]" />Critical path {showCriticalPath ? 'visible' : 'hidden'}</div>
        </div>
      </div>
    </div>
  )
}

function TimelinePlaybook({ demos, onSelectDemo }: { demos: TraceDemo[]; onSelectDemo: ({ demo }: { demo: TraceDemo }) => void }) {
  return (
    <div className="grid gap-px border-b border-elevation-4 bg-[var(--elevation-5)] md:grid-cols-2 xl:grid-cols-4">
      {demos.map((demo) => {
        return (
          <button
            key={demo.id}
            type="button"
            onClick={() => {
              onSelectDemo({ demo })
            }}
            className="bg-white px-5 py-4 text-left transition hover:bg-[rgba(79,109,255,0.04)]"
          >
            <div className="text-sm font-semibold text-primary">{demo.title}</div>
            <p className="mt-2 text-sm leading-6 text-secondary">{demo.description}</p>
          </button>
        )
      })}
    </div>
  )
}

function TimelineStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.18em] text-tertiary">{label}</div>
      <div className="mt-1 text-sm font-semibold text-primary">{value}</div>
    </div>
  )
}

function SpanPanel({
  activeTab,
  selectedSpan,
  trace,
  onSelectTab,
  onSelectSpan,
}: {
  activeTab: TabKey
  selectedSpan: SpanNode
  trace: TraceExample
  onSelectTab: ({ tab }: { tab: TabKey }) => void
  onSelectSpan: ({ spanId }: { spanId: string }) => void
}) {
  const relatedCount = selectedSpan.logs.length
  const [selectedItemId, setSelectedItemId] = useState(selectedSpan.logs[0]?.id ?? '')

  useEffect(() => {
    setSelectedItemId(selectedSpan.logs[0]?.id ?? '')
  }, [selectedSpan])

  return (
    <section className="sticky top-6 flex max-h-[calc(100vh-48px)] min-h-[720px] min-w-0 flex-col rounded bg-white shadow-elevation-3 border border-elevation-4 supports-backdrop-filter:bg-white/80 backdrop-blur-md">
      <div className="flex items-center gap-1.5 border-b border-elevation-4 pl-5 pr-3 pt-3 pb-3">
        <h2 className="flex-1 min-w-0 text-base font-medium leading-4 text-primary truncate flex items-center gap-3">
          <div className="my-1.5">
            <span className="text-secondary">Span </span>
            {selectedSpan.id}
          </div>
        </h2>
        <span className="inline-flex rounded-full border border-elevation-5 px-2 py-1 text-[11px] text-secondary">
          {selectedSpan.kind}
        </span>
      </div>

      <div className="px-5 pb-2.5 pt-1 font-medium text-[13px] leading-4 text-secondary">{selectedSpan.startLabel}</div>

      <div className="relative shrink-0">
        <div className="h-px absolute left-0 right-0 bottom-0 border-b border-elevation-4 pointer-events-none" />
        <div className="flex gap-4 px-4 pt-1 overflow-x-auto hidden-scrollbar">
          <TabButton active={activeTab === 'summary'} title="Summary" onClick={() => onSelectTab({ tab: 'summary' })} />
          <TabButton active={activeTab === 'attributes'} title="Attributes" onClick={() => onSelectTab({ tab: 'attributes' })} />
          <TabButton active={activeTab === 'context'} title="Context" onClick={() => onSelectTab({ tab: 'context' })} />
          <TabButton
            active={activeTab === 'logs-events'}
            title="Logs & Events"
            badgeCount={relatedCount}
            onClick={() => onSelectTab({ tab: 'logs-events' })}
          />
        </div>
      </div>

      <div className="flex min-h-0 grow flex-col overflow-y-auto pretty-scrollbars px-4 py-5">
        {activeTab === 'summary' ? (
          <SummaryTabContent selectedSpan={selectedSpan} trace={trace} onSelectSpan={onSelectSpan} />
        ) : null}
        {activeTab === 'attributes' ? <AttributesTabContent selectedSpan={selectedSpan} /> : null}
        {activeTab === 'context' ? <ContextTabContent selectedSpan={selectedSpan} /> : null}
        {activeTab === 'logs-events' ? (
          <LogsEventsTabContent
            items={selectedSpan.logs}
            selectedItemId={selectedItemId}
            onSelectItem={({ itemId }) => {
              setSelectedItemId(itemId)
            }}
          />
        ) : null}
      </div>
    </section>
  )
}

function TabButton({
  active,
  title,
  badgeCount,
  onClick,
}: {
  active: boolean
  title: string
  badgeCount?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick()
      }}
      className={[
        'relative rounded-t px-1 py-3 text-[13px] font-medium leading-4 whitespace-nowrap flex items-center gap-1',
        active ? 'text-primary' : 'text-secondary',
      ].join(' ')}
    >
      {title}
      {badgeCount ? (
        <div className="px-1 min-w-3.5 h-3.5 shrink-0 bg-elevation-5 rounded-full text-[10px] font-medium flex justify-center items-center">
          {badgeCount > 9 ? '9+' : badgeCount}
        </div>
      ) : null}
      {active ? <span className="absolute left-0 right-0 bottom-0 h-[3px] bg-brand-primary-200 rounded-t pointer-events-none" /> : null}
    </button>
  )
}

function SummaryTabContent({
  selectedSpan,
  trace,
  onSelectSpan,
}: {
  selectedSpan: SpanNode
  trace: TraceExample
  onSelectSpan: ({ spanId }: { spanId: string }) => void
}) {
  const children = selectedSpan.children

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded bg-elevation-2 px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold text-primary">{selectedSpan.title}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-secondary">
              <span className="inline-flex rounded-full border border-elevation-5 px-3 py-1">{selectedSpan.service}</span>
              <span className="inline-flex rounded-full border border-elevation-5 px-3 py-1">{selectedSpan.durationLabel}</span>
              <span className="inline-flex rounded-full border border-elevation-5 px-3 py-1">{selectedSpan.kind}</span>
            </div>
          </div>
          <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${selectedSpan.status === 'ok' ? 'bg-emerald-500/12 text-emerald-700 border-emerald-500/25' : 'bg-rose-500/12 text-rose-700 border-rose-500/25'}`}>
            {selectedSpan.status}
          </span>
        </div>
        <p className="mt-4 text-sm leading-6 text-secondary">{selectedSpan.summary}</p>
      </div>

      <div>
        <div className="mb-3 text-sm font-semibold text-primary">Trace preview</div>
        <div className="rounded overflow-hidden bg-neutral-40 dark:bg-neutral-600 font-mono text-xs md:text-sm">
          <div className="relative h-9 border-b border-neutral-60 dark:border-neutral-600" />
          <div className="px-6 pb-6 pt-3">
            {trace.spans.map((span) => {
              const active = span.id === selectedSpan.id
              return (
                <button
                  key={span.id}
                  type="button"
                  onClick={() => {
                    onSelectSpan({ spanId: span.id })
                  }}
                  className={`mt-3 flex h-8 w-full items-center justify-between rounded border px-3 text-left ${active ? 'border-black bg-white/70' : 'border-white/25 bg-white/35 hover:bg-white/60'}`}
                >
                  <span className="truncate text-primary">{span.title}</span>
                  <span className="ml-4 shrink-0 text-secondary">{span.durationLabel}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-3 text-sm font-semibold text-primary">Resource details</div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 rounded border border-elevation-4 bg-elevation-2 px-4 py-4 text-sm">
          <dt className="text-primary">Service</dt>
          <dd className="text-secondary">{selectedSpan.service}</dd>
          <dt className="text-primary">Namespace</dt>
          <dd className="text-secondary">{selectedSpan.namespace ?? '—'}</dd>
          <dt className="text-primary">Pod</dt>
          <dd className="text-secondary">{selectedSpan.pod ?? '—'}</dd>
          <dt className="text-primary">Container</dt>
          <dd className="text-secondary">{selectedSpan.container ?? '—'}</dd>
          <dt className="text-primary">Runtime</dt>
          <dd className="text-secondary">{selectedSpan.runtime ?? '—'}</dd>
          <dt className="text-primary">Host</dt>
          <dd className="text-secondary">{selectedSpan.host ?? '—'}</dd>
          <dt className="text-primary">Destination</dt>
          <dd className="text-secondary">{selectedSpan.destination ?? '—'}</dd>
        </dl>
      </div>

      <div>
        <div className="mb-3 text-sm font-semibold text-primary">Span metrics</div>
        <div className="grid gap-3 md:grid-cols-3">
          <MiniMetricCard label="Duration" value={selectedSpan.durationLabel} />
          <MiniMetricCard label="Child spans" value={String(children.length)} />
          <MiniMetricCard label="Log items" value={String(selectedSpan.logs.length)} />
        </div>
      </div>

      {children.length > 0 ? (
        <div>
          <div className="mb-3 text-sm font-semibold text-primary">Child spans</div>
          <div className="overflow-hidden rounded border border-elevation-4">
            <table className="w-full font-medium">
              <thead className="text-tertiary bg-elevation-2">
                <tr>
                  <td className="px-[18px] py-[14px] leading-none">Span</td>
                  <td className="px-[18px] py-[14px] leading-none">Service</td>
                  <td className="px-[18px] py-[14px] leading-none text-right">Start time</td>
                  <td className="px-[18px] py-[14px] leading-none text-right">Duration</td>
                </tr>
              </thead>
              <tbody>
                {children.map((child) => {
                  return (
                    <tr key={child.id} className="hover:bg-elevation-2">
                      <td className="px-[18px] py-[14px] max-w-[280px] truncate leading-none whitespace-nowrap border-t border-elevation-4">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectSpan({ spanId: child.id })
                          }}
                          className="truncate text-left text-primary"
                        >
                          {child.title}
                        </button>
                      </td>
                      <td className="px-[18px] py-[14px] border-t border-elevation-4 text-secondary">{child.service}</td>
                      <td className="px-[18px] py-[14px] border-t border-elevation-4 text-right tabular-nums text-secondary">{child.startLabel}</td>
                      <td className="px-[18px] py-[14px] border-t border-elevation-4 text-right tabular-nums text-primary">{child.durationLabel}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function MiniMetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-elevation-4 bg-elevation-2 px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-tertiary">{label}</div>
      <div className="mt-2 text-lg font-semibold text-primary">{value}</div>
    </div>
  )
}

function AttributesTabContent({ selectedSpan }: { selectedSpan: SpanNode }) {
  return <JsonBlock value={selectedSpan.attributes} />
}

function ContextTabContent({ selectedSpan }: { selectedSpan: SpanNode }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-3 rounded border border-elevation-4 bg-elevation-2 px-4 py-4 text-sm">
      <dt className="text-primary">Trace id</dt>
      <dd className="text-secondary break-all">{selectedSpan.attributes['http.route'] ? String(selectedSpan.attributes['http.route']) : '—'}</dd>
      <dt className="text-primary">Span id</dt>
      <dd className="text-secondary break-all">{selectedSpan.id}</dd>
      <dt className="text-primary">Service</dt>
      <dd className="text-secondary">{selectedSpan.service}</dd>
      <dt className="text-primary">Host</dt>
      <dd className="text-secondary">{selectedSpan.host ?? '—'}</dd>
      <dt className="text-primary">Runtime</dt>
      <dd className="text-secondary">{selectedSpan.runtime ?? '—'}</dd>
      <dt className="text-primary">Destination</dt>
      <dd className="text-secondary">{selectedSpan.destination ?? '—'}</dd>
      <dt className="text-primary">Summary</dt>
      <dd className="text-secondary leading-6">{selectedSpan.summary}</dd>
    </dl>
  )
}

function LogsEventsTabContent({
  items,
  selectedItemId,
  onSelectItem,
}: {
  items: TraceLogItem[]
  selectedItemId: string
  onSelectItem: ({ itemId }: { itemId: string }) => void
}) {
  const rows = [...items].sort((a, b) => {
    return a.timestamp.localeCompare(b.timestamp)
  })
  const selectedItem = rows.find((item) => item.id === selectedItemId) ?? rows[0] ?? null

  return (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="overflow-hidden rounded border border-elevation-4">
        {rows.map((item) => {
          const selected = item.id === selectedItem?.id
          return item.type === 'event' ? (
            <EventItemCard
              key={item.id}
              item={item}
              selected={selected}
              onClick={() => {
                onSelectItem({ itemId: item.id })
              }}
            />
          ) : (
            <LogItemCard
              key={item.id}
              item={item}
              selected={selected}
              onClick={() => {
                onSelectItem({ itemId: item.id })
              }}
            />
          )
        })}
      </div>

      <div className="flex min-h-[360px] flex-col rounded border border-elevation-4 bg-elevation-2">
        <div className="border-b border-elevation-4 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-tertiary">Selected item</div>
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex rounded-full border border-elevation-5 px-2 py-1 text-[11px] font-medium text-secondary">
              {selectedItem?.badge ?? 'Item'}
            </span>
            <span className="truncate text-sm font-semibold text-primary">{selectedItem?.timestamp ?? '—'}</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-secondary">{selectedItem?.message ?? 'Select a log or event to inspect its details.'}</p>
        </div>
        <div className="min-h-0 grow px-4 py-4">
          <JsonBlock value={selectedItem?.details ?? { message: selectedItem?.message ?? null }} compactHeader title="Details" />
        </div>
      </div>
    </div>
  )
}

function EventItemCard({
  item,
  selected,
  onClick,
}: {
  item: TraceLogItem
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick()
      }}
      className={[
        'flex w-full flex-col border-b border-elevation-4 px-4 py-3 text-left font-mono text-sm leading-6 last:border-b-0 hover:bg-elevation-2',
        selected ? 'bg-[rgba(79,109,255,0.08)]' : '',
      ].join(' ')}
    >
      <span className="flex items-center justify-between font-medium">
        <span>{item.timestamp}</span>
        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-elevation-5 px-2 py-0.5 font-sans text-sm text-secondary leading-4">
          {item.badge}
        </span>
      </span>
      <span className="mt-2">
        {item.tags?.map((tag) => {
          return (
            <span key={tag} className="mr-2 rounded-xs bg-elevation-4 px-1">
              {tag}
            </span>
          )
        })}
        <span className="whitespace-pre-wrap break-all text-primary">{item.message}</span>
      </span>
    </button>
  )
}

function LogItemCard({
  item,
  selected,
  onClick,
}: {
  item: TraceLogItem
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick()
      }}
      className={[
        'flex w-full flex-col border-b border-elevation-4 px-4 py-3 text-left font-mono text-sm leading-6 last:border-b-0 hover:bg-elevation-2',
        selected ? 'bg-[rgba(79,109,255,0.08)]' : '',
      ].join(' ')}
    >
      <span className="flex items-center justify-between font-medium">
        <span>{item.timestamp}</span>
        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-elevation-5 px-2 py-0.5 font-sans text-sm text-secondary leading-4">
          {item.badge}
        </span>
      </span>
      <span className="mt-2 line-clamp-4">
        {item.level ? <LevelBadge level={item.level} /> : null}
        {item.service ? <span className="mr-2 inline-flex rounded-full border border-elevation-5 px-2 py-0.5 font-sans text-xs text-secondary">{item.service}</span> : null}
        <span className="whitespace-pre-wrap break-words text-primary">{item.message}</span>
      </span>
    </button>
  )
}

function LevelBadge({ level }: { level: NonNullable<TraceLogItem['level']> }) {
  const classes = {
    info: 'bg-sky-500/12 text-sky-700 border-sky-500/25',
    warn: 'bg-amber-500/12 text-amber-700 border-amber-500/25',
    error: 'bg-rose-500/12 text-rose-700 border-rose-500/25',
  }

  return <span className={`mr-2 inline-flex rounded-full border px-2 py-0.5 font-sans text-xs ${classes[level]}`}>{level}</span>
}

function KindBadge({ kind }: { kind: TraceSpan['kind'] }) {
  return <span className="inline-flex rounded-full border border-elevation-5 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.14em] text-secondary">{kind}</span>
}

function JsonBlock({
  value,
  title = 'JSON',
  compactHeader = false,
}: {
  value: Record<string, unknown>
  title?: string
  compactHeader?: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded border border-elevation-4 bg-elevation-2">
      <div className={`flex items-center gap-2 border-b border-elevation-4 px-4 ${compactHeader ? 'py-2.5' : 'py-3'}`}>
        <span className={`${compactHeader ? 'text-sm' : 'text-base'} font-medium text-primary`}>{title}</span>
      </div>
      <div className="pretty-scrollbars min-h-0 grow overflow-auto px-4 py-4 font-mono text-[13px] leading-6 text-primary">
        <JsonNode nodeKey="root" value={value} depth={0} defaultExpanded />
      </div>
    </div>
  )
}

function JsonNode({
  nodeKey,
  value,
  depth,
  defaultExpanded = false,
}: {
  nodeKey: string
  value: unknown
  depth: number
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const entries = getJsonEntries({ value })
  const expandable = entries.length > 0

  if (!expandable) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-0.5" style={{ paddingLeft: depth * 16 }}>
        <span className="text-tertiary">{nodeKey}</span>
        <span className="break-all text-primary">{formatJsonPrimitive({ value })}</span>
      </div>
    )
  }

  return (
    <div style={{ paddingLeft: depth * 16 }}>
      <button
        type="button"
        onClick={() => {
          setExpanded(!expanded)
        }}
        className="flex items-center gap-2 py-0.5 text-left"
      >
        <span className={`text-xs text-secondary transition ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span className="text-tertiary">{nodeKey}</span>
        <span className="text-secondary">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {expanded ? (
        <div className="mt-1 flex flex-col gap-1">
          {entries.map(([entryKey, entryValue]) => {
            return (
              <JsonNode
                key={`${nodeKey}-${entryKey}`}
                nodeKey={entryKey}
                value={entryValue}
                depth={depth + 1}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function getJsonEntries({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => [String(index), entry] as const)
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
  }

  return []
}

function formatJsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return `"${value}"`
  }

  if (value === null) {
    return 'null'
  }

  if (typeof value === 'undefined') {
    return 'undefined'
  }

  return String(value)
}

function buildTraceTree({ spans }: { spans: TraceSpan[] }) {
  const nodes = new Map<string, SpanNode>()

  spans.forEach((span) => {
    nodes.set(span.id, {
      ...span,
      depth: 0,
      children: [],
    })
  })

  const roots: SpanNode[] = []

  nodes.forEach((node) => {
    if (!node.parentId) {
      roots.push(node)
      return
    }

    const parent = nodes.get(node.parentId)
    if (!parent) {
      roots.push(node)
      return
    }

    node.depth = parent.depth + 1
    parent.children.push(node)
  })

  return roots
}

function flattenTree({ nodes }: { nodes: SpanNode[] }) {
  const flattened: SpanNode[] = []

  const visit = ({ node }: { node: SpanNode }) => {
    flattened.push(node)
    node.children.forEach((child) => {
      visit({ node: child })
    })
  }

  nodes.forEach((node) => {
    visit({ node })
  })

  return flattened.sort((left, right) => {
    return left.startNs - right.startNs
  })
}

function flattenVisibleTree({
  nodes,
  collapsedSpanIds,
}: {
  nodes: SpanNode[]
  collapsedSpanIds: string[]
}) {
  const collapsed = new Set(collapsedSpanIds)
  const flattened: SpanNode[] = []

  const visit = ({ node }: { node: SpanNode }) => {
    flattened.push(node)
    if (collapsed.has(node.id)) {
      return
    }
    node.children.forEach((child) => {
      visit({ node: child })
    })
  }

  nodes.forEach((node) => {
    visit({ node })
  })

  return flattened.sort((left, right) => {
    return left.startNs - right.startNs
  })
}

function formatTimelineTick({ value }: { value: number }) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}s`
  }

  return `${value}ms`
}

function calculateMaxConcurrency({ spans }: { spans: SpanNode[] }) {
  const markers = spans.flatMap((span) => {
    return [
      { at: span.startNs, delta: 1 },
      { at: span.startNs + span.durationNs, delta: -1 },
    ]
  })

  const sorted = markers.sort((left, right) => {
    if (left.at === right.at) {
      return right.delta - left.delta
    }
    return left.at - right.at
  })

  let current = 0
  let max = 0

  sorted.forEach((marker) => {
    current += marker.delta
    if (current > max) {
      max = current
    }
  })

  return max
}

function clampTimelineWindow({
  timelineRange,
  window,
}: {
  timelineRange: { start: number; end: number; total: number }
  window: TimelineWindow | null
}) {
  if (!window) {
    return {
      start: timelineRange.start,
      end: timelineRange.end,
    }
  }

  return normalizeTimelineWindow({
    start: window.start,
    end: window.end,
    fallbackRange: timelineRange,
  })
}

function normalizeTimelineWindow({
  start,
  end,
  fallbackRange,
}: {
  start: number
  end: number
  fallbackRange: { start: number; end: number; total: number }
}) {
  const minWidth = Math.max(24, fallbackRange.total * 0.02)
  const nextStart = Math.max(fallbackRange.start, Math.min(start, end - minWidth))
  const nextEnd = Math.min(fallbackRange.end, Math.max(end, nextStart + minWidth))

  if (nextEnd - nextStart >= fallbackRange.total * 0.985) {
    return {
      start: fallbackRange.start,
      end: fallbackRange.end,
    }
  }

  return {
    start: nextStart,
    end: nextEnd,
  }
}

function zoomTimelineWindow({
  focusAt,
  nextScale,
  timelineRange,
  window,
}: {
  focusAt: number
  nextScale: number
  timelineRange: { start: number; end: number; total: number }
  window: TimelineWindow | null
}) {
  const currentWindow = clampTimelineWindow({ timelineRange, window })
  const currentWidth = currentWindow.end - currentWindow.start
  const nextWidth = Math.max(24, Math.min(timelineRange.total, currentWidth * nextScale))
  const ratio = (focusAt - currentWindow.start) / Math.max(1, currentWidth)
  const nextStart = focusAt - nextWidth * ratio
  const nextEnd = nextStart + nextWidth

  return normalizeTimelineWindow({
    start: nextStart,
    end: nextEnd,
    fallbackRange: timelineRange,
  })
}

function panTimelineWindow({
  direction,
  timelineRange,
  window,
}: {
  direction: -1 | 1
  timelineRange: { start: number; end: number; total: number }
  window: TimelineWindow | null
}) {
  const currentWindow = clampTimelineWindow({ timelineRange, window })
  const width = currentWindow.end - currentWindow.start
  const shift = width * 0.2 * direction

  return normalizeTimelineWindow({
    start: currentWindow.start + shift,
    end: currentWindow.end + shift,
    fallbackRange: timelineRange,
  })
}

function focusTimelineWindowOnSpan({
  span,
  timelineRange,
}: {
  span: { startNs: number; durationNs: number }
  timelineRange: { start: number; end: number; total: number }
}) {
  const padding = Math.max(span.durationNs * 0.45, timelineRange.total * 0.03)
  return normalizeTimelineWindow({
    start: span.startNs - padding,
    end: span.startNs + span.durationNs + padding,
    fallbackRange: timelineRange,
  })
}

function toggleCollapsedSpan({
  collapsedSpanIds,
  spanId,
}: {
  collapsedSpanIds: string[]
  spanId: string
}) {
  if (collapsedSpanIds.includes(spanId)) {
    return collapsedSpanIds.filter((id) => id !== spanId)
  }

  return [...collapsedSpanIds, spanId]
}

function getAncestorIds({ nodes, spanId }: { nodes: SpanNode[]; spanId: string }) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ancestors: string[] = []
  let current = byId.get(spanId)
  while (current?.parentId) {
    ancestors.push(current.parentId)
    current = byId.get(current.parentId)
  }
  return ancestors
}

function getCriticalPathSpanIds({ nodes }: { nodes: SpanNode[] }) {
  const ids: string[] = []

  const walk = ({ node }: { node: SpanNode | undefined }) => {
    if (!node) {
      return
    }

    ids.push(node.id)
    if (node.children.length === 0) {
      return
    }

    const nextNode = [...node.children].sort((left, right) => {
      return right.startNs + right.durationNs - (left.startNs + left.durationNs)
    })[0]

    walk({ node: nextNode })
  }

  const root = [...nodes].sort((left, right) => {
    return right.startNs + right.durationNs - (left.startNs + left.durationNs)
  })[0]

  walk({ node: root })
  return ids
}

function getClippedTimelineSpan({
  span,
  timelineWindow,
}: {
  span: SpanNode
  timelineWindow: TimelineWindow
}) {
  const clippedStart = Math.max(span.startNs, timelineWindow.start)
  const clippedEnd = Math.min(span.startNs + span.durationNs, timelineWindow.end)
  if (clippedEnd <= clippedStart) {
    return null
  }

  return {
    start: clippedStart,
    end: clippedEnd,
    duration: clippedEnd - clippedStart,
  }
}

function getTimelinePointFromEvent({
  event,
  element,
  range,
}: {
  event: React.MouseEvent<HTMLDivElement>
  element: HTMLDivElement
  range: { start: number; end: number; total: number }
}) {
  const rect = element.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
  return range.start + range.total * ratio
}

function readTraceHash() {
  if (typeof window === 'undefined') {
    return { traceId: null, spanId: null }
  }

  const raw = window.location.hash.replace(/^#/, '')
  const params = new URLSearchParams(raw)
  return {
    traceId: params.get('trace'),
    spanId: params.get('span'),
  }
}

function getTraceRange({ spans }: { spans: TraceSpan[] }) {
  const start = Math.min(...spans.map((span) => span.startNs))
  const end = Math.max(...spans.map((span) => span.startNs + span.durationNs))
  return {
    start,
    end,
    total: Math.max(1, end - start),
  }
}
