import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group } from 'three';
import type { VizRun } from '../client/types.js';

const TIER_COLORS = {
  1: '#2dd4bf',
  2: '#fbbf24',
  3: '#c084fc',
} as const;

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
        <TierTopology run={run} animate={animate} />
      </Canvas>
    </div>
  );
}
