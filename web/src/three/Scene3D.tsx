// WebGL casino table (lazy-loaded). Renders the game view in 3D; the HTML
// HUD lives in GameStage. Cards animate by tweening to layout targets.
import { Environment, Html, Lightformer } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { GameState, Step } from "../api";
import type { Bubble } from "../components/Board";
import { Plaque } from "../hud/Plaque";
import { I18nProvider, useI18n } from "../i18n";
import type { SortMode } from "../prefs";
import { Card3D, disposeCardResources } from "./Cards";
import { CARD_H, CARD_W, LANDSCAPE, PORTRAIT, computeLayout, type Dims } from "./layout";
import { Table } from "./Table";
import { backTexture, disposeAll, roomEnv, setMaxAnisotropy } from "./textures";

export type Quality = "low" | "medium" | "high";

export interface SceneApi {
  /** ms until all running card animations have finished */
  settleMs: () => number;
}

export type SceneMode = "title" | "lobby" | "game";

export interface Scene3DProps {
  mode?: SceneMode;
  view: GameState | null;
  step: Step | null;
  sort: SortMode;
  reveal: boolean;
  legal: Set<number>;
  canAct: boolean;
  hintAction: number | null;
  selected: number | null;
  onPlay: (a: number) => void;
  speed: number; // 0 = instant
  quality: Quality;
  theme: string;
  back: string;
  fourColor: boolean;
  bubbles: Record<number, Bubble>;
  thinkingSeat: number | null;
  winProb: Record<string, number>;
  showWinProb: boolean;
  botLabelOf: (n: string) => string;
  apiRef: { current: SceneApi | null };
  onSound: (kind: "snap" | "deal") => void;
}

const QUALITY = {
  low: { dpr: [1, 1] as [number, number], shadows: false, post: false, map: 512 },
  medium: { dpr: [1, 1.5] as [number, number], shadows: true, post: true, map: 1024 },
  high: { dpr: [1, 2] as [number, number], shadows: true, post: true, map: 2048 },
};

const SHARED_LOOK = new THREE.Vector3(0, 0.5, 0);

function CameraRig({ dims, focus, mode = "game" }: { dims: Dims; focus: boolean; mode?: SceneMode }) {
  const { camera, size } = useThree();
  const base = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  // shared across remounts so title -> lobby -> table is one continuous move
  const lookNow = useRef(SHARED_LOOK);
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / size.height;
    if (dims.portrait) {
      cam.fov = 50;
      base.current.set(0, 12.2 + Math.max(0, 0.55 - aspect) * 8, 9.4);
      look.current.set(0, 0, 1.15);
    } else {
      cam.fov = 34;
      const extra = Math.max(0, 1.75 - aspect) * 5.2;
      base.current.set(0, 8.4 + extra * 0.55, 9.9 + extra);
      look.current.set(0, 0, 0.2);
    }
    cam.near = 0.5;
    cam.far = 80;
    cam.updateProjectionMatrix();
  }, [camera, size.width, size.height, dims.portrait, mode]);
  const tmp = useRef(new THREE.Vector3());
  const lookTarget = useRef(new THREE.Vector3());
  useFrame((state, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    const target = tmp.current;
    const tm = state.clock.elapsedTime;
    const lt = lookTarget.current;
    let rate = 2.2;
    if (mode === "title") {
      // slow cinematic orbit around the table
      const a = Math.sin(tm * 0.035) * 0.55;
      const r = dims.portrait ? 15.5 : 12.5;
      target.set(Math.sin(a) * r, (dims.portrait ? 12 : 8.2) + Math.sin(tm * 0.21) * 0.35, Math.cos(a) * r);
      lt.set(0, dims.portrait ? 3.2 : 2.6, 0);
      rate = 0.9;
    } else if (mode === "lobby") {
      const a = Math.sin(tm * 0.08) * 0.35 - 0.2;
      const r = dims.portrait ? 14 : 12.5;
      target.set(Math.sin(a) * r, dims.portrait ? 12.5 : 8.2, Math.cos(a) * r);
      lt.set(0, -0.5, 0);
      rate = 1.1;
    } else {
      target.copy(base.current);
      if (focus) target.add(new THREE.Vector3(0, -0.25, -0.3));
      target.x += state.pointer.x * 0.18;
      target.y += state.pointer.y * 0.08;
      lt.copy(look.current);
      rate = 1.9;
    }
    cam.position.lerp(target, Math.min(1, dt * rate));
    lookNow.current.lerp(lt, Math.min(1, dt * rate * 1.2));
    cam.lookAt(lookNow.current);
  });
  return null;
}

