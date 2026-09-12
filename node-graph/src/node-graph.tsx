import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { GraphCanvas, NoiseOverlay, type PulseEvent } from './graph-canvas.tsx'
import {
  edgesFromTree,
  flattenTree,
  layoutHub,
  snapToGrid,
} from './layout.ts'
import type { GraphNode, GraphTree } from './types.ts'

const IDLE_SHADOW = '0 24px 24px -12px rgba(0, 0, 0, 0.25)'
const DRAG_SHADOW = '0 32px 40px -8px rgba(0, 0, 0, 0.55)'
const DRAG_TRANSITION =
  'transform 0.15s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.15s cubic-bezier(0.4, 0, 0.2, 1)'
const PHYSICS = {
  boundaryMargin: 8,
  maxVelocity: 40,
  baseFriction: 0.975,
  highSpeedFriction: 0.94,
  bounceDamping: 0.45,
  bounceFrictionBoost: 0.85,
  minVelocity: 0.15,
  momentumThreshold: 1.5,
  velocitySampleCount: 6,
  dragScale: 1.018,
}

export type NodeGraphProps = {
  tree: GraphTree
  className?: string
  style?: CSSProperties
}

type LiveNode = GraphNode & { zIndex: number }

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function NodeGraph({ tree, className, style }: NodeGraphProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const nodesRef = useRef<LiveNode[]>([])
  const dragRef = useRef<{
    id: string
    pointerId: number
    grabX: number
    grabY: number
    samples: Array<{ x: number; y: number; t: number }>
  } | null>(null)
  const momentumRef = useRef<number | null>(null)
  const zRef = useRef(10)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [nodes, setNodes] = useState<LiveNode[]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [pulses, setPulses] = useState<PulseEvent[]>([])
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null)

  const edges = useMemo(() => edgesFromTree(tree), [tree])
  nodesRef.current = nodes

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const applySize = () => {
      const rect = stage.getBoundingClientRect()
      setViewport({ width: rect.width, height: rect.height })
    }
    applySize()
    const observer = new ResizeObserver(applySize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (viewport.width === 0 || viewport.height === 0) return
    const laidOut = layoutHub({
      nodes: flattenTree(tree),
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    })
    setNodes((prev) => {
      const prevById = new Map(prev.map((node) => [node.id, node]))
      return laidOut.map((node, index) => {
        const existing = prevById.get(node.id)
        if (!existing) {
          return { ...node, zIndex: index + 1 }
        }
        return {
          ...node,
          x: existing.x,
          y: existing.y,
          zIndex: existing.zIndex,
        }
      })
    })
  }, [tree, viewport.height, viewport.width])

  const stopMomentum = useCallback(() => {
    if (momentumRef.current !== null) {
      cancelAnimationFrame(momentumRef.current)
      momentumRef.current = null
    }
  }, [])

  useEffect(() => () => stopMomentum(), [stopMomentum])

  const boundsFor = useCallback(
    (node: Pick<GraphNode, 'width' | 'height'>) => ({
      minX: PHYSICS.boundaryMargin,
      maxX: Math.max(PHYSICS.boundaryMargin, viewport.width - node.width - PHYSICS.boundaryMargin),
      minY: PHYSICS.boundaryMargin,
      maxY: Math.max(
        PHYSICS.boundaryMargin,
        viewport.height - node.height - PHYSICS.boundaryMargin,
      ),
    }),
    [viewport.height, viewport.width],
  )

  const emitBounce = useCallback((x: number, y: number, intensity: number) => {
    setPulses((prev) => {
      const now = performance.now()
      const recent = prev.filter((pulse) => now - pulse.time < 2000)
      return [...recent, { x, y, time: now, intensity }]
    })
  }, [])

  const animateMomentum = useCallback(
    (id: string, startX: number, startY: number, velX: number, velY: number) => {
      stopMomentum()
      const node = nodesRef.current.find((item) => item.id === id)
      if (!node) return
      const bounds = boundsFor(node)
      let x = startX
      let y = startY
      let vx = velX
      let vy = velY
      const justBounced = { x: false, y: false }

      const tick = () => {
        const speed = Math.hypot(vx, vy)
        const speedRatio = Math.min(speed / PHYSICS.maxVelocity, 1)
        const friction =
          PHYSICS.baseFriction -
          speedRatio * (PHYSICS.baseFriction - PHYSICS.highSpeedFriction)
        vx *= friction * (justBounced.x ? PHYSICS.bounceFrictionBoost : 1)
        vy *= friction * (justBounced.y ? PHYSICS.bounceFrictionBoost : 1)
        justBounced.x = false
        justBounced.y = false
        x += vx
        y += vy
        const impactForce = Math.min(Math.hypot(vx, vy) / PHYSICS.maxVelocity, 1)
        if (x < bounds.minX) {
          x = bounds.minX
          vx = Math.abs(vx) * PHYSICS.bounceDamping
          justBounced.x = true
          emitBounce(x, y + node.height / 2, impactForce)
        } else if (x > bounds.maxX) {
          x = bounds.maxX
          vx = -Math.abs(vx) * PHYSICS.bounceDamping
          justBounced.x = true
          emitBounce(x + node.width, y + node.height / 2, impactForce)
        }
        if (y < bounds.minY) {
          y = bounds.minY
          vy = Math.abs(vy) * PHYSICS.bounceDamping
          justBounced.y = true
          emitBounce(x + node.width / 2, y, impactForce)
        } else if (y > bounds.maxY) {
          y = bounds.maxY
          vy = -Math.abs(vy) * PHYSICS.bounceDamping
          justBounced.y = true
          emitBounce(x + node.width / 2, y + node.height, impactForce)
        }
        setNodes((prev) =>
          prev.map((item) => (item.id === id ? { ...item, x, y } : item)),
        )
        if (Math.hypot(vx, vy) > PHYSICS.minVelocity) {
          momentumRef.current = requestAnimationFrame(tick)
          return
        }
        momentumRef.current = null
      }
      momentumRef.current = requestAnimationFrame(tick)
    },
    [boundsFor, emitBounce, stopMomentum],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      stopMomentum()
      const node = nodesRef.current.find((item) => item.id === id)
      if (!node) return
      zRef.current += 1
      const zIndex = zRef.current
      setNodes((prev) => prev.map((item) => (item.id === id ? { ...item, zIndex } : item)))
      setDraggingId(id)
      dragRef.current = {
        id,
        pointerId: event.pointerId,
        grabX: event.clientX - node.x,
        grabY: event.clientY - node.y,
        samples: [{ x: node.x, y: node.y, t: performance.now() }],
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [stopMomentum],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const node = nodesRef.current.find((item) => item.id === drag.id)
      if (!node) return
      const bounds = boundsFor(node)
      let x = event.clientX - drag.grabX
      let y = event.clientY - drag.grabY
      if (event.shiftKey) {
        x = snapToGrid(x)
        y = snapToGrid(y)
      }
      x = clamp(x, bounds.minX, bounds.maxX)
      y = clamp(y, bounds.minY, bounds.maxY)
      drag.samples.push({ x, y, t: performance.now() })
      if (drag.samples.length > PHYSICS.velocitySampleCount) drag.samples.shift()
      setNodes((prev) =>
        prev.map((item) => (item.id === drag.id ? { ...item, x, y } : item)),
      )
    },
    [boundsFor],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      setDraggingId(null)
      const samples = drag.samples
      if (samples.length < 2) return
      const now = performance.now()
      let totalWeight = 0
      let velX = 0
      let velY = 0
      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1]
        const curr = samples[i]
        if (!prev || !curr) continue
        const dt = curr.t - prev.t
        const age = now - curr.t
        if (age > 80 || dt < 8 || dt >= 100) continue
        const weight = i / samples.length
        velX += ((curr.x - prev.x) / dt) * 16.67 * weight
        velY += ((curr.y - prev.y) / dt) * 16.67 * weight
        totalWeight += weight
      }
      if (totalWeight === 0) return
      velX /= totalWeight
      velY /= totalWeight
      const speed = Math.hypot(velX, velY)
      if (speed > PHYSICS.maxVelocity) {
        const ratio = PHYSICS.maxVelocity / speed
        velX *= ratio
        velY *= ratio
      }
      const last = samples[samples.length - 1]
      if (!last) return
      if (Math.hypot(velX, velY) > PHYSICS.momentumThreshold) {
        animateMomentum(drag.id, last.x, last.y, velX, velY)
      }
    },
    [animateMomentum],
  )

  return (
    <div
      ref={stageRef}
      className={className}
      data-testid="node-graph"
      onPointerMove={(event) => {
        const rect = stageRef.current?.getBoundingClientRect()
        if (!rect) return
        setMousePos({ x: event.clientX - rect.left, y: event.clientY - rect.top })
      }}
      onPointerLeave={() => setMousePos(null)}
      style={{
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: 'transparent',
        color: '#fff',
        minHeight: 480,
        userSelect: 'none',
        ...style,
      }}
    >
      <GraphCanvas
        width={viewport.width}
        height={viewport.height}
        nodes={nodes}
        edges={edges}
        pulses={pulses}
        mousePos={mousePos}
      />
      <NoiseOverlay />
      {nodes.map((node) => {
        const isDragging = draggingId === node.id
        return (
          <div
            key={node.id}
            data-testid={`node-${node.id}`}
            data-node-id={node.id}
            onPointerDown={(event) => onPointerDown(event, node.id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              position: 'absolute',
              left: node.x,
              top: node.y,
              width: node.width,
              height: node.height,
              zIndex: isDragging ? 2147483647 : node.zIndex,
              cursor: isDragging ? 'grabbing' : 'grab',
              touchAction: 'none',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                borderRadius: 12,
                backgroundColor: '#262626',
                border: `1px solid rgba(255, 255, 255, ${isDragging ? 0.16 : 0.1})`,
                boxShadow: isDragging ? DRAG_SHADOW : IDLE_SHADOW,
                transform: isDragging ? `scale(${PHYSICS.dragScale})` : 'scale(1)',
                transition: DRAG_TRANSITION,
                overflow: 'hidden',
              }}
            >
              {node.content}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export { DEFAULT_NODE_SIZE } from './layout.ts'
