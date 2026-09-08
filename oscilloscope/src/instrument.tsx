"use client";

// Image-textured hardware controls and a live, projected phosphor signal.
import { useEffect, useRef, useState, type ReactNode } from "react";

function Screws({ side = false }: { side?: boolean }) {
  return (
    <div className="screws" aria-hidden="true" data-side={side}>
      {Array.from({ length: side ? 12 : 4 }, (_, i) => (
        <i className="screw" key={i} />
      ))}
    </div>
  );
}

function Plate({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={["plate", className].filter(Boolean).join(" ")}
      aria-label={title}
    >
      <Screws />
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

function Toggle({
  label,
  left,
  right,
  value,
  onChange,
}: {
  label: string;
  left: string;
  right: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <div className="toggle-row">
      <span>{left}</span>
      <button
        className="toggle"
        role="switch"
        aria-label={label}
        aria-checked={value}
        onClick={onChange}
        title={`${label}: ${value ? right : left}`}
      />
      <span>{right}</span>
    </div>
  );
}

function Lamp({
  label,
  lit,
  onClick,
  red = false,
}: {
  label: string;
  lit: boolean;
  onClick: () => void;
  red?: boolean;
}) {
  return (
    <button
      className="lamp-control"
      aria-label={label}
      aria-pressed={lit}
      data-lit={lit}
      data-color={red ? "red" : "amber"}
      onClick={onClick}
    >
      <span className="lamp" />
      <span>{label === "Trigger" ? "" : label}</span>
    </button>
  );
}

type Channel = {
  ac: boolean;
  ground: boolean;
  attenuate: boolean;
  down: boolean;
  volt: boolean;
};
const initialChannel: Channel = {
  ac: false,
  ground: false,
  attenuate: false,
  down: false,
  volt: false,
};

function SidePanel({
  name,
  value,
  onChange,
}: {
  name: string;
  value: Channel;
  onChange: (key: keyof Channel) => void;
}) {
  const controls: {
    label: string;
    left: string;
    right: string;
    key: keyof Channel;
  }[] = [
    { label: "VERTICAL", left: "DC", right: "AC", key: "ac" },
    { label: "COUPLING", left: "GND", right: "AC", key: "ground" },
    { label: "INPUT", left: "1X", right: "10X", key: "attenuate" },
    { label: "POSITION", left: "UP", right: "DOWN", key: "down" },
    { label: "VOLT/DIV", left: "0.5", right: "1", key: "volt" },
  ];
  return (
    <section className="plate side-panel" aria-label={`Channel ${name}`}>
      <Screws side />
      {controls.map((control) => (
        <div className="switch-control" key={control.key}>
          <h3>
            {control.label} {name}
          </h3>
          <Toggle
            left={control.left}
            right={control.right}
            label={`${control.label} ${name}`}
            value={
              control.key === "ground" ? !value.ground : value[control.key]
            }
            onChange={() => onChange(control.key)}
          />
        </div>
      ))}
    </section>
  );
}

type Signal = {
  power: boolean;
  run: boolean;
  square: boolean;
  external: boolean;
  normal: boolean;
  displayB: boolean;
  delay: boolean;
  horizontal: boolean;
  frequency: number;
  trigger: number;
  a: Channel;
  b: Channel;
};

function Trace({ signal }: { signal: Signal }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clock = useRef(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let frame = 0;
    let previous = 0;
    const draw = (now: number) => {
      const elapsed = previous ? Math.min(now - previous, 50) : 0;
      previous = now;
      if (signal.run && signal.power && !signal.normal)
        clock.current += elapsed * (signal.external ? 0.000035 : 0.0001);
      const w = 800,
        h = 570;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.strokeStyle = signal.power ? "#51846a" : "#1b3425";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([1, 9]);
      for (let x = 24; x < w; x += 78) {
        ctx.beginPath();
        ctx.moveTo(x, 20);
        ctx.lineTo(x, h - 20);
        ctx.stroke();
      }
      for (let y = 76; y < h; y += 70) {
        ctx.beginPath();
        ctx.moveTo(22, y);
        ctx.lineTo(w - 22, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = signal.power ? "#39745b" : "#142c20";
      ctx.beginPath();
      ctx.moveTo(w / 2, 15);
      ctx.lineTo(w / 2, h - 15);
      ctx.moveTo(15, h / 2);
      ctx.lineTo(w - 15, h / 2);
      for (let x = 20; x < w; x += 16) {
        ctx.moveTo(x, h / 2 - 5);
        ctx.lineTo(x, h / 2 + 5);
      }
      for (let y = 20; y < h; y += 10) {
        ctx.moveTo(w / 2 - 5, y);
        ctx.lineTo(w / 2 + 5, y);
      }
      ctx.stroke();
      if (signal.power) {
        const phase =
          clock.current + signal.trigger * 0.7 + (signal.delay ? 1.2 : 0);
        const angle = 0.45 + phase * 0.16;
        const a = signal.displayB ? signal.b : signal.a;
        const b = signal.displayB ? signal.a : signal.b;
        const gainA = (a.volt ? 0.68 : 1) * (a.attenuate ? 0.45 : 1);
        const gainB = (b.volt ? 0.68 : 1) * (b.attenuate ? 0.45 : 1);
        ctx.beginPath();
        for (let i = 0; i <= 2200; i++) {
          const t = (i / 2200) * Math.PI * 16;
          const radius = 0.65 + 0.34 * Math.cos(t * 0.23 + phase);
          const wave = (v: number) =>
            signal.square ? Math.tanh(Math.sin(v) * 5) : Math.sin(v);
          const x = wave(t * (1 + signal.frequency * 0.003)) * radius * 290;
          const y = wave(t * 1.25 + 0.9 + phase) * radius * 150;
          const z = Math.cos(t * 0.75 + phase) * 110;
          const px =
            w / 2 +
            (a.ground
              ? 0
              : (x * Math.cos(angle) + z * Math.sin(angle)) * gainA) +
            (signal.horizontal ? 50 : 0) +
            (a.ac ? 22 : 0);
          const py =
            h / 2 +
            (b.ground ? 0 : (y * Math.cos(0.4) - z * Math.sin(0.4)) * gainB) +
            (a.down ? 55 : 0) -
            (b.down ? 55 : 0) +
            (b.ac ? 20 : 0);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = "#a6e9a2";
        ctx.lineWidth = 5;
        ctx.shadowColor = "#8af78e";
        ctx.shadowBlur = 18;
        ctx.globalAlpha = 0.14;
        ctx.stroke();
        ctx.strokeStyle = "#eaffd9";
        ctx.lineWidth = 3.1;
        ctx.shadowBlur = 4;
        ctx.globalAlpha = 0.95;
        ctx.stroke();
      }
      ctx.restore();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [signal]);
  return (
    <div className="bezel">
      <div className="screen-recess">
        <div className="crt" data-powered={signal.power}>
          <canvas
            className="trace-canvas"
            ref={canvasRef}
            width={800}
            height={570}
            aria-label={
              signal.power
                ? `${signal.square ? "Square" : "Sine"} signal, ${signal.run ? "running" : "stopped"}, tuning ${signal.frequency}`
                : "Display powered off"
            }
            role="img"
          />
          <div className="glass" />
        </div>
      </div>
    </div>
  );
}

export function Instrument() {
  const [signal, setSignal] = useState<Signal>({
    power: true,
    run: true,
    square: false,
    external: false,
    normal: false,
    displayB: false,
    delay: false,
    horizontal: false,
    frequency: 0,
    trigger: 0,
    a: initialChannel,
    b: initialChannel,
  });
  const toggle = (
    key: "power" | "external" | "normal" | "displayB" | "horizontal",
  ) => setSignal((s) => ({ ...s, [key]: !s[key] }));
  const channel = (name: "a" | "b", key: keyof Channel) =>
    setSignal((s) => ({ ...s, [name]: { ...s[name], [key]: !s[name][key] } }));
  return (
    <main className="stage flex min-h-svh items-center justify-center">
      <h1 className="sr-only">Interactive analog oscilloscope</h1>
      <article
        className="instrument select-none"
        aria-label="Analog oscilloscope"
      >
        <div className="face">
          <div className="top-row">
            <Plate title="POWER">
              <Toggle
                label="Power"
                left="OFF"
                right="ON"
                value={signal.power}
                onChange={() => toggle("power")}
              />
            </Plate>
            <Plate title="WAVEFORM">
              <div className="lamp-pair">
                <Lamp
                  label="SINE"
                  lit={!signal.square && signal.power}
                  onClick={() => setSignal((s) => ({ ...s, square: false }))}
                />
                <Lamp
                  label="SQUARE"
                  lit={signal.square && signal.power}
                  onClick={() => setSignal((s) => ({ ...s, square: true }))}
                />
              </div>
            </Plate>
            <Plate title="SYNC">
              <Toggle
                label="Sync"
                left="INT"
                right="EXT"
                value={signal.external}
                onChange={() => toggle("external")}
              />
            </Plate>
            <Plate title="TRIGGER">
              <Lamp
                label="Trigger"
                red
                lit={signal.power}
                onClick={() =>
                  setSignal((s) => ({ ...s, trigger: s.trigger + 1 }))
                }
              />
            </Plate>
            <Plate title="MODE">
              <Toggle
                label="Mode"
                left="AUTO"
                right="NORM"
                value={signal.normal}
                onChange={() => toggle("normal")}
              />
            </Plate>
            <Plate title="DISPLAY">
              <Toggle
                label="Display"
                left="A"
                right="B"
                value={signal.displayB}
                onChange={() => toggle("displayB")}
              />
            </Plate>
          </div>
          <SidePanel
            name="A"
            value={signal.a}
            onChange={(key) => channel("a", key)}
          />
          <div className="center-column">
            <Trace signal={signal} />
            <div className="bottom-row">
              <Plate title="TIME/DIV">
                <div className="lamp-pair">
                  <Lamp
                    label="MAIN"
                    lit={!signal.delay && signal.power}
                    onClick={() => setSignal((s) => ({ ...s, delay: false }))}
                  />
                  <Lamp
                    label="DELAY"
                    lit={signal.delay && signal.power}
                    onClick={() => setSignal((s) => ({ ...s, delay: true }))}
                  />
                </div>
              </Plate>
              <Plate title="HORIZONTAL">
                <Toggle
                  label="Horizontal"
                  left="MAIN"
                  right="DELAY"
                  value={signal.horizontal}
                  onChange={() => toggle("horizontal")}
                />
              </Plate>
              <Plate title="RUN CONTROL">
                <div className="lamp-pair">
                  <Lamp
                    label="RUN"
                    lit={signal.run && signal.power}
                    onClick={() => setSignal((s) => ({ ...s, run: true }))}
                  />
                  <Lamp
                    label="STOP"
                    lit={!signal.run && signal.power}
                    onClick={() => setSignal((s) => ({ ...s, run: false }))}
                  />
                </div>
              </Plate>
            </div>
          </div>
          <SidePanel
            name="B"
            value={signal.b}
            onChange={(key) => channel("b", key)}
          />
        </div>
        <Plate className="base-plate">
          <label
            className="dial"
            title="Drag to tune the signal. Arrow keys for fine adjustment."
          >
            <span
              className="dial-grip"
              aria-hidden="true"
              style={{ transform: `rotate(${signal.frequency * 1.5}deg)` }}
            />
            <input
              className="dial-input"
              type="range"
              aria-label="Signal tuning"
              min={-100}
              max={100}
              value={signal.frequency}
              onChange={(event) =>
                setSignal((s) => ({
                  ...s,
                  frequency: Number(event.target.value),
                }))
              }
            />
          </label>
        </Plate>
      </article>
    </main>
  );
}
