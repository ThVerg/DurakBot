// 3D cards: rounded glossy cards that tween (arc + spin) to layout targets,
// with hover lift for the hand and a gold rim glow for playable cards.
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CARD_H, CARD_W, type CardTarget, type V3 } from "./layout";
import { backTexture, faceTexture } from "./textures";

function roundedPath(p: THREE.Path, w: number, h: number, r: number) {
  const x = -w / 2, y = -h / 2;
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.quadraticCurveTo(x + w, y, x + w, y + r);
  p.lineTo(x + w, y + h - r);
  p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h);
  p.quadraticCurveTo(x, y + h, x, y + h - r);
  p.lineTo(x, y + r);
  p.quadraticCurveTo(x, y, x + r, y);
  return p;
}

/** A thin rounded frame (outer minus inner) used for the gold rim glow. */
function roundedRing(w: number, h: number, r: number, t: number) {
  const s = roundedPath(new THREE.Shape(), w, h, r) as THREE.Shape;
  s.holes.push(roundedPath(new THREE.Path(), w - 2 * t, h - 2 * t, Math.max(0.01, r - t)));
  return new THREE.ShapeGeometry(s, 6);
}

function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ShapeGeometry(s, 6);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - x) / w;
    uv[i * 2 + 1] = (pos.getY(i) - y) / h;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

let shared: { face: THREE.ShapeGeometry; back: THREE.ShapeGeometry; glow: THREE.BufferGeometry; edge: THREE.ShapeGeometry } | null = null;
export function cardGeometry() {
  if (!shared) {
    const face = roundedRect(CARD_W, CARD_H, 0.07);
    const back = roundedRect(CARD_W, CARD_H, 0.07);
    back.rotateY(Math.PI);
    back.translate(0, 0, -0.004);
    const glow = roundedRing(CARD_W + 0.06, CARD_H + 0.06, 0.1, 0.075);
    glow.translate(0, 0, 0.0015);
    const edge = roundedRect(CARD_W + 0.012, CARD_H + 0.012, 0.075);
    edge.translate(0, 0, -0.002);
    shared = { face, back, glow, edge };
  }
  return shared;
}

const backMats = new Map<string, THREE.MeshStandardMaterial>();
function backMaterial(id: string) {
  let m = backMats.get(id);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: backTexture(id), roughness: 0.4, metalness: 0.05, alphaTest: 0.5, envMapIntensity: 0.6 });
    backMats.set(id, m);
  }
  return m;
}
const faceMats = new Map<string, THREE.MeshStandardMaterial>();
function faceMaterial(card: number, four: boolean) {
  const k = `${card}:${four}`;
  let m = faceMats.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: faceTexture(card, four), roughness: 0.42, metalness: 0, alphaTest: 0.5, envMapIntensity: 0.45 });
    faceMats.set(k, m);
  }
  return m;
}
const edgeMat = new THREE.MeshStandardMaterial({ color: "#efe6d2", roughness: 0.6 });

export function disposeCardResources() {
  for (const m of backMats.values()) m.dispose();
  for (const m of faceMats.values()) m.dispose();
  backMats.clear();
  faceMats.clear();
  if (shared) Object.values(shared).forEach((g) => g.dispose());
  shared = null;
}

// ----------------------------------------------------------------- animator
export interface Motion {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  q0: THREE.Quaternion;
  q1: THREE.Quaternion;
  f0: number;
  f1: number;
  s0: number;
  s1: number;
  t0: number;
  dur: number;
  arc: number;
  spin: number;
  landed: boolean;
}

