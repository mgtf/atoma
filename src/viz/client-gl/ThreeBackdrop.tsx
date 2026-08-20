import { Canvas, useFrame } from '@react-three/fiber';
import { memo, useMemo, useRef } from 'react';
import {
  MathUtils,
  PointLight,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type Group,
} from 'three';
import { buildAtomMap, coerceEventFilters, type EventFilters } from '../client/run-utils.js';
import type { VizRun } from '../client/types.js';
import type { GpuTimelineViewport } from './gpu-renderer.js';
import { pointerClientToUv, readPointerLight } from './pointer-light.js';
import { readMarkFieldLight } from './mark-field-light.js';
import { RunsTimelineRails } from './RunsTimelineRails.js';
import type { ViewName } from './store.js';
import { VIZ_VISUAL_DEPTH } from './visual-depth.js';

const TIER_COLORS = {
  1: '#2dd4bf',
  2: '#fbbf24',
  3: '#c084fc',
} as const;

export const BACKDROP_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vScreenUv;
  void main() {
    vUv = uv;
    vec4 clipPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = clipPosition;
    vScreenUv = clipPosition.xy / clipPosition.w * 0.5 + 0.5;
  }
`;

export const BACKDROP_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec2 uPointerUv;
  uniform float uPointerStrength;
  uniform vec4 uMark0;
  uniform vec4 uMark1;
  uniform vec4 uMark2;
  uniform vec4 uMark3;
  uniform vec3 uMarkColor0;
  uniform vec3 uMarkColor1;
  uniform vec3 uMarkColor2;
  uniform vec3 uMarkColor3;
  varying vec2 vUv;
  varying vec2 vScreenUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p = p * 2.03 + vec2(13.7, 9.2);
      amplitude *= 0.5;
    }
    return value;
  }

  vec3 stainedField(vec2 screenUv, vec2 resolution, vec4 mark, vec3 tint) {
    if (mark.z < 0.001) return vec3(0.0);
    vec2 delta = (screenUv - mark.xy) * resolution;
    float dist = length(delta) / max(mark.w, 1.0);
    float halo = exp(-3.2 * dist * dist);
    float core = exp(-8.0 * dist * dist);
    // A tint on the wall, not a lamp. The previous 0.82+0.55 core blew the
    // welcome field out to a teal spotlight; keep a readable stain.
    return tint * mark.z * ${VIZ_VISUAL_DEPTH.far.markGain.toFixed(2)} *
      (halo * 0.48 + core * 0.18);
  }

  void main() {
    float aspect = uResolution.x / max(1.0, uResolution.y);
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    float t = uTime * ${VIZ_VISUAL_DEPTH.far.motionRate.toFixed(3)};

    float fieldA = fbm(p * 3.2 + vec2(t, -t * 0.7));
    float fieldB = fbm(p * 5.6 - vec2(t * 0.8, t));
    float aurora = smoothstep(0.25, 0.9, fieldA * 0.8 + fieldB * 0.42);

    vec2 gridUv = abs(fract((p + 0.5) * ${VIZ_VISUAL_DEPTH.far.gridFrequency.toFixed(1)}) - 0.5) /
      fwidth(p * ${VIZ_VISUAL_DEPTH.far.gridFrequency.toFixed(1)});
    float grid = 1.0 - min(min(gridUv.x, gridUv.y), 1.0);
    grid *= 0.022 + 0.016 * sin(uTime * 0.24 + p.y * 20.0);

    float radial = exp(-2.7 * dot(p, p));
    float scan = pow(max(0.0, sin((p.y + t) * 42.0)), 28.0) * 0.055;
    float star = step(0.9975, hash(floor((p + t * 0.04) * 150.0)));

    vec3 navy = vec3(0.012, 0.025, 0.065);
    vec3 blue = vec3(0.055, 0.26, 0.58);
    vec3 cyan = vec3(0.08, 0.72, 0.78);
    vec3 violet = vec3(0.38, 0.12, 0.72);
    vec3 color = navy;
    color += mix(blue, violet, fieldB) * aurora * 0.2;
    color += cyan * radial * (0.042 + fieldA * 0.03);
    color += vec3(0.28, 0.52, 0.9) * grid;
    color += cyan * scan * 0.72;
    color += vec3(0.7, 0.86, 1.0) * star * 0.21;
    color = mix(navy, color, ${VIZ_VISUAL_DEPTH.far.colorGain.toFixed(2)});

    vec2 pointerDelta = (vScreenUv - uPointerUv) * uResolution;
    float pointerDistance = length(pointerDelta);
    float pointerHalo = exp(-2.2 * pow(pointerDistance / ${VIZ_VISUAL_DEPTH.far.pointerHaloRadius.toFixed(1)}, 2.0));
    float pointerCore = exp(-2.8 * pow(pointerDistance / ${VIZ_VISUAL_DEPTH.far.pointerCoreRadius.toFixed(1)}, 2.0));
    float relief = clamp(abs(dFdx(fieldA)) + abs(dFdy(fieldA)) + abs(dFdx(fieldB)), 0.0, 0.55);
    vec3 pointerTint = mix(vec3(0.24, 0.58, 1.0), vec3(0.82, 0.96, 1.0), pointerCore);
    // A pool on the wall, not a second lamp. Relief-only at 0.03 vanished
    // next to the crystal; a modest halo+core is the cursor lighting the field.
    color += pointerTint * uPointerStrength * ${VIZ_VISUAL_DEPTH.far.pointerGain.toFixed(2)} *
      (pointerHalo * (0.14 + relief * 0.18) + pointerCore * 0.10);

    // Stained lantern light. The bead's output through a rear face lands HERE,
    // on the plane that faces the camera, not on a disc under the gem in Pixi.
    color += stainedField(vScreenUv, uResolution, uMark0, uMarkColor0);
    color += stainedField(vScreenUv, uResolution, uMark1, uMarkColor1);
    color += stainedField(vScreenUv, uResolution, uMark2, uMarkColor2);
    color += stainedField(vScreenUv, uResolution, uMark3, uMarkColor3);

    float vignette = smoothstep(1.0, 0.12, length(p));
    gl_FragColor = vec4(
      color * (0.62 + vignette * 0.38),
      ${VIZ_VISUAL_DEPTH.far.alpha.toFixed(2)}
    );
  }
`;