/** Decorative cards for the title screen and lobby (no game in progress). */
function IdleContent({ dims, back, four, speed, registry, settle }: { dims: Dims; back: string; four: boolean; speed: number; registry: Map<string, THREE.Object3D>; settle: { until: number } }) {
  const targets = useMemo(() => {
    const deck: [number, number, number] = dims.portrait ? [-1.6, 0, 2.2] : [-3.2, 0, 0.9];
    const showcase = [8, 34, 24, 14, 31]; // A♠ K♥ Q♦ J♣ 10♥
    const out: import("./layout").CardTarget[] = showcase.map((c, i) => {
      const off = i - 2;
      return {
        key: `c${c}`,
        card: c,
        pos: [off * 0.62 + (dims.portrait ? 0 : 0.6), 0.012 + i * 0.004, 0.55 + Math.abs(off) * 0.12] as [number, number, number],
        rot: [-Math.PI / 2, -off * 0.16, 0] as [number, number, number],
        faceUp: true,
        scale: 1.15,
        zone: "table" as const,
        spawn: { pos: [deck[0], 0.4, deck[2]] as [number, number, number], rot: [-Math.PI / 2 * -1, 0, 0] as [number, number, number], faceUp: false },
        delay: 0.6 + i * 0.16,
      };
    });
    out.push({ key: "idle-b1", card: null, pos: [2.9, 0.012, -0.4], rot: [-Math.PI / 2, 0.7, 0], faceUp: false, scale: 1, zone: "discard" });
    out.push({ key: "idle-b2", card: null, pos: [3.2, 0.018, -0.1], rot: [-Math.PI / 2, 0.2, 0], faceUp: false, scale: 1, zone: "discard" });
    return { out, deck };
  }, [dims.portrait]);
  return (
    <>
      <TalonStack pos={targets.deck} count={22} back={back} />
      {targets.out.map((tg) => (
        <Card3D
          key={tg.key}
          t={tg}
          back={back}
          four={four}
          speed={speed || 0.8}
          legal={false}
          dim={false}
          hint={false}
          selected={false}
          hovered={false}
          registry={registry}
          settle={settle}
        />
      ))}
    </>
  );
}

function TalonStack({ pos, count, back }: { pos: [number, number, number]; count: number; back: string }) {
  const tex = useMemo(() => backTexture(back), [back]);
  const h = Math.max(0.004, count * 0.0085);
  const mats = useMemo(() => {
    const side = new THREE.MeshStandardMaterial({ color: "#e9dfc8", roughness: 0.8 });
    const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.38 });
    return [side, side, top, side, side, side];
  }, [tex]);
  useEffect(() => () => mats.forEach((m) => m !== mats[2] && m.dispose()), [mats]);
  if (count <= 1) return null;
  return (
    <mesh position={[pos[0], 0.012 + h / 2, pos[2]]} rotation={[0, 0.03, 0]} castShadow receiveShadow material={mats}>
      <boxGeometry args={[CARD_W * 0.95, h, CARD_H * 0.95]} />
    </mesh>
  );
}

function HandKey({ dims }: { dims: Dims }) {
  const ref = useRef<THREE.SpotLight>(null);
  const tgt = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    if (ref.current) ref.current.target = tgt;
  }, [tgt]);
  const z = dims.B + (dims.portrait ? 1.25 : 0.5);
  return (
    <>
      <primitive object={tgt} position={[0, 1.1, z]} />
      <spotLight ref={ref} position={[0, 13, z + 2.5]} angle={0.62} penumbra={1} intensity={150} decay={2} distance={30} color="#fff8f0" />
    </>
  );
}

