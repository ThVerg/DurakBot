// The casino table: felt with fibre normals, brass trim, walnut rail,
// padded leather armrest, apron, pedestal and a dark room floor.
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { Dims } from "./layout";
import { assetTexture, emblemTexture, feltMaps, leatherNormal, walnutMap } from "./textures";

class Ellipse3 extends THREE.Curve<THREE.Vector3> {
  constructor(
    private a: number,
    private b: number,
    private y: number,
  ) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()) {
    const ang = t * Math.PI * 2;
    return target.set(this.a * Math.cos(ang), this.y, this.b * Math.sin(ang));
  }
}

export const FELT_COLORS: Record<string, string> = {
  felt: "#0f5a3e",
  modern: "#1d2a46",
  kitchen: "#5a1220",
  casino: "#26292b",
};
/** pref theme id -> felt asset id */
export const FELT_ASSET: Record<string, string> = { felt: "emerald", modern: "royal", kitchen: "burgundy", casino: "charcoal" };

function vignetteTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(128, 128, 30, 128, 128, 128);
  r.addColorStop(0, "rgba(0,0,0,0)");
  r.addColorStop(0.62, "rgba(0,0,0,0.05)");
  r.addColorStop(1, "rgba(0,0,0,0.62)");
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function Table({ dims, theme, lang }: { dims: Dims; theme: string; lang: string }) {
  const { A, B } = dims;
  const feltColor = FELT_COLORS[theme] ?? FELT_COLORS.felt;
  const feltId = FELT_ASSET[theme] ?? "emerald";
  const rep = (x: number, y: number): [number, number] => [x, y];
  const tex = useMemo(() => {
    const proc = feltMaps(feltColor);
    const fr = rep(A * 0.42, B * 0.42);
    return {
      felt: assetTexture(`/assets/table/felt_${feltId}.webp`, { fallback: () => proc.map, repeat: fr }),
      feltN: assetTexture("/assets/table/felt_normal.webp", { srgb: false, fallback: () => proc.normal, repeat: fr }),
      feltR: assetTexture("/assets/table/felt_roughness.webp", { srgb: false, repeat: fr }),
      walnut: assetTexture("/assets/table/walnut_color.webp", { fallback: walnutMap, repeat: [6, 1] }),
      walnutN: assetTexture("/assets/table/walnut_normal.webp", { srgb: false, repeat: [6, 1] }),
      walnutR: assetTexture("/assets/table/walnut_roughness.webp", { srgb: false, repeat: [6, 1] }),
      leather: assetTexture("/assets/table/leather_color.webp", { repeat: [40, 2] }),
      leatherN: assetTexture("/assets/table/leather_normal.webp", { srgb: false, fallback: leatherNormal, repeat: [40, 2] }),
      leatherR: assetTexture("/assets/table/leather_roughness.webp", { srgb: false, repeat: [40, 2] }),
      brass: assetTexture("/assets/table/brass_color.webp", { repeat: [60, 1] }),
      brassN: assetTexture("/assets/table/brass_normal.webp", { srgb: false, repeat: [60, 1] }),
      brassR: assetTexture("/assets/table/brass_roughness.webp", { srgb: false, repeat: [60, 1] }),
      logo: assetTexture(`/assets/table/logo_${lang === "ru" ? "ru" : "en"}.webp`, { fallback: emblemTexture }),
    };
  }, [feltColor, feltId, A, B, lang]);
  const vign = useMemo(() => vignetteTexture(), []);
  useEffect(() => () => vign.dispose(), [vign]);

  const geo = useMemo(() => {
    const feltG = new THREE.CircleGeometry(1, 160);
    feltG.rotateX(-Math.PI / 2);
    feltG.scale(A, 1, B);
    const brass = new THREE.TubeGeometry(new Ellipse3(A + 0.04, B + 0.04, 0.035), 256, 0.03, 10, true);
    const brass2 = new THREE.TubeGeometry(new Ellipse3(A + 0.32, B + 0.32, 0.07), 256, 0.018, 8, true);
    const arm = new THREE.TubeGeometry(new Ellipse3(A + 0.78, B + 0.78, 0.2), 256, 0.42, 20, true);
    arm.scale(1, 0.62, 1);
    // walnut rail: flat elliptical ring between the felt and the armrest
    const ringShape = new THREE.Shape();
    ringShape.absellipse(0, 0, A + 0.5, B + 0.5, 0, Math.PI * 2, false, 0);
    const hole = new THREE.Path();
    hole.absellipse(0, 0, A + 0.02, B + 0.02, 0, Math.PI * 2, true, 0);
    ringShape.holes.push(hole);
    const rail = new THREE.ExtrudeGeometry(ringShape, { depth: 0.09, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 3, curveSegments: 160 });
    rail.rotateX(-Math.PI / 2);
    // planar UVs so the grain runs around the rail
    const pos = rail.attributes.position as THREE.BufferAttribute;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      uv[i * 2] = (Math.atan2(z / B, x / A) / (Math.PI * 2)) * 6;
      uv[i * 2 + 1] = Math.hypot(x / A, z / B) * 4;
    }
    rail.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const apron = new THREE.CylinderGeometry(1, 0.96, 0.7, 160, 1, true);
    apron.scale(A + 1.15, 1, B + 1.15);
    const pedestal = new THREE.CylinderGeometry(1.1, 1.6, 2.4, 48);
    const floor = new THREE.CircleGeometry(30, 64);
    floor.rotateX(-Math.PI / 2);
    const emblemG = new THREE.PlaneGeometry(3.6, 1.8);
    emblemG.rotateX(-Math.PI / 2);
    const vignG = new THREE.CircleGeometry(1, 96);
    vignG.rotateX(-Math.PI / 2);
    vignG.scale(A, 1, B);
    return { feltG, brass, brass2, arm, rail, apron, pedestal, floor, emblemG, vignG };
  }, [A, B]);

  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo]);

  return (
    <group>
      <mesh geometry={geo.feltG} receiveShadow>
        <meshStandardMaterial map={tex.felt} normalMap={tex.feltN} roughnessMap={tex.feltR} normalScale={new THREE.Vector2(0.6, 0.6)} roughness={1} metalness={0} envMapIntensity={0.25} />
      </mesh>
      <mesh geometry={geo.vignG} position={[0, 0.002, 0]} renderOrder={1}>
        <meshBasicMaterial map={vign} transparent depthWrite={false} />
      </mesh>
      <mesh geometry={geo.emblemG} position={[0, 0.003, dims.portrait ? -0.3 : 0.1]} rotation={[0, dims.portrait ? Math.PI / 2 : 0, 0]} renderOrder={2}>
        <meshStandardMaterial map={tex.logo} transparent opacity={0.55} depthWrite={false} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh geometry={geo.brass} castShadow>
        <meshStandardMaterial map={tex.brass} normalMap={tex.brassN} roughnessMap={tex.brassR} metalness={1} roughness={1} />
      </mesh>
      <mesh geometry={geo.rail} receiveShadow castShadow position={[0, -0.04, 0]}>
        <meshPhysicalMaterial map={tex.walnut} normalMap={tex.walnutN} roughnessMap={tex.walnutR} roughness={1} clearcoat={0.8} clearcoatRoughness={0.16} metalness={0} />
      </mesh>
      <mesh geometry={geo.brass2}>
        <meshStandardMaterial map={tex.brass} normalMap={tex.brassN} roughnessMap={tex.brassR} metalness={1} roughness={1} />
      </mesh>
      <mesh geometry={geo.arm} castShadow receiveShadow>
        <meshPhysicalMaterial map={tex.leather} normalMap={tex.leatherN} roughnessMap={tex.leatherR} normalScale={new THREE.Vector2(0.8, 0.8)} roughness={1} clearcoat={0.12} clearcoatRoughness={0.6} />
      </mesh>
      <mesh geometry={geo.apron} position={[0, -0.25, 0]} receiveShadow>
        <meshStandardMaterial map={tex.walnut} normalMap={tex.walnutN} color="#a07a5a" roughness={0.5} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geo.pedestal} position={[0, -1.8, 0]}>
        <meshStandardMaterial color="#0d0a08" roughness={0.6} />
      </mesh>
      <mesh geometry={geo.floor} position={[0, -3, 0]} receiveShadow>
        <meshStandardMaterial color="#0a0807" roughness={0.9} />
      </mesh>
    </group>
  );
}