function ShaderField({ animate }: { animate: boolean }) {
  const material = useRef<ShaderMaterial>(null);
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    uPointerUv: { value: new Vector2(-2, -2) },
    uPointerStrength: { value: 0 },
    uMark0: { value: new Vector4(0, 0, 0, 1) },
    uMark1: { value: new Vector4(0, 0, 0, 1) },
    uMark2: { value: new Vector4(0, 0, 0, 1) },
    uMark3: { value: new Vector4(0, 0, 0, 1) },
    uMarkColor0: { value: new Vector3() },
    uMarkColor1: { value: new Vector3() },
    uMarkColor2: { value: new Vector3() },
    uMarkColor3: { value: new Vector3() },
  }), []);

  useFrame((state, delta) => {
    if (!material.current) return;
    if (animate) material.current.uniforms['uTime']!.value = state.clock.elapsedTime;
    material.current.uniforms['uResolution']!.value.set(
      state.size.width,
      state.size.height
    );
    const pointer = readPointerLight();
    const pointerUv = pointerClientToUv(
      pointer.clientX,
      pointer.clientY,
      state.size.width,
      state.size.height
    );
    material.current.uniforms['uPointerUv']!.value.set(pointerUv.x, pointerUv.y);
    material.current.uniforms['uPointerStrength']!.value = MathUtils.damp(
      material.current.uniforms['uPointerStrength']!.value,
      pointer.active ? 1 : 0,
      14,
      delta
    );
    const lantern = readMarkFieldLight();
    const markUniforms = [
      material.current.uniforms['uMark0']!.value as Vector4,
      material.current.uniforms['uMark1']!.value as Vector4,
      material.current.uniforms['uMark2']!.value as Vector4,
      material.current.uniforms['uMark3']!.value as Vector4,
    ];
    const markColors = [
      material.current.uniforms['uMarkColor0']!.value as Vector3,
      material.current.uniforms['uMarkColor1']!.value as Vector3,
      material.current.uniforms['uMarkColor2']!.value as Vector3,
      material.current.uniforms['uMarkColor3']!.value as Vector3,
    ];
    for (let index = 0; index < 4; index += 1) {
      const spill = lantern[index];
      if (!spill) {
        markUniforms[index]!.z = 0;
        continue;
      }
      const uv = pointerClientToUv(
        spill.clientX,
        spill.clientY,
        state.size.width,
        state.size.height
      );
      markUniforms[index]!.set(uv.x, uv.y, spill.intensity, spill.radiusPx);
      markColors[index]!.set(spill.r, spill.g, spill.b);
    }
  });

  return (
    <mesh
      position={[0, 0, VIZ_VISUAL_DEPTH.far.fieldZ]}
      scale={[...VIZ_VISUAL_DEPTH.far.fieldScale, 1]}
      frustumCulled={false}
      renderOrder={-100}
    >
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        ref={material}
        vertexShader={BACKDROP_VERTEX_SHADER}
        fragmentShader={BACKDROP_FRAGMENT_SHADER}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        depthTest={false}
      />
    </mesh>
  );
}

function PointerPointLight({ intensity }: { intensity: number }) {
  const light = useRef<PointLight>(null);
  const cursorWorld = useMemo(() => new Vector3(), []);
  const rayPoint = useMemo(() => new Vector3(), []);
  const rayDirection = useMemo(() => new Vector3(), []);

  useFrame((state, delta) => {
    const current = light.current;
    if (!current) return;
    const pointer = readPointerLight();
    current.intensity = MathUtils.damp(
      current.intensity,
      pointer.active ? intensity : 0,
      16,
      delta
    );
    if (!pointer.active && current.intensity < 0.002) {
      current.intensity = 0;
      return;
    }

    rayPoint.set(
      pointer.clientX / Math.max(1, state.size.width) * 2 - 1,
      1 - pointer.clientY / Math.max(1, state.size.height) * 2,
      0.2
    ).unproject(state.camera);
    rayDirection.copy(rayPoint).sub(state.camera.position).normalize();
    const distanceToPlane = (0 - state.camera.position.z) / rayDirection.z;
    cursorWorld.copy(state.camera.position).addScaledVector(rayDirection, distanceToPlane);
    current.position.set(cursorWorld.x, cursorWorld.y, 4);
  });

  return (
    <pointLight
      ref={light}
      color="#a6e4ff"
      intensity={0}
      distance={14}
      decay={2}
    />
  );
}