function Lights({ shadows, mapSize, dims }: { shadows: boolean; mapSize: number; dims: Dims }) {
  const spot = useRef<THREE.SpotLight>(null);
  const tgt = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    if (spot.current) spot.current.target = tgt;
  }, [tgt]);
  return (
    <>
      <primitive object={tgt} position={[0, 0, dims.portrait ? 0.4 : 0.6]} />
      <ambientLight intensity={0.08} color="#ffe2b8" />
      <hemisphereLight args={["#ffe9c9", "#0a0705", 0.22]} />
      <spotLight
        ref={spot}
        position={[0, 12, 2.2]}
        angle={dims.portrait ? 0.6 : 0.68}
        penumbra={0.85}
        intensity={300}
        decay={2}
        distance={40}
        color="#ffdcae"
        castShadow={shadows}
        shadow-mapSize-width={mapSize}
        shadow-mapSize-height={mapSize}
        shadow-bias={-0.00025}
        shadow-normalBias={0.02}
        shadow-radius={6}
        shadow-camera-near={5}
        shadow-camera-far={20}
      />
      <directionalLight position={[-6, 6, -8]} intensity={0.55} color="#9fb8ff" />
      {/* soft key on the player's hand (cards face the camera, away from the spot) */}
      <HandKey dims={dims} />
    </>
  );
}

function Rig({ apiRef, registry, settle }: { apiRef: Scene3DProps["apiRef"]; registry: Map<string, THREE.Object3D>; settle: { until: number } }) {
  const { camera, gl } = useThree();
  useEffect(() => {
    apiRef.current = { settleMs: () => Math.max(0, (settle.until - performance.now() / 1000) * 1000) };
    const v = new THREE.Vector3();
    (window as unknown as { __durakTest?: unknown }).__durakTest = {
      ready: true,
      cardScreen(card: number) {
        const o = registry.get(`c${card}`);
        if (!o) return null;
        o.updateWorldMatrix(true, false);
        // aim slightly above the centre: the visible, unobstructed part of a fanned card
        v.set(0, CARD_H * 0.25, 0).applyMatrix4(o.matrixWorld).project(camera);
        const r = gl.domElement.getBoundingClientRect();
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
      },
      zone(card: number) {
        return (registry.get(`c${card}`)?.userData as { zone?: string } | undefined)?.zone ?? null;
      },
    };
    return () => {
      apiRef.current = null;
      delete (window as unknown as { __durakTest?: unknown }).__durakTest;
    };
  }, [apiRef, registry, settle, camera, gl]);
  return null;
}

