import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Mesh, MeshStandardMaterial, PerspectiveCamera, Quaternion, Sprite,
  Vector3, type Object3D } from "three";
import type { AircraftLayout } from "@mirage/aircraft/layout";
import { FpvCamera } from "@mirage/cameras/fpv-camera";
import { interpolatePoseInto, interpolationAlpha, newPowerSnapshotV1, newRenderPoseV2, wallNow } from "@mirage/protocol";
import { BODY_COLOR, BodyMeshes, GearMeshes, Rotor, SPIN_COLORS, Strut } from "../aircraft/AircraftScheme3D";
import type { ProfileBody } from "@mirage/aircraft/profile";
import { armMounts, frdToRender, schemeDimensions, type GearDrawing } from "../aircraft/scheme-geometry";
import { nedToRenderBasis, nedToRenderPositionInto } from "../coordinates";
import type { SimulationRuntime } from "../runtime";
import { chaseOffset, drawnSpinRadS, onboardCamera, TRAIL_CAPACITY, TrailBuffer } from "./flight-view-geometry";
import { TURNING_RPM } from "@mirage/autopilot/motor-test";

// The Run tab's flight view (TASK-185, S17): the aircraft of the chosen
// profile, drawn from its layout exactly as the Aircraft tab's scheme draws it
// (arms, motor numbers, discs coloured by spin with turning arrows, thrust
// axes), flying at the interpolated pose of the physics session, which the
// scene only reads. Each disc carries a blade that turns with that motor's
// speed from power telemetry. An external camera follows the aircraft; the
// onboard camera is TASK-067's mounted camera with a plain lens. The last two
// minutes of the trajectory are drawn, and the route and its points when a
// flight task provides one (TASK-172). The ground is the synthetic level pad:
// real terrain belongs to TASK-186. During the motor check (TASK-157) a ring
// marks the rotor the physics actually turns, in its spin colour.

/** A route point in local NED metres from the session origin. */
export interface RoutePoint { readonly northM: number; readonly eastM: number; readonly downM: number; readonly label: string }
export type FlightViewMode = "external" | "onboard";

