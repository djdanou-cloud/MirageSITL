import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { CanvasTexture, Mesh, MeshStandardMaterial, Quaternion, Sprite, SpriteMaterial, Vector3, type Object3D } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AircraftLayout, RotorLayout } from "@mirage/aircraft/layout";
import { frdToRender, rotorRenderPose } from "./scheme-geometry";

// The aircraft scheme (TASK-141, S03): every rotor drawn from the TASK-138
// layout derivation, whose hub positions, hub orientations and spin signs are
// the vehicle manifest's rotor fields. Each rotor shows its motor number, a
// disc colored by spin with an arrow in the turning direction, and its thrust
// axis. A table repeats the scheme in text. The scheme draws only on change.

export const SPIN_COLORS = { ccw: "#5fd3b0", cw: "#e8a65d" } as const;
const BODY_COLOR = "#8fa3b0";

/** What the scene graph holds after rendering, read back from the drawn objects. */
export interface RenderedRotor {
  readonly motorId: number;
  /** Render-space position of the rotor object, m. */
  readonly position: readonly number[];
  /** Render-space direction of the rotor object's local +z, the drawn thrust axis. */
  readonly axis: readonly number[];
  readonly spin: "ccw" | "cw" | "unknown";
  readonly label: string;
}

function labelTexture(text: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#0c1721";
    context.beginPath();
    context.arc(32, 32, 30, 0, 2 * Math.PI);
    context.fill();
    context.fillStyle = "#e1f4f2";
    context.font = "bold 34px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 32, 34);
  }
  return new CanvasTexture(canvas);
}

function Rotor({ rotor, discRadius }: { rotor: RotorLayout; discRadius: number }) {
  const pose = rotorRenderPose(rotor), spin = rotor.spinSign === 1 ? "ccw" : "cw";
  const label = useMemo(() => {
    const sprite = new Sprite(new SpriteMaterial({ map: labelTexture(String(rotor.motorId)), depthTest: false }));
    sprite.userData = { text: String(rotor.motorId) };
    sprite.scale.setScalar(discRadius * 0.9);
    sprite.position.set(0, 0, discRadius * 0.5);
    return sprite;
  }, [rotor.motorId, discRadius]);
  useEffect(() => () => {
    label.material.map?.dispose();
    label.material.dispose();
  }, [label]);
  // The turning arrow: an arc over three quarters of a turn about the hub +z axis, its head at the end reached when turning in the rotor's direction.
  const headAngle = rotor.spinSign === 1 ? 1.5 * Math.PI : 0;
  const arcRadius = discRadius * 0.75;
  const head = new Vector3(Math.cos(headAngle), Math.sin(headAngle), 0).multiplyScalar(arcRadius);
  const tangent = new Vector3(-Math.sin(headAngle), Math.cos(headAngle), 0).multiplyScalar(rotor.spinSign);
  const headQuaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), tangent);
  return (
    <group name={`rotor-${rotor.motorId}`} userData={{ motorId: rotor.motorId }} position={[...pose.position]} quaternion={[...pose.quaternion]}>
      <mesh name="disc" rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[discRadius, discRadius, discRadius * 0.04, 40]} />
        <meshStandardMaterial color={SPIN_COLORS[spin]} transparent opacity={0.55} />
      </mesh>
      <mesh position={[0, 0, discRadius * 0.05]}>
        <torusGeometry args={[arcRadius, discRadius * 0.025, 6, 40, 1.5 * Math.PI]} />
        <meshStandardMaterial color={SPIN_COLORS[spin]} />
      </mesh>
      <mesh position={[head.x, head.y, discRadius * 0.05]} quaternion={headQuaternion}>
        <coneGeometry args={[discRadius * 0.09, discRadius * 0.22, 12]} />
        <meshStandardMaterial color={SPIN_COLORS[spin]} />
      </mesh>
      <mesh position={[0, 0, discRadius * 0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[discRadius * 0.025, discRadius * 0.025, discRadius * 1.2, 8]} />
        <meshStandardMaterial color="#e1f4f2" />
      </mesh>
      <mesh position={[0, 0, discRadius * 1.3]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[discRadius * 0.08, discRadius * 0.2, 12]} />
        <meshStandardMaterial color="#e1f4f2" />
      </mesh>
      <primitive object={label} />
    </group>
  );
}

/** A thin box from the reference point to a body FRD point. */
function Strut({ to, thickness }: { to: readonly number[]; thickness: number }) {
  const end = new Vector3(...frdToRender(to));
  const length = end.length();
  if (length === 0) return null;
  const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), end.clone().normalize());
  return (
    <mesh position={end.clone().multiplyScalar(0.5)} quaternion={quaternion}>
      <boxGeometry args={[thickness, length, thickness]} />
      <meshStandardMaterial color={BODY_COLOR} />
    </mesh>
  );
}

function Controls({ span }: { span: number }) {
  const { camera, gl, invalidate } = useThree();
  useEffect(() => {
    camera.position.set(span * 1.1, span * 1.3, span * 1.7);
    camera.lookAt(0, 0, 0);
    const controls = new OrbitControls(camera, gl.domElement);
    const redraw = () => invalidate();
    controls.addEventListener("change", redraw);
    invalidate();
    return () => {
      controls.removeEventListener("change", redraw);
      controls.dispose();
    };
  }, [camera, gl, invalidate, span]);
  return null;
}

