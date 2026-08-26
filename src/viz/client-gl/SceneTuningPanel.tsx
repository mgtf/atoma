import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  SCENE_TUNING_WIDTH,
  SCENE_TUNING_WINDOW_MARGIN,
  TUNING_IDENTITY,
  TUNING_KEYS,
  TUNING_RANGE,
  clampSceneTuningPosition,
  type SceneTuningPosition,
  type VizTuning,
} from './tuning.js';
import { readTuning, resetTuning, setTuningValue } from './tuning-live.js';
import { useGpuStore } from './store.js';

const DEFAULT_TOP = 64;

function initialPosition(): SceneTuningPosition {
  if (typeof window === 'undefined') {
    return { x: SCENE_TUNING_WINDOW_MARGIN, y: DEFAULT_TOP };
  }
  return {
    x: Math.max(
      SCENE_TUNING_WINDOW_MARGIN,
      window.innerWidth - SCENE_TUNING_WIDTH - SCENE_TUNING_WINDOW_MARGIN
    ),
    y: DEFAULT_TOP,
  };
}

function tuningSnapshot(): VizTuning {
  const current = readTuning();
  return Object.fromEntries(TUNING_KEYS.map((key) => [key, current[key]])) as unknown as VizTuning;
}

function formatValue(key: keyof VizTuning, value: number): string {
  const range = TUNING_RANGE[key];
  return `${value.toFixed(range.step < 1 ? 2 : 0)}${range.unit}`;
}

export function SceneTuningPanel() {
  const open = useGpuStore((state) => state.tuningPanelOpen);
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState(initialPosition);
  const [values, setValues] = useState(tuningSnapshot);

  const clamp = (next: SceneTuningPosition): SceneTuningPosition => {
    const rect = panelRef.current?.getBoundingClientRect();
    return clampSceneTuningPosition(
      next,
      window.innerWidth,
      window.innerHeight,
      rect?.width ?? SCENE_TUNING_WIDTH,
      rect?.height ?? 0
    );
  };

  useEffect(() => {
    if (!open) return;
    const resize = () => setPosition((current) => clamp(current));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [open]);

  if (!open) return null;

  const startMove = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    setPosition(clamp({
      x: event.clientX - drag.current.offsetX,
      y: event.clientY - drag.current.offsetY,
    }));
  };

  const stopMove = (event: ReactPointerEvent<HTMLElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <aside
      ref={panelRef}
      className="gpu-panel-skin gpu-scene-tuning"
      aria-label="Scene tuning"
      style={{ left: position.x, top: position.y }}
    >
      <header
        className="gpu-scene-tuning__header"
        onPointerDown={startMove}
        onPointerMove={move}
        onPointerUp={stopMove}
        onPointerCancel={stopMove}
      >
        <strong>SCENE TUNING</strong>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            resetTuning();
            setValues({ ...TUNING_IDENTITY });
          }}
        >
          RESET
        </button>
      </header>
      <div className="gpu-scene-tuning__rows">
        {TUNING_KEYS.map((key) => {
          const range = TUNING_RANGE[key];
          return (
            <div key={key} className="gpu-scene-tuning__row">
              <label htmlFor={`scene-tuning-${key}`}>{range.label}</label>
              <input
                id={`scene-tuning-${key}`}
                name={key}
                type="range"
                min={range.min}
                max={range.max}
                step={range.step}
                value={values[key]}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setTuningValue(key, value);
                  setValues((current) => ({ ...current, [key]: value }));
                }}
              />
              <output>{formatValue(key, values[key])}</output>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