function Content(p: Scene3DProps & { dims: Dims; view: GameState }) {
  const { view, dims } = p;
  const { t, lang } = useI18n();
  const { camera, size } = useThree();
  const registry = useMemo(() => new Map<string, THREE.Object3D>(), []);
  const settle = useMemo(() => ({ until: 0 }), []);
  const [hovered, setHovered] = useState<number | null>(null);
  // drag a hand card upwards and release anywhere to play it
  const drag = useRef<{ card: number; y: number } | null>(null);
  const onPlayRef = useRef(p.onPlay);
  onPlayRef.current = p.onPlay;
  useEffect(() => {
    const up = (e: PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      if (d && d.y - e.clientY > 40) onPlayRef.current(d.card);
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  // discard memory (ids that went to "bita")
  const discard = useRef<{ game: string; ids: number[]; seen: number }>({ game: "", ids: [], seen: -1 });
  const dealt = useRef<string>("");
  if (discard.current.game !== view.game_id) discard.current = { game: view.game_id, ids: view.discard ?? [], seen: -1 };
  if (view.discard) discard.current.ids = view.discard;
  if (p.step && p.step.seq !== discard.current.seen) {
    discard.current.seen = p.step.seq;
    for (const e of p.step.events) if (e.type === "bita") discard.current.ids = [...discard.current.ids.filter((c) => !e.cards.includes(c)), ...e.cards];
  }
  const dealing = dealt.current !== view.game_id && view.moves === 0;
  useEffect(() => {
    dealt.current = view.game_id;
  });

  // visible world width at the hand plane
  const handWidth = useMemo(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const d = dims.portrait ? 11.4 : 9.0;
    // leave room for the HUD (your plaque on the left, actions on the right)
    return 2 * d * Math.tan(((cam.fov || 36) * Math.PI) / 360) * (size.width / size.height) * (dims.portrait ? 0.84 : 0.6);
  }, [camera, size.width, size.height, dims.portrait]);

  const { targets, anchors } = useMemo(
    () =>
      computeLayout({
        view,
        dims,
        sort: p.sort,
        reveal: p.reveal,
        handWidth,
        discardIds: discard.current.ids,
        dealing,
        step: p.step,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, dims, p.sort, p.reveal, handWidth, p.step, dealing],
  );

  const lastSound = useRef(0);
  const onLand = (zone: string, fromSpawn: boolean) => {
    const now = performance.now();
    if (zone === "table") p.onSound("snap");
    else if (fromSpawn && now - lastSound.current > 45) {
      lastSound.current = now;
      p.onSound("deal");
    }
  };

  const bottom = view.human_seat ?? 0;
  const hint = p.hintAction;
  const q = QUALITY[p.quality];
  return (
    <>
      <Lights shadows={q.shadows} mapSize={q.map} dims={dims} />
      <Table dims={dims} theme={p.theme} lang={lang} />
      <TalonStack pos={anchors.talon} count={view.talon_size} back={p.back} />
      {targets.map((tg) => (
        <Card3D
          key={tg.key}
          t={tg}
          back={p.back}
          four={p.fourColor}
          speed={p.speed}
          legal={tg.zone === "hand" && tg.card !== null && p.canAct && p.legal.has(tg.card)}
          dim={tg.zone === "hand" && p.canAct && tg.card !== null && !p.legal.has(tg.card)}
          hint={hint !== null && tg.card === hint && tg.zone === "hand"}
          selected={tg.zone === "hand" && tg.card === p.selected}
          hovered={hovered === tg.card && tg.zone === "hand"}
          onHover={setHovered}
          onPlay={(c) => {
            if (drag.current && drag.current.card !== c) return;
            drag.current = null;
            p.onPlay(c);
          }}
          onDragStart={(card, y) => (drag.current = { card, y })}
          registry={registry}
          settle={settle}
          onLand={onLand}
        />
      ))}
      {!dims.portrait && view.players
        .filter((pl) => pl.seat !== bottom)
        .map((pl) => {
          const s = anchors.seats[pl.seat];
          if (!s) return null;
          return (
            <Html key={pl.seat} position={s.plaque} center zIndexRange={[40, 10]} wrapperClass="plaque-anchor" pointerEvents="none">
              <I18nProvider lang={lang}>
              <Plaque
                player={pl}
                state={view}
                thinking={p.thinkingSeat === pl.seat}
                bubble={p.bubbles[pl.seat]}
                botLabel={pl.bot ? p.botLabelOf(pl.bot) : undefined}
                winProb={view.mode === "spectate" && p.showWinProb ? p.winProb[String(pl.seat)] : undefined}
                compact={dims.portrait || view.num_players > 4}
              />
              </I18nProvider>
            </Html>
          );
        })}
      <Html position={[anchors.talon[0] + (dims.portrait ? 0.55 : 0), 0.05, anchors.talon[2] + (dims.portrait ? 1.05 : 1.2)]} center zIndexRange={[9, 0]} pointerEvents="none">
        <div className="felt-label talon-info" data-testid="talon-label">
          <span className={`trump-badge suit-${view.trump_suit}`} title={t("talon.trump")}>
            {["♠", "♣", "♦", "♥"][view.trump_suit]}&#xFE0E;
          </span>
          <span className="ti-text">
            <span className="ti-trump">{t("talon.trump")}</span>
            <span>
              <b>{view.talon_size}</b> {view.talon_size ? t("talon.left", { n: "" }).trim() : t("talon.empty")}
            </span>
          </span>
        </div>
      </Html>
      <Html position={[anchors.discard[0], 0.05, anchors.discard[2] + (dims.portrait ? 0.95 : 1.05)]} center zIndexRange={[9, 0]} pointerEvents="none">
        <div className="felt-label">{t("discard.label", { n: view.discard_count })}</div>
      </Html>
      <Rig apiRef={p.apiRef} registry={registry} settle={settle} />
      <CameraRig dims={dims} focus={p.canAct} mode="game" />
    </>
  );
}

/** Casino-room reflections + blurred room backdrop (falls back to Lightformers). */
function Room() {
  const { scene } = useThree();
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([roomEnv("/assets/env/room.webp"), roomEnv("/assets/env/room_blur.webp")]).then(([env, bg]) => {
      if (!alive) return;
      if (env) scene.environment = env;
      if (bg) {
        scene.background = bg;
        (scene as THREE.Scene & { backgroundIntensity: number }).backgroundIntensity = 0.5;
      }
      setOk(!!env);
    });
    return () => {
      alive = false;
    };
  }, [scene]);
  if (ok !== false) return null;
  return (
    <Environment resolution={128} frames={1}>
      <Lightformer form="rect" intensity={0.9} color="#ffe2b5" position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[6, 3, 1]} />
      <Lightformer form="rect" intensity={0.35} color="#9fb6ff" position={[-8, 3, -4]} rotation-y={Math.PI / 2} scale={[6, 2, 1]} />
    </Environment>
  );
}

