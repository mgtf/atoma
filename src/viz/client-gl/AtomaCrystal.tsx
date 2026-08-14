import { Canvas, useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';

function CrystalMesh({ animate }: { animate: boolean }) {
  const mesh = useRef<Group>(null);
  useFrame((_state, delta) => {
    if (!mesh.current || !animate) return;
    mesh.current.rotation.y += delta * 0.12;
    mesh.current.rotation.x = 0.42 + Math.sin(Date.now() / 9000) * 0.05;
  });
  return (
    <group ref={mesh} rotation={[0.42, 0.55, 0.12]}>
      <mesh>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color="#0f766e"
          emissive="#2dd4bf"
          emissiveIntensity={0.28}
          roughness={0.28}
          metalness={0.42}
        />
      </mesh>
      <mesh position={[0.02, 0.04, 0.02]} scale={[0.98, 0.98, 0.98]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color="#7c3aed"
          emissive="#a78bfa"
          emissiveIntensity={0.18}
          transparent
          opacity={0.42}
          roughness={0.22}
          metalness={0.35}
        />
      </mesh>
      <mesh>
        <octahedronGeometry args={[0.28, 0]} />
        <meshStandardMaterial
          color="#f8fbff"
          emissive="#22d3ee"
          emissiveIntensity={0.7}
          roughness={0.12}
          metalness={0.2}
        />
      </mesh>
    </group>
  );
}

export function AtomaCrystal() {
  const animate =
    typeof matchMedia !== 'undefined' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <div className="gpu-brand-mark" aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 3.2], fov: 36 }}
        dpr={[1, 1.5]}
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      >
        <ambientLight intensity={0.7} />
        <pointLight position={[2.2, 2.4, 3]} intensity={18} color="#6ea8ff" />
        <pointLight position={[-2, -1.2, 1.5]} intensity={8} color="#f59e0b" />
        <CrystalMesh animate={animate} />
      </Canvas>
    </div>
  );
}
