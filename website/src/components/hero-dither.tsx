/**
 * Mintlify-style dithered dot field behind the homepage hero.
 * Port of DitherContent from mintlify.com/data. Accent color is --primary.
 */
'use client'

import { useEffect, useRef } from 'react'

type Dot = {
  x: number
  y: number
  isGreen: boolean
  nextFlipAt: number
  pulseWindows: { startAt: number; endAt: number }[]
}

type Ripple = { x: number; y: number; time: number }

const PITCH = 14
const FEATHER = 0.06
const SCALE = 110
const THRESHOLD = 0.54
const BASE_ALPHA_LIGHT = 0.12
const BASE_ALPHA_DARK = 0.9
const LIGHT_BASE: [number, number, number] = [0, 0, 0]
const DARK_BASE: [number, number, number] = [72, 76, 84]

function hashNoise(x: number, y: number) {
  let n = Math.imul(x, 0x165667b1) + Math.imul(y, 0x27d4eb2f)
  n = Math.imul(n ^ (n >>> 13), 0x4bf19f61)
  return ((n ^= n >>> 16) >>> 0) / 0xffffffff
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t)
}

function clamp01(t: number) {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function valueNoise(x: number, y: number) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const sx = smoothstep(x - x0)
  const sy = smoothstep(y - y0)
  const n00 = hashNoise(x0, y0)
  const n10 = hashNoise(x0 + 1, y0)
  const n01 = hashNoise(x0, y0 + 1)
  const n11 = hashNoise(x0 + 1, y0 + 1)
  const ix0 = n00 + (n10 - n00) * sx
  return ix0 + (n01 + (n11 - n01) * sx - ix0) * sy
}

function isDarkMode() {
  return document.documentElement.classList.contains('dark')
}

