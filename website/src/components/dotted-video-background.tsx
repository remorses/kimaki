/**
 * Dotted video background effect.
 * Renders a video through a dot-grid shader using Three.js WebGL.
 * Includes a 2D Navier-Stokes fluid simulation for interactive mouse trails.
 *
 * Source: https://github.com/remorses/termcast/blob/main/website/src/components/dotted-video-background.tsx
 *
 * Shader approach adapted from antimetal.com's hero effect:
 * - Video texture is sampled per grid cell
 * - Luminance drives dot radius (bright = big dot, dark = invisible)
 * - Fluid dye is additively blended with the video before luminance calc
 * - Mouse movement creates splats in the fluid sim
 *
 * No 'use client' directive here: this module is only imported by
 * hero-section.tsx which is already 'use client'. Adding a second
 * boundary causes @vitejs/plugin-rsc to wrap the import in React.lazy(),
 * turning it into a dynamic chunk that misses SSR modulepreload hints
 * and loads ~600ms late.
 */

import { useEffect, useRef } from 'react'
import { preload } from 'react-dom'
import * as THREE from 'three'

// Video source constant shared between the preload hint and the engine.
const VIDEO_SRC = '/assets/hero-bg.mp4'

// ─── Shader sources ────────────────────────────────────────────────────────

const BASE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Vertex shader for fluid sim (needs texel offset varyings)
const FLUID_VERTEX = /* glsl */ `
  precision highp float;
  attribute vec2 uv;
  attribute vec3 position;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 texelSize;

  void main() {
    vUv = uv;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(position, 1.0);
  }
`

const ADVECTION_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform float dt;
  uniform float dissipation;
  varying vec2 vUv;

  void main() {
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    gl_FragColor = dissipation * texture2D(uSource, coord);
  }
`

const DIVERGENCE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uVelocity;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;

  void main() {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`

const CURL_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uVelocity;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;

  void main() {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
  }
`

const VORTICITY_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;

  void main() {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 vel = texture2D(uVelocity, vUv).xy;
    gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
  }
`

const PRESSURE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;

  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`

const GRADIENT_SUBTRACT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;

  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`

