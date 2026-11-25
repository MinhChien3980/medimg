import { OrbitControls } from '@react-three/drei';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  DoubleSide,
  Mesh,
  Plane,
  Vector3,
  type BufferGeometry,
  type PerspectiveCamera,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fitCamera } from '../../lib/camera';
import { isKept, unionBounds, type Bounds } from '../../lib/clipping';
import { artifactKey } from '../structures';
import type { MeshSceneProps, SceneStructure } from './MeshScene.types';

const FOV = 35;

interface ControlsHandle {
  target: Vector3;
  update: () => void;
}
/** Pointer travel (px) above which a click is an orbit drag, not a pick. */
const CLICK_TOLERANCE_PX = 4;

/** One geometry per GLB, in LPS mm (node transforms baked in). */
async function loadGeometry(loader: GLTFLoader, url: string): Promise<BufferGeometry> {
  const gltf = await loader.loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  gltf.scene.traverse((node) => {
    if (node instanceof Mesh) {
      const geometry = (node.geometry as BufferGeometry).clone();
      geometry.applyMatrix4(node.matrixWorld);
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
      }
      parts.push(geometry);
    }
  });
  if (parts.length === 0) throw new Error(`No mesh in ${artifactKey(url)}`);
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  for (const part of parts) if (part !== merged) part.dispose();
  if (!merged) throw new Error(`Cannot merge the meshes of ${artifactKey(url)}`);
  if (!merged.getAttribute('normal')) merged.computeVertexNormals();
  merged.computeBoundingBox();
  return merged;
}

function boundsOf(geometry: BufferGeometry): Bounds | null {
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return null;
  return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
}

/** react-three-fiber scene of the segmented structures (lazy chunk with three.js). */
export default function MeshScene({ ariaLabel, ...props }: MeshSceneProps) {
  return (
    <Canvas
      className="mesh-scene"
      role="img"
      aria-label={ariaLabel}
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ fov: FOV, near: 1, far: 20_000, position: [0, -800, 0], up: [0, 0, 1] }}
    >
      <color attach="background" args={['#05080b']} />
      <ambientLight intensity={0.45} />
      <hemisphereLight args={['#ffffff', '#2b3a48', 0.6]} />
      <directionalLight position={[300, -600, 500]} intensity={1.4} />
      <directionalLight position={[-400, 500, -300]} intensity={0.5} />
      <SceneContent {...props} />
    </Canvas>
  );
}

type SceneContentProps = Omit<MeshSceneProps, 'ariaLabel'>;

function SceneContent({
  structures,
  clipPlanes,
  onBoundsChange,
  onPick,
  onLoadError,
  fitSignal,
}: SceneContentProps) {
  // three.js objects are mutated imperatively, so they are read from the store inside effects.
  const getState = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const loader = useMemo(() => new GLTFLoader(), []);
  const requested = useRef(new Set<string>());
  const loaded = useRef(new Map<string, BufferGeometry>());
  const mounted = useRef(false);
  const [geometries, setGeometries] = useState<ReadonlyMap<string, BufferGeometry>>(
    () => new Map(),
  );
  const userMoved = useRef(false);

  const reportBounds = useEffectEvent((bounds: Bounds | null) => onBoundsChange(bounds));
  const reportError = useEffectEvent((label: string) => onLoadError(label));

  // GPU buffers live as long as the scene; loads still in flight at unmount are dropped.
  useEffect(() => {
    mounted.current = true;
    const geometryCache = loaded.current;
    const requestCache = requested.current;
    return () => {
      mounted.current = false;
      for (const g of geometryCache.values()) g.dispose();
      geometryCache.clear();
      requestCache.clear();
    };
  }, []);

  // Each GLB is fetched once per object path (a refreshed presigned URL is the same mesh), and a
  // load is not abandoned when the structures change (e.g. a new colour) while it is in flight.
  useEffect(() => {
    for (const s of structures) {
      const key = artifactKey(s.url);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      loadGeometry(loader, s.url).then(
        (geometry) => {
          if (!mounted.current || loaded.current.has(key)) {
            geometry.dispose();
            return;
          }
          loaded.current.set(key, geometry);
          setGeometries(new Map(loaded.current));
        },
        (error: unknown) => {
          console.error('[3D] cannot load mesh', s.label, error);
          requested.current.delete(key);
          if (mounted.current) reportError(s.label);
        },
      );
    }
  }, [structures, loader]);

  const bounds = useMemo(
    () =>
      unionBounds([...geometries.values()].map(boundsOf).filter((b): b is Bounds => b !== null)),
    [geometries],
  );

  useEffect(() => {
    reportBounds(bounds);
  }, [bounds]);

  const applyFit = useEffectEvent(() => {
    if (!bounds) return;
    const { camera: anyCamera, size, controls: anyControls } = getState();
    const camera = anyCamera as PerspectiveCamera;
    // `makeDefault` registers the OrbitControls as the scene's default controls.
    const controls = anyControls as unknown as ControlsHandle | null;
    const fit = fitCamera(bounds, camera.fov, size.width / Math.max(size.height, 1));
    camera.up.set(...fit.up);
    camera.position.set(...fit.position);
    camera.near = fit.near;
    camera.far = fit.far;
    camera.updateProjectionMatrix();
    controls?.target.set(...fit.target);
    controls?.update();
    invalidate();
  });

  // Frame the meshes as they arrive until the user moves the camera; the Fit button always does.
  useEffect(() => {
    if (!userMoved.current) applyFit();
  }, [bounds]);
  useEffect(() => {
    if (fitSignal === 0) return;
    userMoved.current = false;
    applyFit();
  }, [fitSignal]);

  useEffect(() => {
    getState().gl.clippingPlanes = clipPlanes.map(
      (p) => new Plane(new Vector3(...p.normal), p.constant),
    );
    invalidate();
  }, [getState, clipPlanes, invalidate]);

  return (
    <>
      {structures.map((s) => {
        const geometry = geometries.get(artifactKey(s.url));
        return geometry ? (
          <StructureMesh
            key={s.label}
            structure={s}
            geometry={geometry}
            onPick={(e) => {
              if (!s.visible || e.delta > CLICK_TOLERANCE_PX) return;
              const point = e.point;
              if (!isKept([point.x, point.y, point.z], clipPlanes)) return;
              e.stopPropagation();
              onPick(s.label);
            }}
          />
        ) : null;
      })}
      <OrbitControls
        makeDefault
        enableDamping={false}
        onStart={() => {
          userMoved.current = true;
        }}
      />
    </>
  );
}

function StructureMesh({
  structure,
  geometry,
  onPick,
}: {
  structure: SceneStructure;
  geometry: BufferGeometry;
  onPick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const opaque = structure.opacity >= 0.999;
  return (
    <mesh
      geometry={geometry}
      visible={structure.visible && structure.opacity > 0}
      name={structure.label}
      onClick={onPick}
      renderOrder={opaque ? 0 : 1}
    >
      <meshStandardMaterial
        color={structure.color}
        transparent={!opaque}
        opacity={structure.opacity}
        depthWrite={opaque}
        side={DoubleSide}
        roughness={0.55}
        metalness={0.05}
      />
    </mesh>
  );
}
