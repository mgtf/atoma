import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  ShaderMaterial,
  Vector2,
  type Group,
} from 'three';
import type { VizRun } from '../client/types.js';

const TIER_COLORS = {
  1: '#2dd4bf',
  2: '#fbbf24',
  3: '#c084fc',
} as const;

export const BACKDROP_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const BACKDROP_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec2 uResolution;
  varying vec2 vUv;

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

  void main() {
    float aspect = uResolution.x / max(1.0, uResolution.y);
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    float t = uTime * 0.055;

    float fieldA = fbm(p * 3.2 + vec2(t, -t * 0.7));
    float fieldB = fbm(p * 5.6 - vec2(t * 0.8, t));
    float aurora = smoothstep(0.25, 0.9, fieldA * 0.8 + fieldB * 0.42);

    vec2 gridUv = abs(fract((p + 0.5) * 18.0) - 0.5) / fwidth(p * 18.0);
    float grid = 1.0 - min(min(gridUv.x, gridUv.y), 1.0);
    grid *= 0.035 + 0.025 * sin(uTime * 0.35 + p.y * 20.0);

    float radial = exp(-2.7 * dot(p, p));
    float scan = pow(max(0.0, sin((p.y + t) * 42.0)), 28.0) * 0.055;
    float star = step(0.9975, hash(floor((p + t * 0.04) * 150.0)));

    vec3 navy = vec3(0.012, 0.025, 0.065);
    vec3 blue = vec3(0.055, 0.26, 0.58);
    vec3 cyan = vec3(0.08, 0.72, 0.78);
    vec3 violet = vec3(0.38, 0.12, 0.72);
    vec3 color = navy;
    color += mix(blue, violet, fieldB) * aurora * 0.24;
    color += cyan * radial * (0.055 + fieldA * 0.04);
    color += vec3(0.28, 0.52, 0.9) * grid;
    color += cyan * scan;
    color += vec3(0.7, 0.86, 1.0) * star * 0.32;

    float vignette = smoothstep(1.0, 0.12, length(p));
    gl_FragColor = vec4(color * (0.62 + vignette * 0.38), 0.82);
  }
`;

function ShaderField({ animate }: { animate: boolean }) {
  const material = useRef<ShaderMaterial>(null);
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
  }), []);

  useFrame((state) => {
    if (!material.current) return;
    if (animate) material.current.uniforms['uTime']!.value = state.clock.elapsedTime;
    material.current.uniforms['uResolution']!.value.set(
      state.size.width * state.viewport.dpr,
      state.size.height * state.viewport.dpr
    );
  });

  return (
    <mesh position={[0, 0, -4]} scale={[30, 18, 1]} frustumCulled={false} renderOrder={-100}>
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

function TierTopology({ run, animate }: { run: VizRun | null; animate: boolean }) {
  const group = useRef<Group>(null);
  const nodes = useMemo(() => {
    const source = run?.initialTypes ?? [];
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

  useFrame((_state, delta) => {
    if (!group.current || !animate) return;
    group.current.rotation.y += delta * 0.025;
    group.current.rotation.x = Math.sin(Date.now() / 12_000) * 0.035;
  });

  return (
    <group ref={group} rotation={[-0.08, -0.15, 0]}>
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

export function ThreeBackdrop({ run }: { run: VizRun | null }) {
  const animate =
    typeof matchMedia !== 'undefined' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <div className="three-backdrop" aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 15], fov: 42 }}
        dpr={[1, 1.5]}
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      >
        <ambientLight intensity={0.4} />
        <pointLight position={[3, 7, 9]} intensity={18} color="#6ea8ff" />
        <ShaderField animate={animate} />
        <TierTopology run={run} animate={animate} />
      </Canvas>
    </div>
  );
}