function Probe({ onRendered }: { onRendered: (rotors: readonly RenderedRotor[]) => void }) {
  const scene = useThree(state => state.scene);
  const last = useRef("");
  useFrame(() => {
    const rotors: RenderedRotor[] = [];
    const position = new Vector3(), rotation = new Quaternion();
    scene.traverse((object: Object3D) => {
      const motorId: unknown = object.userData.motorId;
      if (typeof motorId !== "number") return;
      object.getWorldPosition(position);
      object.getWorldQuaternion(rotation);
      const axis = new Vector3(0, 0, 1).applyQuaternion(rotation);
      const disc = object.getObjectByName("disc");
      const color = disc instanceof Mesh && disc.material instanceof MeshStandardMaterial ? `#${disc.material.color.getHexString()}` : "";
      const label = object.children.find((child): child is Sprite => child instanceof Sprite);
      const text: unknown = label?.userData.text;
      rotors.push({
        motorId, position: position.toArray(), axis: axis.toArray(),
        spin: color === SPIN_COLORS.ccw ? "ccw" : color === SPIN_COLORS.cw ? "cw" : "unknown", label: typeof text === "string" ? text : "",
      });
    });
    rotors.sort((a, b) => a.motorId - b.motorId);
    const json = JSON.stringify(rotors);
    if (json !== last.current) {
      last.current = json;
      onRendered(rotors);
    }
  });
  return null;
}

const format = (value: number) => (Math.abs(value) < 5e-4 ? "0" : value.toFixed(3));

export function AircraftScheme3D({ layout, name, onRendered }: {
  layout: AircraftLayout;
  name: string;
  onRendered?: (rotors: readonly RenderedRotor[]) => void;
}) {
  const reach = Math.max(0.1, ...layout.rotors.map(rotor => Math.hypot(...rotor.hubPositionBodyM)));
  const discRadius = Math.max(0.04, Math.min(0.35 * reach, 0.25));
  const span = reach + discRadius * 2;
  const mounts = new Map<number, number[]>();
  for (const rotor of layout.rotors) {
    const sum = mounts.get(rotor.armId) ?? [0, 0, 0, 0];
    mounts.set(rotor.armId, [sum[0]! + rotor.hubPositionBodyM[0]!, sum[1]! + rotor.hubPositionBodyM[1]!, sum[2]! + rotor.hubPositionBodyM[2]!, sum[3]! + 1]);
  }
  return (
    <div className="aircraft-scheme">
      <div className="scheme-canvas" role="img" aria-label={`3D scheme of ${name}: ${layout.rotors.length} motors, forward is marked by the arrow on the body`}>
        <Canvas frameloop="demand" dpr={[1, 1.5]} camera={{ fov: 40, near: 0.01, far: 100 }}>
          <ambientLight intensity={0.8} />
          <directionalLight position={[2, 4, 3]} intensity={1.2} />
          <mesh>
            <boxGeometry args={[span * 0.12, span * 0.05, span * 0.18]} />
            <meshStandardMaterial color={BODY_COLOR} />
          </mesh>
          {/* Forward (body x) is render -z. */}
          <mesh position={[0, 0, -span * 0.22]} rotation={[-Math.PI / 2, 0, 0]}>
            <coneGeometry args={[span * 0.04, span * 0.1, 12]} />
            <meshStandardMaterial color="#9af0d1" />
          </mesh>
          {[...mounts.values()].map((sum, index) => (
            <Strut key={index} to={[sum[0]! / sum[3]!, sum[1]! / sum[3]!, sum[2]! / sum[3]!]} thickness={span * 0.015} />
          ))}
          {layout.rotors.map(rotor => <Rotor key={rotor.motorId} rotor={rotor} discRadius={discRadius} />)}
          <Controls span={span} />
          {onRendered && <Probe onRendered={onRendered} />}
        </Canvas>
      </div>
      <p className="hint">
        Body axes: x forward, y right, z down, from the reference point. Turquoise rotors turn counter-clockwise and amber rotors clockwise,
        seen from the thrust side; the white arrow is the thrust axis.
      </p>
      {/* Focusable, so a keyboard user can scroll the table on a narrow screen. */}
      <div className="table-scroll" tabIndex={0} role="region" aria-label={`Motor table of ${name}`}>
        <table className="scheme-table">
          <caption>Motors of {name}</caption>
          <thead>
            <tr><th scope="col">Motor</th><th scope="col">Arm</th><th scope="col">Output</th><th scope="col">Position x, y, z (m)</th><th scope="col">Thrust axis x, y, z</th><th scope="col">Spin</th></tr>
          </thead>
          <tbody>
            {layout.rotors.map(rotor => (
              <tr key={rotor.motorId}>
                <th scope="row">{rotor.motorId}</th>
                <td>{rotor.armId}{rotor.level === "single" ? "" : `, ${rotor.level}`}</td>
                <td>{rotor.output}</td>
                <td>{rotor.hubPositionBodyM.map(format).join(", ")}</td>
                <td>{rotor.thrustAxisBody.map(format).join(", ")}</td>
                <td>{rotor.spinSign === 1 ? "counter-clockwise" : "clockwise"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