function Effects({ quality }: { quality: Quality }) {
  if (!QUALITY[quality].post) return null;
  return (
    <EffectComposer multisampling={quality === "high" ? 4 : 0} enableNormalPass={false}>
      <Bloom mipmapBlur intensity={0.5} luminanceThreshold={0.95} luminanceSmoothing={0.08} radius={0.5} />
      <Vignette offset={0.22} darkness={0.78} eskil={false} />
    </EffectComposer>
  );
}

function DimsProvider(p: Scene3DProps) {
  const { size, gl } = useThree();
  useEffect(() => {
    setMaxAnisotropy(gl.capabilities.getMaxAnisotropy());
  }, [gl]);
  const dims = size.width / size.height < 0.95 ? PORTRAIT : LANDSCAPE;
  if (!p.view || (p.mode && p.mode !== "game")) return <IdleScene {...p} dims={dims} />;
  return <Content {...p} view={p.view} dims={dims} />;
}

function IdleScene(p: Scene3DProps & { dims: Dims }) {
  const { lang } = useI18n();
  const registry = useMemo(() => new Map<string, THREE.Object3D>(), []);
  const settle = useMemo(() => ({ until: 0 }), []);
  const q = QUALITY[p.quality];
  return (
    <>
      <Lights shadows={q.shadows} mapSize={q.map} dims={p.dims} />
      <Table dims={p.dims} theme={p.theme} lang={lang} />
      <IdleContent dims={p.dims} back={p.back} four={p.fourColor} speed={p.speed} registry={registry} settle={settle} />
      <CameraRig dims={p.dims} focus={false} mode={p.mode ?? "title"} />
    </>
  );
}

export default function Scene3D(p: Scene3DProps) {
  const q = QUALITY[p.quality];
  useEffect(
    () => () => {
      disposeCardResources();
      disposeAll();
    },
    [],
  );
  return (
    <Canvas
      className="scene-canvas"
      shadows={q.shadows ? "soft" : false}
      dpr={q.dpr}
      gl={{ antialias: !q.post || p.quality !== "high", powerPreference: "high-performance", preserveDrawingBuffer: false }}
      camera={{ position: [0, 8.4, 9.9], fov: 34 }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 0.95;
        scene.background = new THREE.Color("#050706");
        scene.fog = new THREE.Fog("#050706", 22, 42);
      }}
      data-testid="scene"
    >
      <Suspense fallback={null}>
        <Room />
        <DimsProvider {...p} />
        <Effects quality={p.quality} />
      </Suspense>
    </Canvas>
  );
}