function hexToRgb(hex: string): [number, number, number] | null {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

function readPrimaryRgb(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--primary')
    .trim()
  const hexMatch = raw.match(/#([0-9a-fA-F]{6})/)
  if (hexMatch) {
    const rgb = hexToRgb(hexMatch[1])
    if (rgb) return rgb
  }
  const fromHex = hexToRgb(raw)
  if (fromHex) return fromHex
  const rgb = raw.match(/(\d+)[^\d]+(\d+)[^\d]+(\d+)/)
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  return [88, 101, 242]
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

export function HeroDither({ offsetX = 0 }: { offsetX?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let dark = isDarkMode()
    let primary = readPrimaryRgb()
    let width = 0
    let height = 0
    let dots: Dot[] = []
    let frame = 0
    let visible = false
    let ripples: Ripple[] = []
    let lastRippleAt = 0
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches

    const edgeY = (y: number) => {
      const fade = Math.min(FEATHER * window.innerHeight, height / 2)
      if (fade <= 0) return 1
      return Math.max(
        0,
        Math.min(Math.min(1, y / fade), Math.min(1, (height - y) / fade)),
      )
    }
    const edgeX = (x: number) => {
      const fade = Math.min(48, width / 8)
      if (fade <= 0) return 1
      return Math.max(
        0,
        Math.min(Math.min(1, x / fade), Math.min(1, (width - x) / fade)),
      )
    }
    const accentAt = () => primary

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height)
      ripples = ripples.filter((ripple) => now - ripple.time <= 600)
      const base = dark ? DARK_BASE : LIGHT_BASE
      const baseAlpha = dark ? BASE_ALPHA_DARK : BASE_ALPHA_LIGHT
      for (const dot of dots) {
        const alpha = edgeY(dot.y) * edgeX(dot.x)
        if (alpha <= 0) continue
        const pulsing = dot.pulseWindows.some(
          (window) => now >= window.startAt && now <= window.endAt,
        )
        let rippleStrength = 0
        for (const ripple of ripples) {
          const dist = Math.hypot(dot.x - ripple.x, dot.y - ripple.y)
          if (dist < 42) {
            const next = smoothstep(1 - dist / 42)
            if (next > rippleStrength) rippleStrength = next
          }
        }
        const lit = Math.max(+!!dot.isGreen, +!!pulsing, rippleStrength)
        const accent = accentAt()
        const color = mix(base, accent, lit)
        ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`
        ctx.globalAlpha = (baseAlpha + (0.85 - baseAlpha) * lit) * alpha
        ctx.fillRect(dot.x - 1, dot.y - 1, 2, 2)
      }
      ctx.globalAlpha = 1
    }

    const tick = (now: number) => {
      for (const dot of dots) {
        dot.pulseWindows = dot.pulseWindows.filter((window) => window.endAt >= now)
        if (now >= dot.nextFlipAt) {
          dot.isGreen = Math.random() < 0.1
          dot.nextFlipAt = now + 2200 + 3800 * Math.random()
        }
      }
      draw(now)
      frame = requestAnimationFrame(tick)
    }

    const stop = () => {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
    }

    const layout = () => {
      const box = parent.getBoundingClientRect()
      width = window.innerWidth
      height = parent.clientHeight
      if (width <= 0 || height <= 0) return
      canvas.style.left = `${-box.left}px`
      canvas.style.top = '0px'
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const next: Dot[] = []
      const now = performance.now()
      for (let x = PITCH / 2; x < width; x += PITCH) {
        for (let y = PITCH / 2; y < height; y += PITCH) {
          const nx = (x + offsetX) / SCALE
          const ny = y / SCALE
          if (
            0.65 * valueNoise(nx, ny) +
              0.35 * valueNoise(2.3 * nx + 11.7, 2.3 * ny + 5.1) <
            THRESHOLD
          ) {
            continue
          }
          next.push({
            x,
            y,
            isGreen: Math.random() < 0.1,
            nextFlipAt: now + 6000 * Math.random(),
            pulseWindows: [],
          })
        }
      }
      dots = next
      draw(now)
    }

    const toLocal = (clientX: number, clientY: number) => {
      const box = canvas.getBoundingClientRect()
      return { x: clientX - box.left, y: clientY - box.top }
    }

    const onMove = (event: PointerEvent) => {
      if (reducedMotion || !visible) return
      const now = performance.now()
      const { x, y } = toLocal(event.clientX, event.clientY)
      if (x < -42 || x > width + 42 || y < -42 || y > height + 42) return
      if (now - lastRippleAt >= 16 || ripples.length === 0) {
        ripples.push({ x, y, time: now })
        if (ripples.length > 60) ripples.shift()
        lastRippleAt = now
      } else {
        ripples[ripples.length - 1] = { x, y, time: now }
      }
    }

    const onClick = (event: MouseEvent) => {
      if (reducedMotion || !visible) return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest(
          'a, button, input, select, textarea, label, [role="button"], [role="link"]',
        )
      ) {
        return
      }
      const now = performance.now()
      const { x, y } = toLocal(event.clientX, event.clientY)
      if (x < 0 || x > width || y < 0 || y > height) return
      for (const dot of dots) {
        const startAt = now + 1.4 * Math.hypot(dot.x - x, dot.y - y)
        dot.pulseWindows.push({ startAt, endAt: startAt + 160 })
        if (dot.pulseWindows.length > 8) dot.pulseWindows.shift()
      }
    }

    layout()
    const resizeObserver = new ResizeObserver(layout)
    resizeObserver.observe(parent)
    const intersection = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting
        if (visible) {
          if (!frame && !reducedMotion) frame = requestAnimationFrame(tick)
        } else {
          stop()
        }
      },
      { rootMargin: '20% 0px' },
    )
    intersection.observe(canvas)
    const mutation = new MutationObserver(() => {
      dark = isDarkMode()
      primary = readPrimaryRgb()
      draw(performance.now())
    })
    mutation.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('click', onClick)
    window.addEventListener('resize', layout)
    return () => {
      stop()
      resizeObserver.disconnect()
      intersection.disconnect()
      mutation.disconnect()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('click', onClick)
      window.removeEventListener('resize', layout)
    }
  }, [offsetX])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden='true'
      className='pointer-events-none absolute left-0 top-0 -z-10'
    />
  )
}