function TierTopology({ run, animate }: { run: VizRun | null; animate: boolean }) {
  const group = useRef<Group>(null);
  const nodes = useMemo(() => {
    const source = run ? [...buildAtomMap(run).values()].map((entry) => entry.snapshot) : [];
    return source.slice(0, 32).map((atom, index) => {
      const peers = source.filter((item) => item.tier === atom.tier);
      const peerIndex = peers.findIndex((item) => item.name === atom.name);
      const spread = Math.max(1, peers.length - 1);
      return {
        id: atom.name,
        tier: atom.tier,
        x: (peerIndex / spread - 0.5) * 13,
        y: (atom.tier - 2) * 3.3,
        z: Math.sin(index * 1.7) * 1.2,
      };
    });
  }, [run]);

  useFrame((state) => {
    if (!group.current || !animate) return;
    group.current.rotation.y =
      Math.sin(state.clock.elapsedTime * 0.08) *
      VIZ_VISUAL_DEPTH.far.topologyYawAmplitude;
    group.current.rotation.x =
      VIZ_VISUAL_DEPTH.far.topologyPitch +
      Math.sin(state.clock.elapsedTime * 0.075) *
      VIZ_VISUAL_DEPTH.far.topologyPitchAmplitude;
  });

  return (
    <group
      ref={group}
      position={[0, 0, VIZ_VISUAL_DEPTH.far.topologyZ]}
      rotation={[VIZ_VISUAL_DEPTH.far.topologyPitch, 0, 0]}
    >
      {([1, 2, 3] as const).map((tier) => (
        <mesh key={`rail-${tier}`} position={[0, (tier - 2) * 3.3, -1.2]}>
          <boxGeometry args={[15, 0.018, 0.018]} />
          <meshBasicMaterial color={TIER_COLORS[tier]} transparent opacity={0.16} />
        </mesh>
      ))}
      {nodes.map((node) => (
        <group key={node.id} position={[node.x, node.y, node.z]}>
          <mesh>
            <icosahedronGeometry args={[node.tier === 3 ? 0.34 : 0.22, 1]} />
            <meshStandardMaterial
              color={TIER_COLORS[node.tier as 1 | 2 | 3]}
              emissive={TIER_COLORS[node.tier as 1 | 2 | 3]}
              emissiveIntensity={0.45}
              transparent
              opacity={0.48}
              roughness={0.35}
              metalness={0.25}
            />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[node.tier === 3 ? 0.5 : 0.34, 0.012, 8, 32]} />
            <meshBasicMaterial
              color={TIER_COLORS[node.tier as 1 | 2 | 3]}
              transparent
              opacity={0.18}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function ThreeBackdropImpl({
  run,
  view,
  entered,
  runFilters,
  timelineViewport,
}: {
  run: VizRun | null;
  view: ViewName;
  entered: boolean;
  runFilters: EventFilters;
  timelineViewport: GpuTimelineViewport | null;
}) {
  const animate =
    typeof matchMedia !== 'undefined' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <div className="three-backdrop" aria-hidden="true">
      <Canvas
        events={() => ({ enabled: false, priority: 1 })}
        camera={{ position: [0, 0, 15], fov: 42 }}
        dpr={[1, 1.5]}
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      >
        <ambientLight intensity={0.38} />
        <pointLight position={[3, 7, 9]} intensity={8} color="#6ea8ff" />
        <PointerPointLight
          intensity={
            entered && view === 'runs'
              ? VIZ_VISUAL_DEPTH.mid.pointerIntensity
              : VIZ_VISUAL_DEPTH.far.topologyPointerIntensity
          }
        />
        <ShaderField animate={animate} />
        {entered && view === 'runs' ? (
          <RunsTimelineRails
            run={run}
            filters={run ? coerceEventFilters(run.events, runFilters) : runFilters}
            timelineViewport={timelineViewport}
            animate={animate}
          />
        ) : entered ? (
          <TierTopology run={run} animate={animate} />
        ) : null}
      </Canvas>
    </div>
  );
}

/**
 * MEMOISED, and every prop is reference-stable by construction: `GpuApp`
 * subscribes to the whole store, so any `set()` — a wheel tick above all —
 * re-runs its body. Without this the R3F tree is reconciled on every scroll
 * for a backdrop whose inputs did not move. `run` is stable through
 * react-query's structural sharing, `runFilters` through the store, and
 * `timelineViewport` through `sameTimelineViewport` in `GpuApp`.
 */
export const ThreeBackdrop = memo(ThreeBackdropImpl);