const SPLAT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`

// The main display shader: converts video + fluid dye into a dot grid
const DISPLAY_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uDye;
  uniform sampler2D uVideo;
  uniform sampler2D uMask;
  uniform bool enableMask;
  uniform float fluidStrength;
  uniform float gridCellSize;
  uniform float dotRadius;
  uniform float minDotRadius;
  uniform vec2 videoResolution;
  uniform float time;
  uniform float animSpeed;
  uniform float gamma;
  uniform int gridLayout;
  uniform vec3 dotColor;
  uniform float dotAlphaMultiplier;
  uniform bool dotsEnabled;
  varying vec2 vUv;

  float random(vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
  }

  void main() {
    vec2 gridPos;
    vec2 cellCenter;
    vec2 cellIndex;
    vec2 centerUv;
    float distanceFromCenter;
    float aspectRatio = videoResolution.x / videoResolution.y;

    if (gridLayout == 1) {
      // Radial layout
      vec2 pixelPos = vUv * videoResolution;
      vec2 center = videoResolution * 0.5;
      float minDim = min(videoResolution.x, videoResolution.y);
      vec2 normalizedPos = (pixelPos - center) / minDim;
      float angle = atan(normalizedPos.y, normalizedPos.x);
      float radius = length(normalizedPos) * minDim;
      float ringIndex = floor(radius / gridCellSize);
      vec2 dotCenterNormalized;
      float dotIndex;
      if (ringIndex < 0.5) {
        dotCenterNormalized = vec2(0.0, 0.0);
        dotIndex = 0.0;
      } else {
        float ringRadius = ringIndex * gridCellSize;
        float circumference = 6.28318 * ringRadius;
        float numDotsInRing = max(1.0, floor(circumference / gridCellSize));
        float anglePerDot = 6.28318 / numDotsInRing;
        dotIndex = floor(angle / anglePerDot);
        float dotAngle = (dotIndex + 0.5) * anglePerDot;
        float dotRad = (ringIndex + 0.5) * gridCellSize;
        dotCenterNormalized = vec2(cos(dotAngle), sin(dotAngle)) * (dotRad / minDim);
      }
      vec2 dotCenterPixel = dotCenterNormalized * minDim + center;
      vec2 toDotNormalized = normalizedPos - dotCenterNormalized;
      distanceFromCenter = length(toDotNormalized) * minDim;
      centerUv = dotCenterPixel / videoResolution;
      cellIndex = vec2(ringIndex, dotIndex);
      gridPos = vec2(0.0);
      cellCenter = vec2(0.0);
    } else if (gridLayout == 2) {
      // Alternating grid (brick pattern)
      cellIndex = floor(vUv * videoResolution / gridCellSize);
      float rowOffset = mod(cellIndex.y, 2.0) * gridCellSize * 0.5;
      vec2 offsetPixel = vUv * videoResolution + vec2(rowOffset, 0.0);
      cellIndex = floor(offsetPixel / gridCellSize);
      centerUv = ((cellIndex + 0.5) * gridCellSize - vec2(rowOffset, 0.0)) / videoResolution;
      gridPos = mod(offsetPixel, gridCellSize);
      cellCenter = vec2(gridCellSize * 0.5);
      distanceFromCenter = length(gridPos - cellCenter);
    } else {
      // Straight layout (default)
      gridPos = mod(vUv * videoResolution, gridCellSize);
      cellCenter = vec2(gridCellSize * 0.5);
      cellIndex = floor(vUv * videoResolution / gridCellSize);
      centerUv = ((cellIndex + 0.5) * gridCellSize) / videoResolution;
      distanceFromCenter = length(gridPos - cellCenter);
    }

    vec4 video = texture2D(uVideo, centerUv);
    vec4 dye = texture2D(uDye, centerUv);
    vec3 videoGammaCorrected = pow(video.rgb, vec3(gamma));
    vec3 scaledDye = dye.rgb * fluidStrength;
    scaledDye = pow(scaledDye + 0.001, vec3(0.7));
    vec3 blendedColor = videoGammaCorrected + scaledDye;
    float luminance = dot(blendedColor, vec3(0.299, 0.587, 0.114));

    if (enableMask) {
      vec4 mask = texture2D(uMask, vUv);
      float maskAlpha = mask.a;
      luminance = luminance * maskAlpha;
    }

    if (!dotsEnabled) {
      gl_FragColor = vec4(dotColor, luminance * dotAlphaMultiplier);
      return;
    }

    float randomValue = random(cellIndex);
    float phase = randomValue * 6.28318;
    float scaleAnimation = sin(time * animSpeed + phase) * 0.5 + 0.5;
    float randomScale = 1.0 - (scaleAnimation * 0.5);
    float luminanceMinScale = min(minDotRadius / dotRadius, 1.0);
    float finalScale = (luminanceMinScale + (luminance * (1.0 - luminanceMinScale))) * randomScale;
    float scaledRadiusVal = dotRadius * finalScale;
    float maxRadius = gridCellSize * 0.5;
    scaledRadiusVal = min(scaledRadiusVal, maxRadius);
    float edgeWidth = 0.5;
    float dotMask = 1.0 - smoothstep(scaledRadiusVal - edgeWidth, scaledRadiusVal + edgeWidth, distanceFromCenter);
    float luminanceCutoff = smoothstep(0.0, 0.1, luminance);
    float finalAlpha = dotMask * luminance * luminanceCutoff * dotAlphaMultiplier;

    gl_FragColor = vec4(dotColor, finalAlpha);
  }
`

// ─── Config ────────────────────────────────────────────────────────────────

