import { useEffect, useRef, type CSSProperties } from 'react'
import { GRID_CELL_SIZE } from './layout.ts'
import type { GraphEdge, GraphNode } from './types.ts'

export const EDGE_FADE: CSSProperties = {
  WebkitMaskImage:
    'radial-gradient(ellipse 78% 72% at 50% 50%, #000 42%, rgba(0,0,0,0.4) 70%, transparent 100%)',
  maskImage:
    'radial-gradient(ellipse 78% 72% at 50% 50%, #000 42%, rgba(0,0,0,0.4) 70%, transparent 100%)',
}

export type PulseEvent = {
  x: number
  y: number
  time: number
  intensity: number
}

type Dot = {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  targetSize: number
}

type ParticleShape = 'circle' | 'triangle' | 'square'
type ParticleColor = 'cyan' | 'blue'

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  rotation: number
  rotationSpeed: number
  size: number
  opacity: number
  life: number
  maxLife: number
  shape: ParticleShape
  color?: ParticleColor
}

type GraphCanvasProps = {
  width: number
  height: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  pulses: PulseEvent[]
  mousePos: { x: number; y: number } | null
}

function randomShape(): ParticleShape {
  const shapes: ParticleShape[] = ['circle', 'triangle', 'square']
  return shapes[Math.floor(Math.random() * shapes.length)] ?? 'circle'
}

function drawRoundedTriangle(ctx: CanvasRenderingContext2D, size: number, radius: number) {
  const h = size * 0.866
  const points = [
    { x: 0, y: -size },
    { x: -h, y: size * 0.5 },
    { x: h, y: size * 0.5 },
  ]
  ctx.beginPath()
  for (let i = 0; i < 3; i++) {
    const curr = points[i]
    const next = points[(i + 1) % 3]
    const prev = points[(i + 2) % 3]
    if (!curr || !next || !prev) continue
    const dx1 = curr.x - prev.x
    const dy1 = curr.y - prev.y
    const dx2 = next.x - curr.x
    const dy2 = next.y - curr.y
    const len1 = Math.hypot(dx1, dy1)
    const len2 = Math.hypot(dx2, dy2)
    const offset = Math.min(radius, len1 / 2, len2 / 2)
    const p1x = curr.x - (dx1 / len1) * offset
    const p1y = curr.y - (dy1 / len1) * offset
    const p2x = curr.x + (dx2 / len2) * offset
    const p2y = curr.y + (dy2 / len2) * offset
    if (i === 0) ctx.moveTo(p1x, p1y)
    else ctx.lineTo(p1x, p1y)
    ctx.quadraticCurveTo(curr.x, curr.y, p2x, p2y)
  }
  ctx.closePath()
}

function drawRoundedSquare(ctx: CanvasRenderingContext2D, size: number, radius: number) {
  const half = size * 0.7
  const r = Math.min(radius, half)
  ctx.beginPath()
  ctx.moveTo(-half + r, -half)
  ctx.lineTo(half - r, -half)
  ctx.quadraticCurveTo(half, -half, half, -half + r)
  ctx.lineTo(half, half - r)
  ctx.quadraticCurveTo(half, half, half - r, half)
  ctx.lineTo(-half + r, half)
  ctx.quadraticCurveTo(-half, half, -half, half - r)
  ctx.lineTo(-half, -half + r)
  ctx.quadraticCurveTo(-half, -half, -half + r, -half)
  ctx.closePath()
}

function drawParticleShape(ctx: CanvasRenderingContext2D, p: Particle) {
  if (p.shape === 'circle') {
    ctx.beginPath()
    ctx.arc(0, 0, p.size * 0.6, 0, Math.PI * 2)
    ctx.closePath()
    return
  }
  if (p.shape === 'triangle') {
    drawRoundedTriangle(ctx, p.size, p.size * 0.3)
    return
  }
  drawRoundedSquare(ctx, p.size, p.size * 0.25)
}