/** What the scene holds, read back from the drawn objects at a decimated rate (tests and diagnostics). */
export interface FlightViewProbe {
  readonly mode: FlightViewMode;
  /** Each rotor in the aircraft's own frame (render axes about the reference point), as drawn. */
  readonly rotors: readonly { motorId: number; position: number[]; axis: number[]; spin: "ccw" | "cw" | "unknown"; label: string }[];
  /** The aircraft's render-space position, m. */
  readonly aircraft: readonly number[];
  readonly trailPoints: number;
  readonly routePoints: number;
  /** The motor whose rotor is ringed as turning (motor check), or null. */
  readonly ringed: number | null;
  /** Renderer resources, to show that switching views leaks nothing. */
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

const PROBE_EVERY_FRAMES = 20;

function Aircraft({ layout, runtime, aircraft, spinners, rings, ringTurning, body, gear }: {
  layout: AircraftLayout; runtime: RefObject<SimulationRuntime | null>; aircraft: RefObject<Group | null>; spinners: RefObject<(Group | null)[]>;
  rings: RefObject<(Mesh | null)[]>; ringTurning: boolean; body: ProfileBody | null; gear: GearDrawing | null;
}) {
  const { discRadius, span } = schemeDimensions(layout);
  const mounts = armMounts(layout);
  const pose = useRef(newRenderPoseV2());
  const attitude = useRef(new Quaternion());
  const basis = useRef(nedToRenderBasis());
  const inverseBasis = useRef(basis.current.clone().invert());
  const power = useRef(newPowerSnapshotV1());
  useFrame((_, deltaS) => {
    const sim = runtime.current, group = aircraft.current;
    if (!group) return;
    if (sim) {
      // Interpolates only between adjacent ticks of one epoch; never mutates truth.
      const alpha = interpolationAlpha(wallNow(), sim.current, sim.header.physicsHz, sim.running);
      interpolatePoseInto(sim.previous, sim.current, sim.history, alpha, pose.current);
      const p = pose.current;
      nedToRenderPositionInto(p.northM, p.eastM, p.downM, group.position);
      attitude.current.set(p.qx, p.qy, p.qz, p.qw);
      if (attitude.current.lengthSq() > 0) group.quaternion.copy(basis.current).multiply(attitude.current).multiply(inverseBasis.current);
    }
    const reading = sim !== null && sim.power.latest(power.current);
    const rows = spinners.current;
    // The ring marks the fastest rotor that turns (motor check); power rows are in the layout's motor order.
    let fastest = -1, fastestRpm = TURNING_RPM;
    for (let i = 0; ringTurning && reading && i < Math.min(layout.rotors.length, power.current.motorCount); i++) {
      const rpm = Math.abs(power.current.motors[i * 5] ?? 0);
      if (rpm >= fastestRpm) { fastest = i; fastestRpm = rpm; }
    }
    for (let i = 0; i < rings.current.length; i++) { const ring = rings.current[i]; if (ring) ring.visible = i === fastest; }
    for (let i = 0; i < layout.rotors.length; i++) {
      const spinner = rows[i], rotor = layout.rotors[i];
      if (!spinner || !rotor) continue;
      // Power telemetry rows follow the manifest's rotors, which follow the layout's motor order.
      const rpm = reading && i < power.current.motorCount ? power.current.motors[i * 5] ?? 0 : 0;
      spinner.rotation.z += rotor.spinSign * drawnSpinRadS(rpm) * deltaS;
    }
  });
  return (
    <group ref={aircraft} name="aircraft">
      {/* TASK-196 and TASK-194: a described body and landing gear at their size; otherwise the symbolic body of the scheme. */}
      {body ? <BodyMeshes body={body} /> : (
        <mesh castShadow>
          <boxGeometry args={[span * 0.12, span * 0.05, span * 0.18]} />
          <meshStandardMaterial color={BODY_COLOR} />
        </mesh>
      )}
      {gear && <GearMeshes drawing={gear} size={span * 0.012} />}
      {/* Forward (body x) is render -z. */}
      <mesh position={[0, 0, -span * 0.12]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[span * 0.03, span * 0.07, 12]} />
        <meshStandardMaterial color="#9af0d1" />
      </mesh>
      {mounts.map((mount, index) => <Strut key={index} to={mount} thickness={body?.armRadiusM ? 2 * body.armRadiusM : span * 0.015} />)}
      {layout.rotors.map((rotor, index) => {
        const [x, y, z] = frdToRender(rotor.hubPositionBodyM);
        return (
          <group key={rotor.motorId}>
            <Rotor rotor={rotor} discRadius={discRadius} />
            {/* The turning blade, at the hub about its thrust axis. */}
            <group position={[x, y, z]} quaternion={rotorQuaternion(rotor.hubToBody)}>
              <mesh ref={object => { rings.current[index] = object; }} name={`ring-${rotor.motorId}`} visible={false}>
                <torusGeometry args={[discRadius * 1.18, discRadius * 0.07, 8, 48]} />
                <meshBasicMaterial color={rotor.spinSign === 1 ? SPIN_COLORS.ccw : SPIN_COLORS.cw} />
              </mesh>
              <group ref={object => { spinners.current[index] = object; }} name={`blade-${rotor.motorId}`}>
                <mesh position={[0, 0, discRadius * 0.08]}>
                  <boxGeometry args={[discRadius * 1.9, discRadius * 0.08, discRadius * 0.02]} />
                  <meshStandardMaterial color="#e1f4f2" />
                </mesh>
              </group>
            </group>
          </group>
        );
      })}
    </group>
  );
}

/** A rotor's hub orientation in render axes, as the scheme places it (scheme-geometry.ts rotorRenderPose). */
function rotorQuaternion(hubToBody: readonly number[]): [number, number, number, number] {
  const [w = 1, x = 0, y = 0, z = 0] = hubToBody;
  const q = nedToRenderBasis().multiply(new Quaternion(x, y, z, w));
  return [q.x, q.y, q.z, q.w];
}

/** The last two minutes of the trajectory, one sample per 0.1 s of simulated time, into preallocated buffers. */
function Trail({ runtime, aircraft, trail }: { runtime: RefObject<SimulationRuntime | null>; aircraft: RefObject<Group | null>; trail: TrailBuffer }) {
  const line = useMemo(() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(TRAIL_CAPACITY * 3), 3));
    geometry.setDrawRange(0, 0);
    const object = new Line(geometry, new LineBasicMaterial({ color: "#f2d16b" }));
    object.frustumCulled = false;
    object.name = "trail";
    return object;
  }, []);
  useEffect(() => () => { line.geometry.dispose(); line.material.dispose(); }, [line]);
  useFrame(() => {
    const sim = runtime.current, group = aircraft.current;
    if (!sim || !group) return;
    const p = group.position;
    if (!trail.offer(sim.epoch, sim.current.simTimeS, p.x, p.y, p.z)) return;
    const attribute = line.geometry.getAttribute("position");
    if (!(attribute instanceof BufferAttribute) || !(attribute.array instanceof Float32Array)) return;
    line.geometry.setDrawRange(0, trail.writeInto(attribute.array));
    attribute.needsUpdate = true;
  });
  return <primitive object={line} />;
}

