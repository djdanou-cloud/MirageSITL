import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useState, type ComponentType, type RefObject } from 'react';
import type { TilesScene } from '@mirage/terrain/tiles-scene';
import type { TileFailure } from '@mirage/terrain/tiles-provider';
import type { TerrainConfig } from './terrain-config';
import { Group, Quaternion, Vector3 } from 'three';
import { interpolatePoseInto, interpolationAlpha, newRenderPoseV2, wallNow } from '@mirage/protocol';
import type { SimulationRuntime } from './runtime';
import { nedToRenderBasis, nedToRenderPositionInto } from './coordinates';
import { g3Requested } from './render/g3-mode';
import { rendererFactory, rendererModeFromSearch } from './render/renderer';
import { MODEL_HEIGHT_OFFSET_M } from './vehicle-geometry';

// TASK-066: `?renderer=webgpu|webgl2` selects the renderer adapter; otherwise R3F's default WebGL renderer.
const search = globalThis.location?.search ?? '';
const rendererMode = rendererModeFromSearch(search);
const g3 = g3Requested(search);
const glOption = rendererMode ? rendererFactory(rendererMode) : { antialias: true, powerPreference: 'high-performance' as const };


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
/**
 * Streams the configured terrain sources (quantized-mesh ground and/or 3D Tiles
 * such as buildings) in the render loop, never the physics step, and reports
 * fetch failures when their count changes. All sources share one origin.
 */
function TerrainTiles({ config, onFailures, tiles }: { config: TerrainConfig; onFailures: (failures: readonly TileFailure[]) => void; tiles: RefObject<TilesScene[]> }) {
  const { camera, gl, scene } = useThree();
  const reported = useRef(0);
  useEffect(() => {
    // Loaded on demand: terrain is off by default, so the loader stays out of the main bundle.
    let instances: TilesScene[] = [], cancelled = false;
    void import('@mirage/terrain/tiles-scene').then(({ TilesScene: Scene }) => {
      if (cancelled) return;
      instances = config.sources.map(source => new Scene({ ...config, url: source.url, format: source.format, camera, renderer: gl }));
      for (const instance of instances) scene.add(instance.tiles.group);
      tiles.current = instances;
      reported.current = 0;
    });
    return () => { cancelled = true; for (const instance of instances) instance.dispose(); tiles.current = []; };
  }, [config, camera, gl, scene, tiles]);
  useFrame(() => {
    let failures = 0;
    for (const instance of tiles.current) { instance.update(); failures += instance.failures.length; }
    if (failures !== reported.current) { reported.current = failures; onFailures(tiles.current.flatMap(instance => instance.failures)); }
  });
  return null;
}

function G3Loader({ runtime, tiles }: { runtime: RefObject<SimulationRuntime | null>; tiles: RefObject<TilesScene[]> }) {
  const [Passes, setPasses] = useState<ComponentType<{ runtime: RefObject<SimulationRuntime | null>; tiles: RefObject<TilesScene[]> }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('./render/g3-passes').then(module => { if (!cancelled) setPasses(() => module.G3Passes); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root) return;
    root.dataset.g3 = '1';
    return () => { delete root.dataset.g3; };
  }, []);
  return Passes ? <Passes runtime={runtime} tiles={tiles} /> : null;
}

export function FlightScene({ runtime, terrain = null, onTerrainFailures = () => undefined }: {
  runtime: RefObject<SimulationRuntime | null>;
  terrain?: TerrainConfig | null;
  onTerrainFailures?: (failures: readonly TileFailure[]) => void;
}) {
  const tiles = useRef<TilesScene[]>([]);
  // Real terrain replaces the flat demo field: a daylight sky and kilometre-scale haze
  // instead of the dark 120 m fog, and a far plane that reaches the horizon.
  const sky = terrain ? '#a9c0d3' : '#111e29';
  return <Canvas shadows dpr={g3 ? 1 : [1, 1.5]} camera={{ position: [4, 3, 5], fov: 48, near: 0.05, far: terrain ? 30000 : 2000 }}
    gl={glOption}>
    <color attach="background" args={[sky]} />
    <fog attach="fog" args={terrain ? [sky, 2000, 25000] : [sky, 30, 120]} />
    {/* Real terrain: softer ambient and a low sun from the south-west so relief reads. */}
    <ambientLight intensity={terrain ? 0.45 : 1.1} />
    <directionalLight position={terrain ? [-6, 7, 8] : [6, 12, 4]} intensity={terrain ? 2.4 : 2.2} castShadow shadow-mapSize={[1024, 1024]} />
    {!terrain && <>
      <gridHelper args={[200, 200, '#5d929a', '#345b69']} position={[0, 0.01, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[2000, 2000]} /><meshStandardMaterial color="#14232d" roughness={1} />
      </mesh>
    </>}
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
      <ringGeometry args={[1.15, 1.18, 64]} /><meshBasicMaterial color="#70c4b1" transparent opacity={0.55} />
    </mesh>
    {terrain && <TerrainTiles config={terrain} onFailures={onTerrainFailures} tiles={tiles} />}
    {g3 && <G3Loader runtime={runtime} tiles={tiles} />}
    <Vehicle runtime={runtime} />
  </Canvas>;
}