export function GraphCanvas({
  width,
  height,
  nodes,
  edges,
  pulses,
  mousePos,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const pulsesRef = useRef(pulses)
  const mousePosRef = useRef(mousePos)
  const wakeRef = useRef<(() => void) | null>(null)
  nodesRef.current = nodes
  edgesRef.current = edges
  pulsesRef.current = pulses
  mousePosRef.current = mousePos

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width === 0 || height === 0) return
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!ctx) return

    const gridSize = GRID_CELL_SIZE
    const maxDist = 400
    const pushStrength = 25
    const springStiffness = 0.08
    const damping = 0.75
    const particleCount = 12
    const particleSpeed = 8
    const particleGravity = 0.15
    const particleFriction = 0.98
    const particleLifespan = 1200
    const bouncyParticleCount = 16
    const bouncyParticleSpeed = 6
    const bouncyParticleGravity = 0.12
    const bouncyParticleFriction = 0.99
    const bouncyParticleLifespan = 2500
    const bouncyBounceDamping = 0.7
    const bouncySurfaceFriction = 0.6


    const dots = new Map<string, Dot>()
    const particles: Particle[] = []
    const bouncyParticles: Particle[] = []
    const lastPanelPositions = new Map<string, { x: number; y: number }>()
    const panelVelocities = new Map<string, { vx: number; vy: number }>()
    let lastPulseTime = 0
    let lastTime = performance.now()
    let animationId = 0
    let lastPanelKey = ''
    let dotsSettled = false

    canvas.width = width
    canvas.height = height

    const initDots = () => {
      dots.clear()
      for (let gx = -gridSize; gx < width + gridSize * 2; gx += gridSize) {
        for (let gy = -gridSize; gy < height + gridSize * 2; gy += gridSize) {
          dots.set(`${gx},${gy}`, {
            x: gx,
            y: gy,
            vx: 0,
            vy: 0,
            size: 1,
            targetSize: 1,
          })
        }
      }
    }
    initDots()

    const spawnParticles = (x: number, y: number, intensity: number) => {
      const count = Math.floor(particleCount * (0.5 + intensity * 0.5))
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5
        const speed = particleSpeed * (0.5 + Math.random() * 0.5) * intensity
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          rotation: Math.random() * Math.PI * 2,
          rotationSpeed: (Math.random() - 0.5) * 0.3,
          size: 3 + Math.random() * 4 * intensity,
          opacity: 0.8 + Math.random() * 0.2,
          life: particleLifespan,
          maxLife: particleLifespan,
          shape: randomShape(),
        })
      }
    }

    const spawnBouncyParticles = (x: number, y: number, intensity: number) => {
      const count = Math.floor(bouncyParticleCount * (0.5 + intensity * 0.5))
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.8
        const speed = bouncyParticleSpeed * (0.7 + Math.random() * 0.6) * intensity
        const isBlue = Math.random() < 0.4
        bouncyParticles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          rotation: Math.random() * Math.PI * 2,
          rotationSpeed: (Math.random() - 0.5) * 0.2,
          size: isBlue
            ? 1 + Math.random() * 2 * intensity
            : 2 + Math.random() * 4 * intensity,
          opacity: 0.9,
          life: bouncyParticleLifespan,
          maxLife: bouncyParticleLifespan,
          shape: randomShape(),
          color: isBlue ? 'blue' : 'cyan',
        })
      }
    }

    const getPanelPush = (
      baseX: number,
      baseY: number,
      pLeft: number,
      pRight: number,
      pTop: number,
      pBottom: number,
    ) => {
      const closestX = Math.max(pLeft, Math.min(baseX, pRight))
      const closestY = Math.max(pTop, Math.min(baseY, pBottom))
      const dx = baseX - closestX
      const dy = baseY - closestY
      const dist = Math.hypot(dx, dy)
      const normalizedDist = Math.min(dist / maxDist, 1)
      const pushAmount = dist > 0 ? Math.pow(1 - normalizedDist, 2) * pushStrength : 0
      return {
        x: dist > 0 ? (dx / dist) * pushAmount : 0,
        y: dist > 0 ? (dy / dist) * pushAmount : 0,
      }
    }

    const getDisplacedPosition = (baseX: number, baseY: number, panels: GraphNode[]) => {
      let totalPushX = 0
      let totalPushY = 0
      for (const panel of panels) {
        const push = getPanelPush(
          baseX,
          baseY,
          panel.x,
          panel.x + panel.width,
          panel.y,
          panel.y + panel.height,
        )
        totalPushX += push.x
        totalPushY += push.y
      }
      return { x: baseX + totalPushX, y: baseY + totalPushY }
    }

    const getPulseIntensity = (x: number, y: number, now: number) => {
      let maxIntensity = 0
      const pulseSpeed = 400
      const pulseWidth = 80
      const pulseDuration = 2000
      for (const pulse of pulsesRef.current) {
        const age = now - pulse.time
        if (age > pulseDuration) continue
        const intensityScale = 0.5 + pulse.intensity * 0.5
        const scaledSpeed = pulseSpeed * intensityScale
        const scaledWidth = pulseWidth * intensityScale
        const radius = (age / 1000) * scaledSpeed
        const distFromPulse = Math.hypot(x - pulse.x, y - pulse.y)
        const distFromWave = Math.abs(distFromPulse - radius)
        if (distFromWave < scaledWidth) {
          const waveIntensity = 1 - distFromWave / scaledWidth
          const fadeOut = 1 - age / pulseDuration
          maxIntensity = Math.max(maxIntensity, waveIntensity * fadeOut * pulse.intensity)
        }
      }
      return maxIntensity
    }

    const getHoverIntensity = (x: number, y: number) => {
      const mouse = mousePosRef.current
      if (!mouse) return 0
      const hoverRadius = 120
      const dist = Math.hypot(x - mouse.x, y - mouse.y)
      if (dist > hoverRadius) return 0
      return Math.pow(1 - dist / hoverRadius, 2) * 0.6
    }

    const isPointInPanel = (x: number, y: number, panel: GraphNode, margin = 10) =>
      x >= panel.x - margin &&
      x <= panel.x + panel.width + margin &&
      y >= panel.y - margin &&
      y <= panel.y + panel.height + margin

    const buildLPath = (
      startGrid: { gx: number; gy: number },
      endGrid: { gx: number; gy: number },
      horizontalFirst: boolean,
    ) => {
      const pathPoints: { gx: number; gy: number }[] = []
      if (horizontalFirst) {
        const xStep = startGrid.gx < endGrid.gx ? gridSize : -gridSize
        if (startGrid.gx !== endGrid.gx) {
          for (
            let gx = startGrid.gx;
            xStep > 0 ? gx <= endGrid.gx : gx >= endGrid.gx;
            gx += xStep
          ) {
            pathPoints.push({ gx, gy: startGrid.gy })
          }
        } else {
          pathPoints.push({ gx: startGrid.gx, gy: startGrid.gy })
        }
        const yStep = startGrid.gy < endGrid.gy ? gridSize : -gridSize
        if (startGrid.gy !== endGrid.gy) {
          for (
            let gy = startGrid.gy + yStep;
            yStep > 0 ? gy <= endGrid.gy : gy >= endGrid.gy;
            gy += yStep
          ) {
            pathPoints.push({ gx: endGrid.gx, gy })
          }
        }
        return pathPoints
      }
      const yStep = startGrid.gy < endGrid.gy ? gridSize : -gridSize
      if (startGrid.gy !== endGrid.gy) {
        for (
          let gy = startGrid.gy;
          yStep > 0 ? gy <= endGrid.gy : gy >= endGrid.gy;
          gy += yStep
        ) {
          pathPoints.push({ gx: startGrid.gx, gy })
        }
      } else {
        pathPoints.push({ gx: startGrid.gx, gy: startGrid.gy })
      }
      const xStep = startGrid.gx < endGrid.gx ? gridSize : -gridSize
      if (startGrid.gx !== endGrid.gx) {
        for (
          let gx = startGrid.gx + xStep;
          xStep > 0 ? gx <= endGrid.gx : gx >= endGrid.gx;
          gx += xStep
        ) {
          pathPoints.push({ gx, gy: endGrid.gy })
        }
      }
      return pathPoints
    }

    const pathCollidesWithPanels = (
      points: { gx: number; gy: number }[],
      panels: GraphNode[],
      excludePanelIds: string[],
    ) => {
      for (const point of points) {
        for (const panel of panels) {
          if (excludePanelIds.includes(panel.id)) continue
          if (isPointInPanel(point.gx, point.gy, panel)) return true
        }
      }
      return false
    }

    const getDotPos = (gx: number, gy: number) => {
      const dot = dots.get(`${gx},${gy}`)
      return dot ? { x: dot.x, y: dot.y } : { x: gx, y: gy }
    }

    const drawGridPath = (
      fromX: number,
      fromY: number,
      toX: number,
      toY: number,
      panels: GraphNode[],
      excludePanelIds: string[],
      now: number,
    ) => {
      const startGrid = {
        gx: Math.round(fromX / gridSize) * gridSize,
        gy: Math.round(fromY / gridSize) * gridSize,
      }
      const endGrid = {
        gx: Math.round(toX / gridSize) * gridSize,
        gy: Math.round(toY / gridSize) * gridSize,
      }
      let pathPoints = buildLPath(startGrid, endGrid, true)
      const horizontalFirstCollides = pathCollidesWithPanels(
        pathPoints,
        panels,
        excludePanelIds,
      )
      const verticalFirstPath = buildLPath(startGrid, endGrid, false)
      const verticalFirstCollides = pathCollidesWithPanels(
        verticalFirstPath,
        panels,
        excludePanelIds,
      )
      if (horizontalFirstCollides && !verticalFirstCollides) {
        pathPoints = verticalFirstPath
      } else if (horizontalFirstCollides && verticalFirstCollides) {
        if (verticalFirstPath.length < pathPoints.length) pathPoints = verticalFirstPath
      }
      if (pathPoints.length < 2) return
      const actualPoints = pathPoints.map((point) => getDotPos(point.gx, point.gy))
      ctx.save()
      ctx.strokeStyle = '#3B82F6'
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.globalAlpha = 0.7
      ctx.beginPath()
      ctx.moveTo(actualPoints[0]?.x ?? fromX, actualPoints[0]?.y ?? fromY)
      if (actualPoints.length === 2) {
        ctx.lineTo(actualPoints[1]?.x ?? toX, actualPoints[1]?.y ?? toY)
      } else {
        for (let i = 1; i < actualPoints.length - 1; i++) {
          const prev = actualPoints[i - 1]
          const curr = actualPoints[i]
          const next = actualPoints[i + 1]
          if (!prev || !curr || !next) continue
          const midX1 = (prev.x + curr.x) / 2
          const midY1 = (prev.y + curr.y) / 2
          const midX2 = (curr.x + next.x) / 2
          const midY2 = (curr.y + next.y) / 2
          if (i === 1) ctx.lineTo(midX1, midY1)
          ctx.quadraticCurveTo(curr.x, curr.y, midX2, midY2)
        }
        const last = actualPoints[actualPoints.length - 1]
        if (last) ctx.lineTo(last.x, last.y)
      }
      ctx.stroke()

      const sampledPoints: { x: number; y: number }[] = []
      const samplesPerSegment = 8
      if (actualPoints.length === 2) {
        const a = actualPoints[0]
        const b = actualPoints[1]
        if (a && b) sampledPoints.push(a, b)
      } else if (actualPoints[0]) {
        sampledPoints.push(actualPoints[0])
        for (let i = 1; i < actualPoints.length - 1; i++) {
          const prev = actualPoints[i - 1]
          const curr = actualPoints[i]
          const next = actualPoints[i + 1]
          if (!prev || !curr || !next) continue
          const midX1 = (prev.x + curr.x) / 2
          const midY1 = (prev.y + curr.y) / 2
          const midX2 = (curr.x + next.x) / 2
          const midY2 = (curr.y + next.y) / 2
          if (i === 1) {
            for (let t = 1; t <= samplesPerSegment; t++) {
              const tt = t / samplesPerSegment
              sampledPoints.push({
                x: actualPoints[0].x + (midX1 - actualPoints[0].x) * tt,
                y: actualPoints[0].y + (midY1 - actualPoints[0].y) * tt,
              })
            }
          }
          for (let t = 1; t <= samplesPerSegment; t++) {
            const tt = t / samplesPerSegment
            sampledPoints.push({
              x: (1 - tt) * (1 - tt) * midX1 + 2 * (1 - tt) * tt * curr.x + tt * tt * midX2,
              y: (1 - tt) * (1 - tt) * midY1 + 2 * (1 - tt) * tt * curr.y + tt * tt * midY2,
            })
          }
        }
        const last = actualPoints[actualPoints.length - 1]
        const prevLast = actualPoints[actualPoints.length - 2]
        if (last && prevLast) {
          const lastMidX = (prevLast.x + last.x) / 2
          const lastMidY = (prevLast.y + last.y) / 2
          for (let t = 1; t <= samplesPerSegment; t++) {
            const tt = t / samplesPerSegment
            sampledPoints.push({
              x: lastMidX + (last.x - lastMidX) * tt,
              y: lastMidY + (last.y - lastMidY) * tt,
            })
          }
        }
      }

      const cumDist = [0]
      for (let i = 1; i < sampledPoints.length; i++) {
        const prev = sampledPoints[i - 1]
        const curr = sampledPoints[i]
        if (!prev || !curr) continue
        const lastDist = cumDist[i - 1] ?? 0
        cumDist.push(lastDist + Math.hypot(curr.x - prev.x, curr.y - prev.y))
      }
      const totalLen = cumDist[cumDist.length - 1] ?? 0
      if (totalLen > 20) {
        const speed = 0.12
        const pulseSpacing = 100
        const pulseWidth = 60
        const flowPos = (now * speed) % pulseSpacing
        for (let i = 0; i < sampledPoints.length - 1; i++) {
          const a = sampledPoints[i]
          const b = sampledPoints[i + 1]
          if (!a || !b) continue
          const segMid = ((cumDist[i] ?? 0) + (cumDist[i + 1] ?? 0)) / 2
          let brightness = 0
          for (let offset = -pulseSpacing; offset <= totalLen + pulseSpacing; offset += pulseSpacing) {
            const dist = Math.abs(segMid - (flowPos + offset))
            if (dist < pulseWidth) {
              brightness = Math.max(brightness, (Math.cos((dist / pulseWidth) * Math.PI) + 1) / 2)
            }
          }
          if (brightness > 0.02) {
            ctx.save()
            ctx.strokeStyle = `rgba(0, 200, 255, ${brightness * 0.9})`
            ctx.lineWidth = 2 + brightness * 1.5
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
            ctx.restore()
          }
        }
      }

      const first = actualPoints[0]
      const last = actualPoints[actualPoints.length - 1]
      ctx.fillStyle = '#3B82F6'
      if (first) {
        ctx.beginPath()
        ctx.arc(first.x, first.y, 4, 0, Math.PI * 2)
        ctx.fill()
      }
      if (last) {
        ctx.beginPath()
        ctx.arc(last.x, last.y, 4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    const updateParticles = (deltaTime: number) => {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        if (!p) continue
        p.life -= deltaTime
        if (p.life <= 0) {
          particles.splice(i, 1)
          continue
        }
        p.vy += particleGravity
        p.vx *= particleFriction
        p.vy *= particleFriction
        p.x += p.vx
        p.y += p.vy
        p.rotation += p.rotationSpeed
      }
    }

    const updateBouncyParticles = (deltaTime: number, panels: GraphNode[]) => {
      for (const fp of panels) {
        const lastPos = lastPanelPositions.get(fp.id)
        if (lastPos) {
          panelVelocities.set(fp.id, { vx: fp.x - lastPos.x, vy: fp.y - lastPos.y })
        } else {
          panelVelocities.set(fp.id, { vx: 0, vy: 0 })
        }
        lastPanelPositions.set(fp.id, { x: fp.x, y: fp.y })
      }

      for (let i = bouncyParticles.length - 1; i >= 0; i--) {
        const p = bouncyParticles[i]
        if (!p) continue
        if (p.y > height + 200 || p.x < -200 || p.x > width + 200) {
          bouncyParticles.splice(i, 1)
          continue
        }
        p.vy += bouncyParticleGravity
        p.vx *= bouncyParticleFriction
        p.vy *= bouncyParticleFriction
        let collided = false
        let resting:
          | {
              panelVel: { vx: number; vy: number }
              collisionTop: number
              panelLeft: number
              panelRight: number
            }
          | null = null
        const pad = p.size * 0.9
        for (const fp of panels) {
          const panelVel = panelVelocities.get(fp.id) ?? { vx: 0, vy: 0 }
          const collisionLeft = fp.x - pad
          const collisionRight = fp.x + fp.width + pad
          const collisionTop = fp.y - pad
          const collisionBottom = fp.y + fp.height + pad
          const nextX = p.x + p.vx
          const nextY = p.y + p.vy
          const isInX = p.x > collisionLeft && p.x < collisionRight
          const isInY = p.y > collisionTop && p.y < collisionBottom
          const wouldBeInX = nextX > collisionLeft && nextX < collisionRight
          const wouldBeInY = nextY > collisionTop && nextY < collisionBottom
          const panelSpeed = Math.hypot(panelVel.vx, panelVel.vy)
          const panelMovingIntoParticle =
            panelSpeed > 0.5 &&
            ((panelVel.vx > 0 && p.x > fp.x + fp.width - 20 && p.x < collisionRight + 10 && isInY) ||
              (panelVel.vx < 0 && p.x < fp.x + 20 && p.x > collisionLeft - 10 && isInY) ||
              (panelVel.vy > 0 && p.y > fp.y + fp.height - 20 && p.y < collisionBottom + 10 && isInX) ||
              (panelVel.vy < 0 && p.y < fp.y + 20 && p.y > collisionTop - 10 && isInX))
          if (!(panelMovingIntoParticle || (wouldBeInX && wouldBeInY) || (isInX && isInY))) continue
          const distLeft = Math.abs(p.x - collisionLeft)
          const distRight = Math.abs(p.x - collisionRight)
          const distTop = Math.abs(p.y - collisionTop)
          const distBottom = Math.abs(p.y - collisionBottom)
          const minDist = Math.min(distLeft, distRight, distTop, distBottom)
          const randomAngle = ((1 + Math.random() * 2) * Math.PI) / 180 * (Math.random() < 0.5 ? 1 : -1)
          const momentumTransfer = 0.8
          const speed = Math.hypot(p.vx, p.vy)
          if (minDist === distLeft) {
            const angle = Math.atan2(p.vy, -p.vx) + randomAngle
            p.vx = Math.cos(angle) * speed * bouncyBounceDamping + panelVel.vx * momentumTransfer
            p.vy = Math.sin(angle) * speed * bouncyBounceDamping + panelVel.vy * momentumTransfer
            p.x = collisionLeft - 1
            collided = true
            break
          }
          if (minDist === distRight) {
            const angle = Math.atan2(p.vy, -p.vx) + randomAngle
            p.vx = Math.cos(angle) * speed * bouncyBounceDamping + panelVel.vx * momentumTransfer
            p.vy = Math.sin(angle) * speed * bouncyBounceDamping + panelVel.vy * momentumTransfer
            p.x = collisionRight + 1
            collided = true
            break
          }
          if (minDist === distTop) {
            const shouldRest = p.vy >= 0 && Math.abs(p.vy) < 1.5 && panelVel.vy >= -5
            if (shouldRest) {
              resting = { panelVel, collisionTop, panelLeft: fp.x, panelRight: fp.x + fp.width }
            } else {
              const angle = Math.atan2(-p.vy, p.vx) + randomAngle
              p.vx = Math.cos(angle) * speed * bouncyBounceDamping + panelVel.vx * momentumTransfer
              p.vy = Math.sin(angle) * speed * bouncyBounceDamping + panelVel.vy * momentumTransfer
              p.y = collisionTop - 1
              collided = true
              break
            }
          } else {
            const angle = Math.atan2(-p.vy, p.vx) + randomAngle
            p.vx = Math.cos(angle) * speed * bouncyBounceDamping + panelVel.vx * momentumTransfer
            p.vy = Math.sin(angle) * speed * bouncyBounceDamping + panelVel.vy * momentumTransfer
            p.y = collisionBottom + 1
            collided = true
            break
          }
        }
        if (!collided && resting) {
          if (resting.panelVel.vy < -5) {
            p.vx += Math.max(-8, Math.min(8, resting.panelVel.vx * 0.4))
            p.vy = Math.max(-8, resting.panelVel.vy * 0.4)
          } else {
            p.vx = resting.panelVel.vx + (p.vx - resting.panelVel.vx) * bouncySurfaceFriction
            p.vy = 0
            p.y = resting.collisionTop - 1
          }
          p.x += p.vx
          p.rotation += p.rotationSpeed
          continue
        }
        p.x += p.vx
        p.y += p.vy
        p.rotation += p.rotationSpeed
      }
    }

    const animate = () => {
      const now = performance.now()
      const deltaTime = now - lastTime
      lastTime = now
      const panels = nodesRef.current
      const connections = edgesRef.current

      for (const pulse of pulsesRef.current) {
        if (pulse.time > lastPulseTime) {
          spawnParticles(pulse.x, pulse.y, pulse.intensity)
          spawnBouncyParticles(pulse.x, pulse.y, pulse.intensity)
          lastPulseTime = pulse.time
        }
      }
      updateParticles(deltaTime)
      updateBouncyParticles(deltaTime, panels)
      const panelKey = panels.map((panel) => `${panel.id}:${panel.x}:${panel.y}`).join('|')
      const panelsMoved = panelKey !== lastPanelKey
      lastPanelKey = panelKey
      const hasPulses = pulsesRef.current.some((pulse) => now - pulse.time < 2000)
      const hasHover = mousePosRef.current !== null
      const hasParticles = particles.length > 0 || bouncyParticles.length > 0
      const needsMotion = panelsMoved || hasPulses || hasHover || hasParticles || !dotsSettled
      if (!needsMotion) {
        animationId = 0
        return
      }
      ctx.clearRect(0, 0, width, height)

      if (hasPulses) {
        const denseGridSize = gridSize / 2
        for (let gx = -denseGridSize; gx < width + denseGridSize * 2; gx += denseGridSize) {
          for (let gy = -denseGridSize; gy < height + denseGridSize * 2; gy += denseGridSize) {
            if (gx % gridSize === 0 && gy % gridSize === 0) continue
            const pos = getDisplacedPosition(gx, gy, panels)
            const pulseIntensity = getPulseIntensity(pos.x, pos.y, now)
            if (pulseIntensity < 0.05) continue
            const nextPosH = getDisplacedPosition(gx + denseGridSize, gy, panels)
            const avgPulseH = (pulseIntensity + getPulseIntensity(nextPosH.x, nextPosH.y, now)) / 2
            if (avgPulseH > 0.05) {
              ctx.beginPath()
              ctx.moveTo(pos.x, pos.y)
              ctx.lineTo(nextPosH.x, nextPosH.y)
              ctx.strokeStyle = `rgba(37, 99, 235, ${avgPulseH * 0.9})`
              ctx.lineWidth = 0.3 + avgPulseH * 0.5
              ctx.stroke()
            }
            const nextPosV = getDisplacedPosition(gx, gy + denseGridSize, panels)
            const avgPulseV = (pulseIntensity + getPulseIntensity(nextPosV.x, nextPosV.y, now)) / 2
            if (avgPulseV > 0.05) {
              ctx.beginPath()
              ctx.moveTo(pos.x, pos.y)
              ctx.lineTo(nextPosV.x, nextPosV.y)
              ctx.strokeStyle = `rgba(37, 99, 235, ${avgPulseV * 0.9})`
              ctx.lineWidth = 0.3 + avgPulseV * 0.5
              ctx.stroke()
            }
          }
        }
      }

      dots.forEach((dot, key) => {
        const [gxStr, gyStr] = key.split(',')
        const gx = Number(gxStr)
        const gy = Number(gyStr)
        const rightDot = dots.get(`${gx + gridSize},${gy}`)
        const bottomDot = dots.get(`${gx},${gy + gridSize}`)
        let lineMinDist = Infinity
        for (const panel of panels) {
          const closestX = Math.max(panel.x, Math.min(dot.x, panel.x + panel.width))
          const closestY = Math.max(panel.y, Math.min(dot.y, panel.y + panel.height))
          lineMinDist = Math.min(lineMinDist, Math.hypot(dot.x - closestX, dot.y - closestY))
        }
        const normalizedDist = Math.min(lineMinDist / maxDist, 1)
        const baseLineOpacity = (0.25 - normalizedDist * 0.2) * 0.5
        const pulseIntensity = getPulseIntensity(dot.x, dot.y, now)
        const hoverIntensity = getHoverIntensity(dot.x, dot.y)
        if (rightDot) {
          const avgEffect = Math.max(
            (pulseIntensity + getPulseIntensity(rightDot.x, rightDot.y, now)) / 2,
            (hoverIntensity + getHoverIntensity(rightDot.x, rightDot.y)) / 2,
          )
          const lineOpacity = baseLineOpacity + avgEffect * 0.8
          if (lineOpacity > 0.01) {
            ctx.beginPath()
            ctx.moveTo(dot.x, dot.y)
            ctx.lineTo(rightDot.x, rightDot.y)
            ctx.lineWidth = 0.5 + avgEffect * 2
            ctx.strokeStyle =
              avgEffect > 0.1
                ? `rgba(37, ${99 + avgEffect * 60}, 235, ${Math.max(0, lineOpacity + avgEffect * 0.7)})`
                : `rgba(160, 160, 160, ${Math.max(0, lineOpacity)})`
            ctx.stroke()
          }
        }
        if (bottomDot) {
          const avgEffect = Math.max(
            (pulseIntensity + getPulseIntensity(bottomDot.x, bottomDot.y, now)) / 2,
            (hoverIntensity + getHoverIntensity(bottomDot.x, bottomDot.y)) / 2,
          )
          const lineOpacity = baseLineOpacity + avgEffect * 0.8
          if (lineOpacity > 0.01) {
            ctx.beginPath()
            ctx.moveTo(dot.x, dot.y)
            ctx.lineTo(bottomDot.x, bottomDot.y)
            ctx.lineWidth = 0.5 + avgEffect * 2
            ctx.strokeStyle =
              avgEffect > 0.1
                ? `rgba(37, ${99 + avgEffect * 60}, 235, ${Math.max(0, lineOpacity + avgEffect * 0.7)})`
                : `rgba(160, 160, 160, ${Math.max(0, lineOpacity)})`
            ctx.stroke()
          }
        }
      })

      dots.forEach((dot, key) => {
        const [gxStr, gyStr] = key.split(',')
        const gx = Number(gxStr)
        const gy = Number(gyStr)
        const displaced = getDisplacedPosition(gx, gy, panels)
        let minDist = Infinity
        for (const panel of panels) {
          const closestX = Math.max(panel.x, Math.min(gx, panel.x + panel.width))
          const closestY = Math.max(panel.y, Math.min(gy, panel.y + panel.height))
          minDist = Math.min(minDist, Math.hypot(gx - closestX, gy - closestY))
        }
        const forceX = (displaced.x - dot.x) * springStiffness
        const forceY = (displaced.y - dot.y) * springStiffness
        dot.vx = (dot.vx + forceX) * damping
        dot.vy = (dot.vy + forceY) * damping
        if (panelsMoved || !dotsSettled) {
          dot.x += dot.vx
          dot.y += dot.vy
          const normalizedDist = Math.min(minDist / maxDist, 1)
          dot.targetSize = 0.8 + Math.sin(normalizedDist * Math.PI) * 2
          dot.size += (dot.targetSize - dot.size) * 0.15
        }
        const brightnessFalloff = Math.pow(Math.min(minDist / 110, 1), 2)
        const opacity = 0.12 + (1 - brightnessFalloff) * 0.8
        const colorValue = Math.round(130 + (1 - brightnessFalloff) * 125)
        ctx.beginPath()
        ctx.arc(dot.x, dot.y, Math.max(0.5, dot.size), 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${colorValue}, ${colorValue}, ${colorValue}, ${Math.max(0, opacity)})`
        ctx.fill()
      })

      if (!panelsMoved && !hasPulses && !hasHover && !hasParticles) {
        let maxSpeed = 0
        dots.forEach((dot) => {
          maxSpeed = Math.max(maxSpeed, Math.hypot(dot.vx, dot.vy))
        })
        dotsSettled = maxSpeed < 0.02
      } else {
        dotsSettled = false
      }

      for (const edge of connections) {
        const from = panels.find((panel) => panel.id === edge.from)
        const to = panels.find((panel) => panel.id === edge.to)
        if (!from || !to) continue
        drawGridPath(
          from.x + from.width / 2,
          from.y + from.height / 2,
          to.x + to.width / 2,
          to.y + to.height / 2,
          panels,
          [from.id, to.id],
          now,
        )
      }

      for (const p of particles) {
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rotation)
        const alpha = p.opacity * (p.life / p.maxLife)
        ctx.fillStyle = `rgba(37, 99, 235, ${alpha})`
        ctx.strokeStyle = `rgba(100, 160, 255, ${alpha * 0.8})`
        ctx.lineWidth = 0.5
        drawParticleShape(ctx, p)
        ctx.fill()
        ctx.stroke()
        ctx.restore()
      }
      for (const p of bouncyParticles) {
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rotation)
        if (p.color === 'blue') {
          ctx.fillStyle = `rgba(37, 99, 235, ${p.opacity * 0.95})`
          ctx.strokeStyle = `rgba(100, 160, 255, ${p.opacity * 0.8})`
          ctx.lineWidth = 0.5
        } else {
          ctx.fillStyle = `rgba(150, 220, 255, ${p.opacity * 0.9})`
          ctx.strokeStyle = `rgba(220, 240, 255, ${p.opacity})`
          ctx.lineWidth = 0.8
        }
        drawParticleShape(ctx, p)
        ctx.fill()
        ctx.stroke()
        ctx.restore()
      }

      animationId = requestAnimationFrame(animate)
    }

    animationId = requestAnimationFrame(animate)
    wakeRef.current = () => {
      if (animationId) return
      dotsSettled = false
      animationId = requestAnimationFrame(animate)
    }
    return () => {
      wakeRef.current = null
      cancelAnimationFrame(animationId)
    }
  }, [height, width])

  useEffect(() => {
    wakeRef.current?.()
  }, [nodes, pulses, mousePos])

  return (
    <canvas
      ref={canvasRef}
      data-testid="node-graph-grid"
      style={{
        position: 'absolute',
        inset: 0,
        width,
        height,
        pointerEvents: 'none',
        zIndex: 0,
        ...EDGE_FADE,
      }}
    />
  )
}

const GRAIN_DATA_URI =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.28 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"

export function NoiseOverlay() {
  return (
    <div
      data-testid="node-graph-noise"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 1,
        mixBlendMode: 'overlay',
        opacity: 0.35,
        backgroundImage: `url("${GRAIN_DATA_URI}")`,
        backgroundSize: '160px 160px',
        ...EDGE_FADE,
      }}
    />
  )
}
