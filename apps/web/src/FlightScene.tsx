import { Canvas, useFrame } from '@react-three/fiber';
import { useRef, type MutableRefObject } from 'react';
import { Group, Quaternion, Vector3 } from 'three';
import { wallNow } from '@mirage/protocol';
import type { SimulationRuntime } from './runtime';
import { nedToRenderBasis } from './coordinates';

function Vehicle({ runtime }: { runtime: MutableRefObject<SimulationRuntime | null> }) {
  const model = useRef<Group>(null);
  const q0 = useRef(new Quaternion());
  const q1 = useRef(new Quaternion());
  const target = useRef(new Vector3());
  // NED -> Three: (north,east,down) -> (east,-down,-north).
  // The basis is a proper rotation (det +1), preserving quaternion handedness.
  const basis = useRef(nedToRenderBasis());
  const inverseBasis = useRef(basis.current.clone().invert());
  useFrame(({ camera }) => {
    const sim = runtime.current;
    if (!sim || !model.current) return;
    const a = sim.previous, b = sim.current;
    // latestPair sets previous = current unless they are adjacent ticks of one epoch/model.
    const stepMs = 1000 / (sim.header.physicsHz || 400);
    const t = sim.running && sim.history === 'pair' ? Math.max(0, Math.min(1, (wallNow() - b.scheduledWallTimeMs) / stepMs)) : 1;
    const north = a.northM + (b.northM - a.northM) * t;
    const east = a.eastM + (b.eastM - a.eastM) * t;
    const down = a.downM + (b.downM - a.downM) * t;
    model.current.position.set(east, -down + 0.28, -north);
    q0.current.set(a.qx, a.qy, a.qz, a.qw);
    q1.current.set(b.qx, b.qy, b.qz, b.qw);
    model.current.quaternion.copy(basis.current).multiply(q0.current.slerp(q1.current, t)).multiply(inverseBasis.current);
    target.current.copy(model.current.position);
    camera.position.set(east + 4.2, -down + 3.1, -north + 5.2);
    camera.lookAt(target.current);
  });
  return <group ref={model}>
    <mesh castShadow><boxGeometry args={[0.35, 0.16, 0.5]} /><meshStandardMaterial color="#d2e5ec" metalness={0.65} roughness={0.3} /></mesh>
    <mesh rotation={[0, Math.PI / 4, 0]} castShadow><boxGeometry args={[1.25, 0.055, 0.07]} /><meshStandardMaterial color="#263845" /></mesh>
    <mesh rotation={[0, -Math.PI / 4, 0]} castShadow><boxGeometry args={[1.25, 0.055, 0.07]} /><meshStandardMaterial color="#263845" /></mesh>
    {[-1, 1].flatMap(x => [-1, 1].map(z => <group key={`${x}/${z}`} position={[x * 0.43, 0.06, z * 0.43]}>
      <mesh><cylinderGeometry args={[0.075, 0.075, 0.09, 16]} /><meshStandardMaterial color={z < 0 ? '#49debb' : '#ec805c'} /></mesh>
      <mesh position={[0, 0.055, 0]}><cylinderGeometry args={[0.25, 0.25, 0.009, 32]} /><meshStandardMaterial color="#8bb5c3" transparent opacity={0.34} /></mesh>
    </group>))}
    <mesh position={[0, 0.02, -0.3]}><sphereGeometry args={[0.04, 12, 8]} /><meshBasicMaterial color="#4effc6" /></mesh>
  </group>;
}
export function FlightScene({ runtime }: { runtime: MutableRefObject<SimulationRuntime | null> }) {
  return <Canvas shadows dpr={[1, 1.5]} camera={{ position: [4, 3, 5], fov: 48, near: 0.05, far: 2000 }}
    gl={{ antialias: true, powerPreference: 'high-performance' }}>
    <color attach="background" args={['#111e29']} />
    <fog attach="fog" args={['#111e29', 30, 120]} />
    <ambientLight intensity={1.1} />
    <directionalLight position={[6, 12, 4]} intensity={2.2} castShadow shadow-mapSize={[1024, 1024]} />
    <gridHelper args={[200, 200, '#5d929a', '#345b69']} position={[0, 0.01, 0]} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
      <ringGeometry args={[1.15, 1.18, 64]} /><meshBasicMaterial color="#70c4b1" transparent opacity={0.55} />
    </mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
      <planeGeometry args={[2000, 2000]} /><meshStandardMaterial color="#14232d" roughness={1} />
    </mesh>
    <Vehicle runtime={runtime} />
  </Canvas>;
}