/** The route of a flight task and its points; nothing until a task provides one. */
function Route({ route, size }: { route: readonly RoutePoint[]; size: number }) {
  const line = useMemo(() => {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(route.length * 3);
    const at = new Vector3();
    route.forEach((point, i) => { nedToRenderPositionInto(point.northM, point.eastM, point.downM, at); positions.set([at.x, at.y, at.z], i * 3); });
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    const object = new Line(geometry, new LineBasicMaterial({ color: "#7fb4ff" }));
    object.name = "route";
    return object;
  }, [route]);
  useEffect(() => () => { line.geometry.dispose(); line.material.dispose(); }, [line]);
  if (route.length === 0) return null;
  return (
    <group name="route-group">
      <primitive object={line} />
      {route.map((point, i) => {
        const at = new Vector3();
        nedToRenderPositionInto(point.northM, point.eastM, point.downM, at);
        return <mesh key={i} name="route-point" position={at} userData={{ label: point.label }}>
          <sphereGeometry args={[size, 12, 8]} /><meshStandardMaterial color="#7fb4ff" />
        </mesh>;
      })}
    </group>
  );
}

/** Follows the aircraft from behind and above, or makes the onboard camera the scene's camera. */
function Cameras({ mode, layout, runtime, aircraft }: {
  mode: FlightViewMode; layout: AircraftLayout; runtime: RefObject<SimulationRuntime | null>; aircraft: RefObject<Group | null>;
}) {
  const { camera, set, size } = useThree();
  const external = useRef<PerspectiveCamera | null>(camera instanceof PerspectiveCamera ? camera : null);
  const offset = useMemo(() => chaseOffset(layout), [layout]);
  // Created at 16:9 (the canvas may not be laid out yet), then sized to the canvas.
  const onboard = useMemo(() => new FpvCamera(onboardCamera(layout), 16, 9), [layout]);
  useEffect(() => {
    // The lens takes whole output pixels; the canvas reports CSS pixels, which may be fractional.
    const width = Math.round(size.width), height = Math.round(size.height);
    if (width > 0 && height > 0) onboard.resize(width, height);
  }, [onboard, size.width, size.height]);
  const pose = useRef(newRenderPoseV2());
  useEffect(() => {
    const chase = external.current;
    if (mode === "onboard") set({ camera: onboard.camera });
    else if (chase) set({ camera: chase });
  }, [mode, onboard, set]);
  useFrame(() => {
    const group = aircraft.current, sim = runtime.current;
    if (!group) return;
    if (mode === "onboard") {
      if (!sim) return;
      const alpha = interpolationAlpha(wallNow(), sim.current, sim.header.physicsHz, sim.running);
      interpolatePoseInto(sim.previous, sim.current, sim.history, alpha, pose.current);
      onboard.update(pose.current);
      return;
    }
    const chase = external.current;
    if (!chase) return;
    chase.position.set(group.position.x + offset[0], group.position.y + offset[1], group.position.z + offset[2]);
    chase.lookAt(group.position);
  });
  return null;
}

/** Reports the drawn rotors and the renderer's resources every PROBE_EVERY_FRAMES frames, when they changed. */
function Probe({ mode, aircraft, trail, routePoints, layout, rings, onProbe }: {
  mode: FlightViewMode; aircraft: RefObject<Group | null>; trail: TrailBuffer; routePoints: number; layout: AircraftLayout;
  rings: RefObject<(Mesh | null)[]>; onProbe: (probe: FlightViewProbe) => void;
}) {
  const gl = useThree(state => state.gl);
  const frames = useRef(0), last = useRef("");
  useFrame(() => {
    if (++frames.current % PROBE_EVERY_FRAMES !== 0 || !aircraft.current) return;
    const group = aircraft.current;
    const rotors: FlightViewProbe["rotors"][number][] = [];
    const inverse = group.quaternion.clone().invert(), position = new Vector3(), rotation = new Quaternion();
    group.traverse((object: Object3D) => {
      const motorId: unknown = object.userData.motorId;
      if (typeof motorId !== "number") return;
      object.getWorldPosition(position);
      object.getWorldQuaternion(rotation);
      const local = position.clone().sub(group.position).applyQuaternion(inverse);
      const axis = new Vector3(0, 0, 1).applyQuaternion(inverse.clone().multiply(rotation));
      const disc = object.getObjectByName("disc");
      const color = disc instanceof Mesh && disc.material instanceof MeshStandardMaterial ? `#${disc.material.color.getHexString()}` : "";
      const label = object.children.find((child): child is Sprite => child instanceof Sprite);
      const text: unknown = label?.userData.text;
      rotors.push({ motorId, position: local.toArray(), axis: axis.toArray(),
        spin: color === SPIN_COLORS.ccw ? "ccw" : color === SPIN_COLORS.cw ? "cw" : "unknown", label: typeof text === "string" ? text : "" });
    });
    rotors.sort((a, b) => a.motorId - b.motorId);
    const ringedIndex = rings.current.findIndex(ring => ring?.visible === true);
    const probe: FlightViewProbe = { mode, rotors, aircraft: group.position.toArray(), trailPoints: trail.count, routePoints,
      ringed: ringedIndex < 0 ? null : layout.rotors[ringedIndex]?.motorId ?? null,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0 };
    const json = JSON.stringify(probe);
    if (json !== last.current) { last.current = json; onProbe(probe); }
  });
  return null;
}