export interface DottedVideoConfig {
  videoSource?: string
  maskSrc?: string
  dotsEnabled?: boolean
  dotSize?: number
  minDotSize?: number
  dotMargin?: number
  dotColor?: string
  dotAlphaMultiplier?: number
  gridLayout?: 'straight' | 'radial' | 'alternating-grid'
  enableMask?: boolean
  animSpeed?: number
  gamma?: number
  loopAt?: number
  fluidCurl?: number
  fluidVelocityDissipation?: number
  fluidDyeDissipation?: number
  fluidSplatRadius?: number
  fluidPressureIterations?: number
  fluidStrength?: number
}

const DEFAULT_CONFIG: Required<DottedVideoConfig> = {
  videoSource: '/assets/hero-bg.mp4',
  maskSrc: '/assets/hero-video-mask.avif',
  dotsEnabled: true,
  dotSize: 8,
  minDotSize: 1,
  dotMargin: 0,
  dotColor: '#5865F2', // Discord blurple to match kimaki theme
  dotAlphaMultiplier: 1,
  gridLayout: 'straight',
  enableMask: false,
  animSpeed: 4,
  gamma: 0.9,
  loopAt: 4,
  fluidCurl: 100,
  fluidVelocityDissipation: 0.93,
  fluidDyeDissipation: 0.95,
  fluidSplatRadius: 0.006,
  fluidPressureIterations: 1,
  fluidStrength: 0.15,
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function hexToRgbNormalized(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return { r: 1, g: 1, b: 1 }
  return {
    r: Number.parseInt(result[1], 16) / 255,
    g: Number.parseInt(result[2], 16) / 255,
    b: Number.parseInt(result[3], 16) / 255,
  }
}

function createFBOOptions(format: THREE.PixelFormat, type: THREE.TextureDataType): THREE.RenderTargetOptions {
  return {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format,
    type,
    depthBuffer: false,
    stencilBuffer: false,
  }
}

function createDoubleFBO(w: number, h: number, format: THREE.PixelFormat = THREE.RGBAFormat, type: THREE.TextureDataType = THREE.FloatType) {
  const opts = createFBOOptions(format, type)
  const read = new THREE.WebGLRenderTarget(w, h, opts)
  const write = new THREE.WebGLRenderTarget(w, h, opts)
  return {
    read,
    write,
    swap() {
      const temp = this.read
      this.read = this.write
      this.write = temp
    },
  }
}

function createFBO(w: number, h: number, format: THREE.PixelFormat = THREE.RGBAFormat, type: THREE.TextureDataType = THREE.FloatType) {
  return new THREE.WebGLRenderTarget(w, h, createFBOOptions(format, type))
}

// ─── Engine ────────────────────────────────────────────────────────────────

function createDottedVideoEngine(container: HTMLElement, userConfig: DottedVideoConfig) {
  const config = { ...DEFAULT_CONFIG, ...userConfig }

  const width = container.clientWidth
  const height = container.clientHeight

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true })
  renderer.setSize(width, height)
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  container.appendChild(renderer.domElement)

  // Check float texture support
  const gl = renderer.getContext()
  const halfFloat = gl.getExtension('OES_texture_half_float')
  const texType: THREE.TextureDataType = halfFloat ? THREE.HalfFloatType : THREE.FloatType

  // Sim resolution (half size for performance)
  const simW = Math.floor(width / 2)
  const simH = Math.floor(height / 2)

  // Fluid simulation FBOs
  const velocity = createDoubleFBO(simW, simH, THREE.RGBAFormat, texType)
  const dye = createDoubleFBO(simW, simH, THREE.RGBAFormat, texType)
  const divergenceFBO = createFBO(simW, simH, THREE.RGBAFormat, texType)
  const curlFBO = createFBO(simW, simH, THREE.RGBAFormat, texType)
  const pressure = createDoubleFBO(simW, simH, THREE.RGBAFormat, texType)

  // Video element
  const video = document.createElement('video')
  video.src = config.videoSource
  video.loop = false
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.addEventListener('ended', () => {
    video.currentTime = config.loopAt
    video.play().catch(() => {})
  })

  const videoTexture = new THREE.VideoTexture(video)
  videoTexture.minFilter = THREE.NearestFilter
  videoTexture.magFilter = THREE.NearestFilter
  videoTexture.format = THREE.RGBAFormat

  // Mask texture (only load when mask is actually enabled to avoid 404s)
  let maskTexture: THREE.Texture
  if (config.enableMask) {
    maskTexture = new THREE.TextureLoader().load(config.maskSrc)
    maskTexture.minFilter = THREE.NearestFilter
    maskTexture.magFilter = THREE.NearestFilter
  } else {
    maskTexture = new THREE.Texture()
  }

  // Full-screen quad geometry
  const quadGeo = new THREE.PlaneGeometry(2, 2)

  // Texel size uniform for fluid shaders
  const texelSize = new THREE.Vector2(1.0 / simW, 1.0 / simH)

  // ── Fluid simulation materials ──

  const advectionMat = new THREE.RawShaderMaterial({
    vertexShader: FLUID_VERTEX,
    fragmentShader: ADVECTION_FRAG,
    uniforms: {
      uVelocity: { value: null },
      uSource: { value: null },
      texelSize: { value: texelSize },
      dt: { value: 0.016 },
      dissipation: { value: config.fluidVelocityDissipation },
    },
    glslVersion: THREE.GLSL1,
  })

  const divergenceMat = new THREE.RawShaderMaterial({
    vertexShader: FLUID_VERTEX,
    fragmentShader: DIVERGENCE_FRAG,
    uniforms: {
      uVelocity: { value: null },
      texelSize: { value: texelSize },
    },
    glslVersion: THREE.GLSL1,
  })

  const curlMat = new THREE.RawShaderMaterial({
    vertexShader: FLUID_VERTEX,
    fragmentShader: CURL_FRAG,
    uniforms: {
      uVelocity: { value: null },
      texelSize: { value: texelSize },
    },
    glslVersion: THREE.GLSL1,
  })

  const vorticityMat = new THREE.RawShaderMaterial({
    vertexShader: FLUID_VERTEX,
    fragmentShader: VORTICITY_FRAG,
    uniforms: {
      uVelocity: { value: null },
      uCurl: { value: null },
      curl: { value: config.fluidCurl },
      dt: { value: 0.016 },
      texelSize: { value: texelSize },
    },
    glslVersion: THREE.GLSL1,
  })

  const pressureMat = new THREE.RawShaderMaterial({
    vertexShader: FLUID_VERTEX,
    fragmentShader: PRESSURE_FRAG,
    uniforms: {
      uPressure: { value: null },
      uDivergence: { value: null },
      texelSize: { value: texelSize },
    },
    glslVersion: THREE.GLSL1,
  })

  const gradientSubtractMat = new THREE.RawShaderMaterial({
    vertexShader: FLUID_VERTEX,
    fragmentShader: GRADIENT_SUBTRACT_FRAG,
    uniforms: {
      uPressure: { value: null },
      uVelocity: { value: null },
      texelSize: { value: texelSize },
    },
    glslVersion: THREE.GLSL1,
  })

  const splatMat = new THREE.RawShaderMaterial({
    vertexShader: FLUID_VERTEX,
    fragmentShader: SPLAT_FRAG,
    uniforms: {
      uTarget: { value: null },
      aspectRatio: { value: width / height },
      color: { value: new THREE.Vector3(0, 0, 0) },
      point: { value: new THREE.Vector2(0, 0) },
      radius: { value: config.fluidSplatRadius },
      texelSize: { value: texelSize },
    },
    glslVersion: THREE.GLSL1,
  })

  // ── Display material ──

  const gridLayoutIndex = { straight: 0, radial: 1, 'alternating-grid': 2 }[config.gridLayout] || 0
  const dotRgb = hexToRgbNormalized(config.dotColor)

  const displayMat = new THREE.ShaderMaterial({
    vertexShader: BASE_VERTEX,
    fragmentShader: DISPLAY_FRAG,
    uniforms: {
      uDye: { value: dye.read.texture },
      uVideo: { value: videoTexture },
      uMask: { value: maskTexture },
      enableMask: { value: config.enableMask },
      fluidStrength: { value: config.fluidStrength },
      gridCellSize: { value: config.dotSize + config.dotMargin },
      dotRadius: { value: config.dotSize / 2 },
      minDotRadius: { value: config.minDotSize / 2 },
      videoResolution: { value: new THREE.Vector2(width, height) },
      time: { value: 0 },
      animSpeed: { value: config.animSpeed },
      gamma: { value: config.gamma },
      gridLayout: { value: gridLayoutIndex },
      dotColor: { value: new THREE.Vector3(dotRgb.r, dotRgb.g, dotRgb.b) },
      dotAlphaMultiplier: { value: config.dotAlphaMultiplier },
      dotsEnabled: { value: config.dotsEnabled },
    },
    transparent: true,
    depthTest: false,
  })

  // Scene setup for rendering quads
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const quad = new THREE.Mesh(quadGeo, displayMat)
  scene.add(quad)

  // ── Render helpers ──

  function renderToTarget(material: THREE.ShaderMaterial | THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    ;(quad as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial | THREE.RawShaderMaterial>).material = material
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
  }

  // ── Fluid simulation step ──

  function stepFluid(dt: number) {
    // Advect velocity
    advectionMat.uniforms.dt.value = dt
    advectionMat.uniforms.uVelocity.value = velocity.read.texture
    advectionMat.uniforms.uSource.value = velocity.read.texture
    advectionMat.uniforms.dissipation.value = config.fluidVelocityDissipation
    renderToTarget(advectionMat, velocity.write)
    velocity.swap()

    // Advect dye
    advectionMat.uniforms.uVelocity.value = velocity.read.texture
    advectionMat.uniforms.uSource.value = dye.read.texture
    advectionMat.uniforms.dissipation.value = config.fluidDyeDissipation
    renderToTarget(advectionMat, dye.write)
    dye.swap()

    // Curl
    curlMat.uniforms.uVelocity.value = velocity.read.texture
    renderToTarget(curlMat, curlFBO)

    // Vorticity confinement
    vorticityMat.uniforms.uVelocity.value = velocity.read.texture
    vorticityMat.uniforms.uCurl.value = curlFBO.texture
    vorticityMat.uniforms.dt.value = dt
    renderToTarget(vorticityMat, velocity.write)
    velocity.swap()

    // Divergence
    divergenceMat.uniforms.uVelocity.value = velocity.read.texture
    renderToTarget(divergenceMat, divergenceFBO)

    // Pressure solve (Jacobi iterations)
    pressureMat.uniforms.uDivergence.value = divergenceFBO.texture
    for (let i = 0; i < config.fluidPressureIterations; i++) {
      pressureMat.uniforms.uPressure.value = pressure.read.texture
      renderToTarget(pressureMat, pressure.write)
      pressure.swap()
    }

    // Gradient subtract
    gradientSubtractMat.uniforms.uPressure.value = pressure.read.texture
    gradientSubtractMat.uniforms.uVelocity.value = velocity.read.texture
    renderToTarget(gradientSubtractMat, velocity.write)
    velocity.swap()
  }

  // ── Splat (mouse interaction) ──

  function splat(x: number, y: number, dx: number, dy: number) {
    splatMat.uniforms.aspectRatio.value = width / height

    // Splat velocity
    splatMat.uniforms.uTarget.value = velocity.read.texture
    splatMat.uniforms.point.value.set(x / width, 1.0 - y / height)
    splatMat.uniforms.color.value.set(dx * 5000, -dy * 5000, 0)
    splatMat.uniforms.radius.value = config.fluidSplatRadius
    renderToTarget(splatMat, velocity.write)
    velocity.swap()

    // Splat dye (use dot color for the trail)
    splatMat.uniforms.uTarget.value = dye.read.texture
    splatMat.uniforms.color.value.set(dotRgb.r * 0.3, dotRgb.g * 0.3, dotRgb.b * 0.3)
    renderToTarget(splatMat, dye.write)
    dye.swap()
  }

  // ── Mouse tracking ──

  let lastMouseX = 0
  let lastMouseY = 0
  let mouseDown = false

  function onMouseMove(e: MouseEvent) {
    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const dx = x - lastMouseX
    const dy = y - lastMouseY
    lastMouseX = x
    lastMouseY = y

    if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
      splat(x, y, dx * 0.01, dy * 0.01)
    }
  }

  container.addEventListener('mousemove', onMouseMove)

  // ── Animation loop ──

  let animId: number
  let lastTime = performance.now()
  const startTime = performance.now()

  // Start video playback
  video.play().catch(() => {
    // Autoplay blocked; try muted play on first interaction
    const tryPlay = () => {
      video.play().catch(() => {})
      document.removeEventListener('click', tryPlay)
    }
    document.addEventListener('click', tryPlay)
  })

  function animate() {
    animId = requestAnimationFrame(animate)

    const now = performance.now()
    const dt = Math.min((now - lastTime) / 1000, 0.033) // cap at ~30fps dt
    lastTime = now

    // Update time uniform
    displayMat.uniforms.time.value = (now - startTime) / 1000

    // Step fluid simulation
    stepFluid(dt)

    // Update display material with latest dye
    displayMat.uniforms.uDye.value = dye.read.texture

    // Render final display
    quad.material = displayMat
    renderer.setRenderTarget(null)
    renderer.render(scene, camera)
  }

  animate()

  // ── Resize ──

  function onResize() {
    const w = container.clientWidth
    const h = container.clientHeight
    renderer.setSize(w, h)
    displayMat.uniforms.videoResolution.value.set(w, h)
    splatMat.uniforms.aspectRatio.value = w / h
  }

  const resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(container)

  // ── Cleanup ──

  function cleanup() {
    cancelAnimationFrame(animId)
    container.removeEventListener('mousemove', onMouseMove)
    resizeObserver.disconnect()
    video.pause()
    video.src = ''
    renderer.dispose()
    velocity.read.dispose()
    velocity.write.dispose()
    dye.read.dispose()
    dye.write.dispose()
    divergenceFBO.dispose()
    curlFBO.dispose()
    pressure.read.dispose()
    pressure.write.dispose()
    quadGeo.dispose()
    displayMat.dispose()
    advectionMat.dispose()
    divergenceMat.dispose()
    curlMat.dispose()
    vorticityMat.dispose()
    pressureMat.dispose()
    gradientSubtractMat.dispose()
    splatMat.dispose()
    videoTexture.dispose()
    if (renderer.domElement.parentElement) {
      renderer.domElement.parentElement.removeChild(renderer.domElement)
    }
  }

  return { cleanup, renderer, video }
}

// ─── React component ───────────────────────────────────────────────────────

export function DottedVideoBackground({
  className = '',
  config,
}: {
  className?: string
  config?: Partial<DottedVideoConfig>
}) {
  // React 19: emits <link rel="preload" as="video"> into SSR HTML so the
  // browser starts downloading the video before any JS executes.
  preload(VIDEO_SRC, { as: 'video' })

  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const engine = createDottedVideoEngine(container, {
      ...config,
    })

    return () => {
      engine.cleanup()
    }
  }, [])

  return <div ref={containerRef} className={className} />
}
