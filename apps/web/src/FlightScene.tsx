import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type RefObject } from 'react';
import type { TilesScene } from '@mirage/terrain/tiles-scene';
import type { TileFailure } from '@mirage/terrain/tiles-provider';
import type { TerrainConfig } from './terrain-config';
import { Group, Quaternion, Vector3 } from 'three';
import { interpolatePoseInto, interpolationAlpha, newRenderPoseV2, wallNow } from '@mirage/protocol';
import type { SimulationRuntime } from './runtime';
import { nedToRenderBasis, nedToRenderPositionInto } from './coordinates';

const MODEL_HEIGHT_OFFSET_M = 0.28; // hub height of the demo mesh above its NED reference point

function Vehicle({ runtime }: { runtime: RefObject<SimulationRuntime | null> }) {
  const model = useRef<Group>(null);
  const pose = useRef(newRenderPoseV2());
  const attitude = useRef(new Quaternion());
  const target = useRef(new Vector3());
  // NED -> Three: (north,east,down) -> (east,-down,-north).
  // The basis is a proper rotation (det +1), preserving quaternion handedness.
  const basis = useRef(nedToRenderBasis());
  const inverseBasis = useRef(basis.current.clone().invert());
  useFrame(({ camera }) => {
    const sim = runtime.current;
    if (!sim || !model.current) return;
    // Interpolates only between adjacent ticks of one epoch/model; never mutates truth.
    const alpha = interpolationAlpha(wallNow(), sim.current, sim.header.physicsHz, sim.running);
    interpolatePoseInto(sim.previous, sim.current, sim.history, alpha, pose.current);
    const p = pose.current;
    nedToRenderPositionInto(p.northM, p.eastM, p.downM, model.current.position);
    model.current.position.y += MODEL_HEIGHT_OFFSET_M;
    attitude.current.set(p.qx, p.qy, p.qz, p.qw);
    model.current.quaternion.copy(basis.current).multiply(attitude.current).multiply(inverseBasis.current);
    const east = p.eastM, down = p.downM, north = p.northM;
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
/** Streams one licensed 3D Tiles source in the render loop (never the physics step) and reports failures on change. */
function TerrainTiles({ config, onFailures }: { config: TerrainConfig; onFailures: (failures: readonly TileFailure[]) => void }) {
  const { camera, gl, scene } = useThree();
  const tiles = useRef<TilesScene | null>(null);
  const reported = useRef(0);
  useEffect(() => {
    // Loaded on demand: terrain is off by default, so the loader stays out of the main bundle.
    let instance: TilesScene | null = null, cancelled = false;
    void import('@mirage/terrain/tiles-scene').then(({ TilesScene: Scene }) => {
      if (cancelled) return;
      instance = new Scene({ ...config, camera, renderer: gl });
      scene.add(instance.tiles.group);
      tiles.current = instance;
      reported.current = 0;
    });
    return () => { cancelled = true; instance?.dispose(); tiles.current = null; };
  }, [config, camera, gl, scene]);
  useFrame(() => {
    const instance = tiles.current;
    if (!instance) return;
    instance.update();
    if (instance.failures.length !== reported.current) { reported.current = instance.failures.length; onFailures(instance.failures.slice()); }
  });
  return null;
}

export function FlightScene({ runtime, terrain = null, onTerrainFailures = () => undefined }: {
  runtime: RefObject<SimulationRuntime | null>;
  terrain?: TerrainConfig | null;
  onTerrainFailures?: (failures: readonly TileFailure[]) => void;
}) {
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
    {terrain && <TerrainTiles config={terrain} onFailures={onTerrainFailures} />}
    <Vehicle runtime={runtime} />
  </Canvas>;
}