export function FlightView({ runtime, layout, name, route = [], active, ringTurning = false, body = null, gear = null, onProbe }: {
  runtime: RefObject<SimulationRuntime | null>;
  layout: AircraftLayout;
  /** TASK-196: the profile's described body, or null for the symbolic one. */
  body?: ProfileBody | null;
  /** TASK-194: the profile's described landing gear, or null: the standard supports are not drawn. */
  gear?: GearDrawing | null;
  name: string;
  route?: readonly RoutePoint[];
  /** False while the Run tab is hidden: the view stops drawing and the session runs on. */
  active: boolean;
  /** True during the motor check: the rotor that turns is ringed. */
  ringTurning?: boolean;
  onProbe?: (probe: FlightViewProbe) => void;
}) {
  const [mode, setMode] = useState<FlightViewMode>("external");
  const aircraft = useRef<Group | null>(null);
  const spinners = useRef<(Group | null)[]>([]);
  const rings = useRef<(Mesh | null)[]>([]);
  const trail = useMemo(() => new TrailBuffer(), []);
  const { span } = schemeDimensions(layout);
  const chase = chaseOffset(layout);
  return (
    <div className="flight-view">
      <fieldset className="flight-view-mode">
        <legend>View</legend>
        <label><input type="radio" name="flight-view" value="external" checked={mode === "external"} onChange={() => setMode("external")} /> External</label>
        <label><input type="radio" name="flight-view" value="onboard" checked={mode === "onboard"} onChange={() => setMode("onboard")} /> Onboard</label>
      </fieldset>
      <div className="flight-view-canvas" role="img"
        aria-label={`${mode === "external" ? "External" : "Onboard"} view of ${name}: ${layout.rotors.length} motors over the synthetic level pad`}>
        <Canvas shadows dpr={[1, 1.5]} frameloop={active ? "always" : "never"}
          camera={{ position: [chase[0], chase[1], chase[2]], fov: 48, near: 0.02, far: 2000 }}>
          <color attach="background" args={["#111e29"]} />
          <fog attach="fog" args={["#111e29", Math.max(30, span * 40), Math.max(120, span * 160)]} />
          <ambientLight intensity={1.1} />
          <directionalLight position={[6, 12, 4]} intensity={2.2} castShadow shadow-mapSize={[1024, 1024]} />
          <gridHelper args={[200, 200, "#5d929a", "#345b69"]} position={[0, 0.01, 0]} />
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
            <planeGeometry args={[2000, 2000]} /><meshStandardMaterial color="#14232d" roughness={1} />
          </mesh>
          <Aircraft layout={layout} runtime={runtime} aircraft={aircraft} spinners={spinners} rings={rings} ringTurning={ringTurning} body={body} gear={gear} />
          <Trail runtime={runtime} aircraft={aircraft} trail={trail} />
          <Route route={route} size={Math.max(0.15, span * 0.08)} />
          <Cameras mode={mode} layout={layout} runtime={runtime} aircraft={aircraft} />
          {onProbe && <Probe mode={mode} aircraft={aircraft} trail={trail} routePoints={route.length} layout={layout} rings={rings} onProbe={onProbe} />}
        </Canvas>
      </div>
      <p className="hint">
        Ground: the synthetic level pad (no terrain data). The yellow line is the last two minutes of the flight;
        {route.length === 0 ? " no flight task route is loaded." : ` the blue line is the route with its ${route.length} points.`} Blades turn with each
        motor's measured speed, slowed for display.
      </p>
    </div>
  );
}