const e = new THREE.Euler();
export function quatOf(rot: V3) {
  e.set(rot[0], rot[1], rot[2], "YXZ");
  return new THREE.Quaternion().setFromEuler(e);
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface CardProps {
  t: CardTarget;
  back: string;
  four: boolean;
  speed: number; // seconds scale (0 = instant)
  legal: boolean;
  dim: boolean;
  hint: boolean;
  selected: boolean;
  onPlay?: (card: number) => void;
  onHover?: (card: number | null) => void;
  onDragStart?: (card: number, clientY: number) => void;
  hovered: boolean;
  registry: Map<string, THREE.Object3D>;
  settle: { until: number };
  onLand?: (zone: CardTarget["zone"], fromSpawn: boolean) => void;
}

export const Card3D = memo(function Card3D(p: CardProps) {
  const { t } = p;
  const geo = cardGeometry();
  const group = useRef<THREE.Group>(null);
  const flipper = useRef<THREE.Group>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const faceRef = useRef<THREE.Mesh>(null);
  const motion = useRef<Motion | null>(null);
  const hoverK = useRef(0);
  const lastKey = useRef("");
  const fromSpawn = useRef(false);

  const faceMat = useMemo(() => (t.card !== null ? faceMaterial(t.card, p.four) : null), [t.card, p.four]);
  const backMat = useMemo(() => backMaterial(p.back), [p.back]);
  const glowMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.22, 0.42), transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
    [],
  );
  useEffect(() => () => glowMat.dispose(), [glowMat]);

  // (re)target
  const sig = `${t.pos.map((v) => v.toFixed(3)).join(",")}|${t.rot.map((v) => v.toFixed(3)).join(",")}|${t.faceUp}|${t.scale}`;
  useEffect(() => {
    const g = group.current;
    if (!g) return;
    const now = performance.now() / 1000;
    const p1 = new THREE.Vector3(...t.pos);
    const q1 = quatOf(t.rot);
    const f1 = t.faceUp ? 0 : Math.PI;
    const m = motion.current;
    if (!m) {
      // first appearance: from the spawn point if any
      const sp = t.spawn;
      const p0 = sp ? new THREE.Vector3(...sp.pos) : p1.clone();
      const q0 = sp ? quatOf(sp.rot) : q1.clone();
      const f0 = sp ? (sp.faceUp ? 0 : Math.PI) : f1;
      fromSpawn.current = !!sp;
      const dur = sp ? 0.5 * p.speed : 0;
      motion.current = { p0, p1, q0, q1, f0, f1, s0: t.scale * (sp ? 0.85 : 1), s1: t.scale, t0: now + (t.delay ?? 0) * (p.speed > 0 ? Math.max(0.35, p.speed) : 0), dur, arc: sp ? 0.9 : 0, spin: sp ? 0.25 : 0, landed: dur === 0 };
      g.position.copy(p0);
      g.quaternion.copy(q0);
      g.scale.setScalar(motion.current.s0);
      if (flipper.current) flipper.current.rotation.y = f0;
    } else if (lastKey.current !== sig) {
      const dist = g.position.distanceTo(p1);
      const long = dist > 1.2;
      const dur = p.speed * (long ? 0.42 + Math.min(0.25, dist * 0.03) : 0.26);
      motion.current = {
        p0: g.position.clone(),
        p1,
        q0: g.quaternion.clone(),
        q1,
        f0: flipper.current?.rotation.y ?? f1,
        f1,
        s0: g.scale.x,
        s1: t.scale,
        t0: now + (t.delay ?? 0) * p.speed,
        dur,
        arc: long ? Math.min(1.4, 0.35 + dist * 0.12) : 0.05,
        spin: long ? 0.35 : 0,
        landed: dur === 0,
      };
      fromSpawn.current = false;
    }
    lastKey.current = sig;
    const mm = motion.current!;
    p.settle.until = Math.max(p.settle.until, mm.t0 + mm.dur);
  });

  useEffect(() => {
    const g = group.current;
    if (g) p.registry.set(t.key, g);
    return () => {
      p.registry.delete(t.key);
    };
  }, [t.key, p.registry]);

  useFrame((_, dt) => {
    const g = group.current;
    const m = motion.current;
    if (!g || !m) return;
    const now = performance.now() / 1000;
    let k = m.dur > 0 ? (now - m.t0) / m.dur : 1;
    k = Math.max(0, Math.min(1, k));
    const ke = easeOut(k);
    g.position.lerpVectors(m.p0, m.p1, ke);
    g.position.y += Math.sin(Math.PI * k) * m.arc;
    g.quaternion.slerpQuaternions(m.q0, m.q1, easeInOut(k));
    if (m.spin) g.rotateZ(Math.sin(Math.PI * k) * m.spin);
    const sc = m.s0 + (m.s1 - m.s0) * ke;
    if (flipper.current) flipper.current.rotation.y = m.f0 + (m.f1 - m.f0) * easeInOut(k);
    // hover: lift along the card's up vector and towards the camera
    const target = p.hovered && p.legal ? 1 : p.selected ? 0.8 : 0;
    hoverK.current += (target - hoverK.current) * Math.min(1, dt * 14);
    if (t.zone === "hand") {
      const lift = (p.legal ? 0.12 : 0) + hoverK.current * 0.42 + (p.hint ? 0.18 : 0);
      g.translateY(lift);
      g.translateZ(hoverK.current * 0.25);
      g.scale.setScalar(sc * (1 + hoverK.current * 0.07));
    } else g.scale.setScalar(sc);
    if (k >= 1 && !m.landed) {
      m.landed = true;
      p.onLand?.(t.zone, fromSpawn.current);
    }
    // glow
    if (glowRef.current) {
      const time = now * 3;
      const want = p.hint ? 0.65 + Math.sin(time) * 0.25 : p.legal ? 0.28 + hoverK.current * 0.35 : t.known ? 0.22 : 0;
      glowMat.opacity += (want - glowMat.opacity) * Math.min(1, dt * 10);
      glowRef.current.visible = glowMat.opacity > 0.01;
    }
    if (faceRef.current && faceMat) {
      const c = p.dim ? 0.5 : 1;
      faceMat.color.setScalar(faceMat.color.r + (c - faceMat.color.r) * Math.min(1, dt * 10));
    }
  });

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    if (t.zone !== "hand" || !p.legal || t.card === null) return;
    ev.stopPropagation();
    p.onDragStart?.(t.card, ev.nativeEvent.clientY);
  };
  const onUp = (ev: ThreeEvent<PointerEvent>) => {
    if (t.zone !== "hand" || !p.legal || t.card === null) return;
    ev.stopPropagation();
    p.onPlay?.(t.card);
  };

  const interactive = t.zone === "hand";
  return (
    <group ref={group} name={t.key} userData={{ card: t.card, zone: t.zone }}>
      <group ref={flipper}>
        <mesh ref={glowRef} geometry={geo.glow} material={glowMat} visible={false} renderOrder={-1} />
        <mesh geometry={geo.edge} material={edgeMat} castShadow />
        {faceMat ? (
          <mesh
            ref={faceRef}
            geometry={geo.face}
            material={faceMat}
            castShadow
            receiveShadow
            onPointerOver={interactive ? (ev) => (ev.stopPropagation(), t.card !== null && p.onHover?.(t.card)) : undefined}
            onPointerOut={interactive ? () => p.onHover?.(null) : undefined}
            onPointerDown={interactive ? onDown : undefined}
            onPointerUp={interactive ? onUp : undefined}
          />
        ) : (
          <mesh geometry={geo.face} material={backMat} castShadow receiveShadow />
        )}
        <mesh geometry={geo.back} material={backMat} receiveShadow />
      </group>
    </group>
  );
});
