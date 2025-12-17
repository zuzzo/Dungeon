const { useEffect, useMemo, useRef, useState } = React;
const THREE = window.THREE;

/**
 * Dungeon Board Editor - TRUE 3D (No R3F / No Drei)
 *
 * This version removes react-three-fiber/drei to avoid runtime issues in some sandboxes.
 * It uses plain Three.js, managed from React via refs.
 *
 * Features:
 * - 4x4 grid
 * - Cells: floor / pit / water
 * - Edges: wall / door
 * - Objects: lever / trapdoor / torch / bridge
 * - Torches: real PointLight with selectable color
 * - Export PNG (uses renderer.domElement.toDataURL)
 */

const GRID_W = 4;
const GRID_H = 4;

type CellType = "floor" | "pit" | "water";
type EdgeType = "none" | "wall" | "door";
type ObjType = "none" | "lever" | "trapdoor" | "torch" | "bridge" | "light";

type ToolMode = "cells" | "edges" | "objects";

type LightProps = { color: string; intensity: number; distance: number; decay: number };
type ObjectPlacement = { type: ObjType; rotation: 0 | 90 | 180 | 270; light?: LightProps };
type CustomPlacement = { id: number; name: string; url: string; x: number; y: number; scale: number; yOffset: number; rotation: number };

type BoardState = {
  cells: CellType[];
  hEdges: EdgeType[]; // (H+1)*W
  vEdges: EdgeType[]; // H*(W+1)
  objects: ObjectPlacement[]; // W*H
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function idxCell(x: number, y: number) {
  return y * GRID_W + x;
}
function idxHEdge(x: number, y: number) {
  return y * GRID_W + x;
}
function idxVEdge(x: number, y: number) {
  return y * (GRID_W + 1) + x;
}

function makeEmptyState(): BoardState {
  return {
    cells: Array(GRID_W * GRID_H).fill("floor"),
    hEdges: Array((GRID_H + 1) * GRID_W).fill("none"),
    vEdges: Array(GRID_H * (GRID_W + 1)).fill("none"),
    objects: Array(GRID_W * GRID_H)
      .fill(null)
      .map(() => ({ type: "none", rotation: 0 })),
  };
}

function hexToRgb(hex: string) {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toThreeColor(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  return new THREE.Color(r / 255, g / 255, b / 255);
}

function rotateY(deg: 0 | 90 | 180 | 270) {
  return (deg * Math.PI) / 180;
}

// Deterministic, cheap 2D hash to avoid texture jitter when React re-renders
function stableOffset(x: number, y: number) {
  const seedA = (x * 73856093) ^ (y * 19349663);
  const seedB = (x * 83492791) ^ (y * 2654435761);
  const norm = 1 / 0xffffffff;
  return {
    u: ((seedA ^ (seedA >>> 16)) >>> 0) * norm,
    v: ((seedB ^ (seedB >>> 15)) >>> 0) * norm,
  };
}

type Pick =
  | { kind: "cell"; x: number; y: number }
  | { kind: "edge"; dir: "h" | "v"; x: number; y: number };

function DungeonBoardEditorTrue3D() {
  const [board, setBoard] = useState<BoardState>(() => makeEmptyState());

  const [mode, setMode] = useState<ToolMode>("cells");
  const [cellBrush, setCellBrush] = useState<CellType>("floor");
  const [edgeBrush, setEdgeBrush] = useState<Exclude<EdgeType, "none">>("wall");
  const [objectBrush, setObjectBrush] = useState<ObjType>("lever");
  const [lightBrush, setLightBrush] = useState<LightProps>({
    color: "#ffc878",
    intensity: 7.5,
    distance: 3.2,
    decay: 2.0,
  });
  const [selectedLightCell, setSelectedLightCell] = useState<number | null>(null);
  const [editingLight, setEditingLight] = useState<LightProps | null>(null);

  const [status, setStatus] = useState<string>("");

  const [cameraMode, setCameraMode] = useState<"top" | "iso">("iso");

  const [ambient, setAmbient] = useState(0.22);
  const [ambientColor, setAmbientColor] = useState("#ffffff");
  const [torchColor, setTorchColor] = useState("#ffc878");
  const [torchIntensity, setTorchIntensity] = useState(7.5);
  const [torchDistance, setTorchDistance] = useState(3.2);
  const [torchDecay, setTorchDecay] = useState(2.0);

  const [texFloorUrl, setTexFloorUrl] = useState<string | null>(null);
  const [texWaterUrl, setTexWaterUrl] = useState<string | null>(null);
  const [texPitUrl, setTexPitUrl] = useState<string | null>(null);
  const [texRepeat, setTexRepeat] = useState(2);
  const [waterOpacity, setWaterOpacity] = useState(0.78);

  const [renderScale, setRenderScale] = useState(3);
  const [customTemplates, setCustomTemplates] = useState<Record<string, THREE.Object3D>>({});
  const [customBrush, setCustomBrush] = useState<string | null>(null);
  const [customObjects, setCustomObjects] = useState<CustomPlacement[]>([]);
  const [selectedCustomId, setSelectedCustomId] = useState<number | null>(null);
  const nextCustomIdRef = useRef(1);

  // ---- Three refs ----
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  const rafRef = useRef<number | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseNdcRef = useRef(new THREE.Vector2());
  const texCacheRef = useRef<Record<string, THREE.Texture>>({});
  const waterUniformsRef = useRef<{ time: { value: number } }>({ time: { value: 0 } });
  const clockRef = useRef(new THREE.Clock());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const customMeshRef = useRef<Record<number, THREE.Object3D>>({});
  const dragStateRef = useRef<{ id: number | null; mode: "move" | "scale"; lastY: number }>({
    id: null,
    mode: "move",
    lastY: 0,
  });
  const importJsonRef = useRef<HTMLInputElement | null>(null);

  // A simple orbit-like camera controller (mouse drag rotates around origin)
  const orbitRef = useRef({
    isDown: false,
    lastX: 0,
    lastY: 0,
    yaw: Math.PI * 0.25,
    pitch: Math.PI * 0.28,
    dist: 9,
  });

  const cellSize = 1;
  const halfW = (GRID_W * cellSize) / 2;
  const halfH = (GRID_H * cellSize) / 2;

  function releaseTexture(url: string | null) {
    if (!url) return;
    const cached = texCacheRef.current[url];
    if (cached) {
      cached.dispose();
      delete texCacheRef.current[url];
    }
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  function clearUrl(current: string | null, setter: (url: string | null) => void) {
    releaseTexture(current);
    setter(null);
  }

  function setFromFile(setter: (url: string | null) => void) {
    return (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      const nextUrl = URL.createObjectURL(file);
      setter((prev) => {
        if (prev && prev !== nextUrl) releaseTexture(prev);
        return nextUrl;
      });
      ev.target.value = "";
    };
  }

  const gltfLoaderRef = useRef<THREE.GLTFLoader | null>(null);

  useEffect(() => {
    if (!gltfLoaderRef.current && (THREE as any).GLTFLoader) {
      gltfLoaderRef.current = new (THREE as any).GLTFLoader();
    }
  }, []);

  function loadCustomGlb(file: File) {
    const LoaderClass = (window as any).THREE?.GLTFLoader || (window as any).GLTFLoader;
    let loader: any = gltfLoaderRef.current;
    if (!loader && LoaderClass) loader = new LoaderClass();
    if (!loader) {
      console.error("GLTFLoader non trovato: assicurati che lo script sia caricato.");
      setStatus("GLTFLoader non disponibile.");
      setTimeout(() => setStatus(""), 1200);
      return;
    }
    gltfLoaderRef.current = loader;
    const url = URL.createObjectURL(file);
    loader.load(
      url,
      (gltf: any) => {
        const src = gltf.scene || gltf.scenes?.[0];
        if (!src) return;

        // Clone and normalize to cell size
        const scene = src.clone(true);
        const box = new THREE.Box3().setFromObject(scene);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        const maxSize = Math.max(size.x, size.y, size.z) || 1;
        const target = 0.8; // fit inside cell
        const scale = target / maxSize;
        // Pivot al centro: porta il bounding box al centro
        scene.position.sub(center);
        scene.scale.setScalar(scale);
        // Salva mezza altezza per appoggio a terra in fase di istanza
        (scene as any).userData.halfHeight = (size.y * scale) / 2;

        scene.traverse((n: any) => {
          if (n.isMesh) {
            n.castShadow = true;
            n.receiveShadow = true;
            if (n.material?.map) n.material.map.anisotropy = 4;
          }
        });

        const name = file.name.replace(/\\.glb$/i, "");
        setCustomTemplates((prev) => ({ ...prev, [name]: scene }));
        setCustomBrush(name);
        setStatus(`Caricato ${file.name}`);
        setTimeout(() => setStatus(""), 1200);
      },
      undefined,
      (err: any) => {
        console.error("Errore GLB", err);
        setStatus(`Errore nel caricare ${file.name}`);
        setTimeout(() => setStatus(""), 1200);
      }
    );
  }

  // Build / rebuild scene graph when board or lighting changes
  const sceneData = useMemo(() => {
    // Texture helper (cached)
    const getTexture = (url: string | null) => {
      if (!url) return null;
      const cached = texCacheRef.current[url];
      if (cached) {
        cached.repeat.set(texRepeat, texRepeat);
        return cached;
      }
      const tex = new THREE.TextureLoader().load(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(texRepeat, texRepeat);
      tex.anisotropy = 4;
      texCacheRef.current[url] = tex;
      return tex;
    };

    const floorMap = getTexture(texFloorUrl);
    const waterMap = getTexture(texWaterUrl);
    const pitMap = getTexture(texPitUrl);

    // Materials
    const makeWaterMaterial = () => {
      const matParams: THREE.MeshStandardMaterialParameters = {
        color: 0xffffff,
        roughness: 0.1,
        metalness: 0.05,
        transparent: true,
        opacity: waterOpacity,
      };
      if (waterMap) matParams.map = waterMap;
      const mat = new THREE.MeshStandardMaterial(matParams);
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.time = waterUniformsRef.current.time;
        shader.vertexShader = shader.vertexShader.replace(
          "void main() {",
          /* glsl */ `
          uniform float time;
          void main() {`
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          /* glsl */ `
          #include <begin_vertex>
          float wave = sin((position.x + position.z + time * 1.5) * 2.4) * 0.02;
          wave += cos((position.x - position.z + time * 1.1) * 1.8) * 0.015;
          transformed.y += wave;
          `
        );
      };
      return mat;
    };

    const mats = {
      floor: new THREE.MeshStandardMaterial(
        floorMap
          ? { color: 0xffffff, roughness: 0.95, metalness: 0.0, map: floorMap }
          : { color: 0xffffff, roughness: 0.95, metalness: 0.0 }
      ),
      water: makeWaterMaterial(),
      pit: new THREE.MeshStandardMaterial(
        pitMap
          ? { color: 0xffffff, roughness: 1.0, metalness: 0.0, map: pitMap }
          : { color: 0xffffff, roughness: 1.0, metalness: 0.0 }
      ),
      wall: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.85, metalness: 0.0 }),
      door: new THREE.MeshStandardMaterial({ color: 0x8b572a, roughness: 0.65, metalness: 0.05 }),
      bridge: new THREE.MeshStandardMaterial({ color: 0x6b3f09, roughness: 0.85, metalness: 0.0 }),
      lever: new THREE.MeshStandardMaterial({ color: 0x303030, roughness: 0.6, metalness: 0.05 }),
      trapdoor: new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9, metalness: 0.0 }),
      torch: new THREE.MeshStandardMaterial({ color: 0x7a4a00, roughness: 0.8, metalness: 0.0 }),
      flame: new THREE.MeshStandardMaterial({
        color: 0xffb14a,
        roughness: 0.3,
        metalness: 0.0,
        emissive: 0xff9a2e,
        emissiveIntensity: 0.7,
      }),
    } as const;

    // Geometries
    const wallHeight = 0.5 * 2; // altezza raddoppiata

    const makeBeveledTile = () => {
      const size = cellSize * 0.9; // lascia più spazio tra le celle
      const half = size / 2;
      const targetHeight = 0.14; // altezza originale del pavimento
      const depth = 0.12;
      const bevel = 0.04;
      const shape = new THREE.Shape();
      shape.moveTo(-half, -half);
      shape.lineTo(half, -half);
      shape.lineTo(half, half);
      shape.lineTo(-half, half);
      shape.lineTo(-half, -half);
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: bevel,
        bevelThickness: bevel,
      });
      geo.rotateX(-Math.PI / 2);
      geo.computeBoundingBox();
      const h = (geo.boundingBox?.max.y ?? 0) - (geo.boundingBox?.min.y ?? 0) || 1;
      geo.scale(1, targetHeight / h, 1);
      geo.computeBoundingBox();
      const box = geo.boundingBox!;
      const centerY = (box.max.y + box.min.y) / 2;
      geo.translate(0, targetHeight / 2 - centerY, 0);
      return geo;
    };

    const geo = {
      tile: makeBeveledTile(),
      // Più segmenti per rendere l'ondulazione meno rigida
      water: new THREE.BoxGeometry(cellSize * 0.92, 0.08, cellSize * 0.92, 12, 1, 12),
      pitInner: new THREE.BoxGeometry(cellSize * 0.82, 0.22, cellSize * 0.82),
      hedge: new THREE.BoxGeometry(cellSize, wallHeight, 0.14), // spessore raddoppiato
      vedge: new THREE.BoxGeometry(0.14, wallHeight, cellSize), // spessore raddoppiato
      leverRod: new THREE.CylinderGeometry(0.03, 0.03, 0.18, 16),
      leverKnob: new THREE.SphereGeometry(0.05, 18, 18),
      trap: new THREE.BoxGeometry(0.45, 0.06, 0.45),
      // Ponte più largo e lungo quanto la casella
      bridge: new THREE.BoxGeometry(cellSize, 0.08, 0.44),
      torch: new THREE.BoxGeometry(0.08, 0.18, 0.08),
      flame: new THREE.SphereGeometry(0.06, 18, 18),
    } as const;

    // Groups
    const root = new THREE.Group();

    // Pick plane (invisible, but we keep a reference)
    const pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID_W * cellSize, GRID_H * cellSize),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
    );
    pickPlane.name = "PICK_PLANE";
    pickPlane.rotation.x = -Math.PI / 2;
    pickPlane.position.set(0, 0.001, 0);
    root.add(pickPlane);

    // Base plane for shadows
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID_W * cellSize + 0.25, GRID_H * cellSize + 0.25),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.set(0, -0.01, 0);
    base.visible = false; // evita di vedere un piano grigio tra pavimento e baratro
    root.add(base);

    // Grid lines (visual separation between cells)
    const grid = new THREE.GridHelper(GRID_W * cellSize, GRID_W, 0x000000, 0x000000);
    grid.name = "GRID";
    grid.position.set(0, 0.151, 0); // slightly above tile tops
    // @ts-ignore
    if (grid.material) {
      // @ts-ignore
      grid.material.transparent = true;
      // @ts-ignore
      grid.material.opacity = 0.6;
      // @ts-ignore
      grid.material.depthWrite = false;
    }
    root.add(grid);

    // Tiles (skip pits here, handled later as merged regions)
    const isPit = (x: number, y: number) => board.cells[idxCell(x, y)] === "pit";

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = idxCell(x, y);
        const type = board.cells[i];
        if (type === "pit") continue;
        const cx = x * cellSize - halfW + cellSize / 2;
        const cz = y * cellSize - halfH + cellSize / 2;

        if (type === "water") {
          // Acqua: la cella e piena d'acqua (niente pavimento sotto visibile).
          const w = new THREE.Mesh(geo.water, mats.water);
          w.position.set(cx, 0.05, cz);
          w.castShadow = true;
          w.receiveShadow = true;
          root.add(w);
          continue;
        }

        let tileMat = mats.floor;
        if (floorMap) {
          const matClone = mats.floor.clone();
          const mapClone = floorMap.clone();
          const { u, v } = stableOffset(x, y);
          mapClone.offset.set(u, v);
          mapClone.needsUpdate = true;
          matClone.map = mapClone;
          tileMat = matClone;
        }
        const tile = new THREE.Mesh(geo.tile, tileMat);
        tile.position.set(cx, 0.07, cz);
        tile.castShadow = true;
        tile.receiveShadow = true;
        root.add(tile);
      }
    }

    // Merge pit regions into tapered frustums
    const visited = Array(GRID_W * GRID_H).fill(false);
    const pitHeight = 0.34;
    const bottomTaper = 0.6; // base più stretta
    const topInset = 0.92; // leggera incassatura visibile dall'alto
    const topDrop = 0.015;

    const neighbors = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    const pitRegions: { minX: number; maxX: number; minY: number; maxY: number }[] = [];

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const idx = idxCell(x, y);
        if (visited[idx] || !isPit(x, y)) continue;
        // BFS to find contiguous pit region
        let minX = x,
          maxX = x,
          minY = y,
          maxY = y;
        const queue: [number, number][] = [[x, y]];
        visited[idx] = true;
        while (queue.length) {
          const [cx, cy] = queue.shift()!;
          for (const [dx, dy] of neighbors) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
            const nIdx = idxCell(nx, ny);
            if (visited[nIdx] || !isPit(nx, ny)) continue;
            visited[nIdx] = true;
            queue.push([nx, ny]);
            minX = Math.min(minX, nx);
            maxX = Math.max(maxX, nx);
            minY = Math.min(minY, ny);
            maxY = Math.max(maxY, ny);
          }
        }
        pitRegions.push({ minX, maxX, minY, maxY });
      }
    }

    for (const region of pitRegions) {
      const wCells = region.maxX - region.minX + 1;
      const hCells = region.maxY - region.minY + 1;
      const width = wCells * cellSize;
      const depth = hCells * cellSize;
      const geom = new THREE.BoxGeometry(width, pitHeight, depth, 1, 1, 1);
      const pos = geom.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (y < 0) {
          pos.setX(i, x * bottomTaper);
          pos.setZ(i, z * bottomTaper);
        } else if (y > 0) {
          pos.setX(i, x * topInset);
          pos.setZ(i, z * topInset);
          pos.setY(i, y - topDrop);
        }
      }
      pos.needsUpdate = true;
      geom.computeVertexNormals();
      const pit = new THREE.Mesh(geom, mats.pit);
      const centerX = (region.minX + region.maxX + 1) * 0.5 * cellSize - halfW;
      const centerZ = (region.minY + region.maxY + 1) * 0.5 * cellSize - halfH;
      pit.position.set(centerX, -pitHeight / 2, centerZ);
      pit.castShadow = true;
      pit.receiveShadow = true;
      root.add(pit);
    }

    const buildDoor = () => {
      const gap = cellSize / 5; // luce dell'apertura
      const postThickness = (cellSize - gap) / 2;
      const depth = 0.16; // spessore raddoppiato
      const lintelHeight = 0.24; // altezza architrave raddoppiata
      const width = cellSize;

      const g = new THREE.Group();
      const postGeo = new THREE.BoxGeometry(postThickness, wallHeight, depth);
      const lintelGeo = new THREE.BoxGeometry(width - postThickness * 2, lintelHeight, depth);

      const p1 = new THREE.Mesh(postGeo, mats.door);
      p1.position.set(-width / 2 + postThickness / 2, wallHeight / 2, 0);
      p1.castShadow = true;
      p1.receiveShadow = true;

      const p2 = p1.clone();
      p2.position.set(width / 2 - postThickness / 2, wallHeight / 2, 0);

      const lintel = new THREE.Mesh(lintelGeo, mats.door);
      lintel.position.set(0, wallHeight - lintelHeight / 2, 0);
      lintel.castShadow = true;
      lintel.receiveShadow = true;

      g.add(p1, p2, lintel);
      return g;
    };

    const doorTemplate = buildDoor();

    // Edges: horizontal
    for (let y = 0; y < GRID_H + 1; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const e = board.hEdges[idxHEdge(x, y)];
        if (e === "none") continue;
        const cx = x * cellSize - halfW + cellSize / 2;
        const cz = y * cellSize - halfH;
        if (e === "wall") {
          const mesh = new THREE.Mesh(geo.hedge, mats.wall);
          mesh.position.set(cx, wallHeight / 2, cz);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          root.add(mesh);
        } else {
          const door = doorTemplate.clone();
          door.position.set(cx, 0, cz);
          root.add(door);
        }
      }
    }

    // Edges: vertical
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W + 1; x++) {
        const e = board.vEdges[idxVEdge(x, y)];
        if (e === "none") continue;
        const cx = x * cellSize - halfW;
        const cz = y * cellSize - halfH + cellSize / 2;
        if (e === "wall") {
          const mesh = new THREE.Mesh(geo.vedge, mats.wall);
          mesh.position.set(cx, wallHeight / 2, cz);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          root.add(mesh);
        } else {
          const door = doorTemplate.clone();
          door.position.set(cx, 0, cz);
          door.rotation.y = Math.PI / 2;
          root.add(door);
        }
      }
    }

    // Custom objects (instanced)
    const customRoot = new THREE.Group();
    customMeshRef.current = {};
    for (const c of customObjects) {
      const tpl = customTemplates[c.name];
      if (!tpl) continue;
      const inst = tpl.clone(true);
      inst.traverse((n: any) => {
        if (n.isMesh) {
          n.material = n.material?.clone?.() || n.material;
          n.castShadow = true;
          n.receiveShadow = true;
        }
      });
      const halfHgt = (tpl as any).userData?.halfHeight ?? 0;
      inst.position.set(c.x * cellSize - halfW + cellSize / 2, halfHgt + 0.02 + c.yOffset, c.y * cellSize - halfH + cellSize / 2);
      inst.scale.setScalar(c.scale);
      inst.rotation.y = (c.rotation * Math.PI) / 180;
      inst.name = `custom-${c.id}`;
      customMeshRef.current[c.id] = inst;
      customRoot.add(inst);
    }

    // Objects + torch meshes + light points
    const torchLightColor = toThreeColor(torchColor);
    let hasTorch = false;
    let hasLight = false;

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = idxCell(x, y);
        const obj = board.objects[i];
        if (!obj || obj.type === "none") continue;

        const cx = x * cellSize - halfW + cellSize / 2;
        const cz = y * cellSize - halfH + cellSize / 2;
        const rot = rotateY(obj.rotation);

        if (obj.type === "lever") {
          const g = new THREE.Group();
          g.position.set(cx, 0.12, cz);
          g.rotation.y = rot;

          const rod = new THREE.Mesh(geo.leverRod, mats.lever);
          rod.castShadow = true;
          const knob = new THREE.Mesh(geo.leverKnob, mats.lever);
          knob.position.set(0.06, 0.10, 0);
          knob.castShadow = true;
          g.add(rod);
          g.add(knob);
          root.add(g);
          continue;
        }

        if (obj.type === "trapdoor") {
          const m = new THREE.Mesh(geo.trap, mats.trapdoor);
          m.position.set(cx, 0.13, cz);
          m.rotation.y = rot;
          m.castShadow = true;
          root.add(m);
          continue;
        }

        if (obj.type === "bridge") {
          const m = new THREE.Mesh(geo.bridge, mats.bridge);
          m.position.set(cx, 0.16, cz);
          m.rotation.y = rot;
          m.castShadow = true;
          root.add(m);
          continue;
        }

        if (obj.type === "torch") {
          hasTorch = true;
          const g = new THREE.Group();
          g.position.set(cx, 0.22, cz);
          g.rotation.y = rot;

          const stick = new THREE.Mesh(geo.torch, mats.torch);
          stick.castShadow = true;
          const flame = new THREE.Mesh(geo.flame, mats.flame);
          flame.position.set(0, 0.16, 0);
          flame.castShadow = true;

          g.add(stick);
          g.add(flame);
          root.add(g);
          continue;
        }

        if (obj.type === "light" && obj.light) {
          hasLight = true;
          const l = new THREE.PointLight(toThreeColor(obj.light.color), obj.light.intensity, obj.light.distance, obj.light.decay);
          l.position.set(cx, 0.6, cz);
          l.castShadow = true;
          root.add(l);
          continue;
        }
      }
    }

    root.add(customRoot);

    return { root, pickPlane, hasTorch, hasLight, customRoot };
  }, [board, halfH, halfW, torchColor, torchDecay, torchDistance, torchIntensity, texFloorUrl, texWaterUrl, texPitUrl, texRepeat, waterOpacity, customObjects, customTemplates]);

  // Initialize renderer + scene once
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xfafafa);

    // Default camera is perspective; we switch logic based on cameraMode.
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = cam;

    host.appendChild(renderer.domElement);

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h, false);

      const c = cameraRef.current;
      if (!c) return;

      if ((c as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const pc = c as THREE.PerspectiveCamera;
        pc.aspect = w / h;
        pc.updateProjectionMatrix();
      } else {
        const oc = c as THREE.OrthographicCamera;
        const aspect = w / h;
        const frustum = 3.2;
        oc.left = -frustum * aspect;
        oc.right = frustum * aspect;
        oc.top = frustum;
        oc.bottom = -frustum;
        oc.updateProjectionMatrix();
      }
    };

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);

      const s = sceneRef.current;
      const c = cameraRef.current;
      const r = rendererRef.current;
      if (!s || !c || !r) return;

      // Update camera position from orbit state (iso only)
      if (cameraMode === "iso" && (c as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const o = orbitRef.current;
        const x = Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist;
        const y = Math.sin(o.pitch) * o.dist;
        const z = Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist;
        c.position.set(x, y, z);
        c.lookAt(0, 0, 0);
      }

      // Aggiorna onde acqua
      const clock = clockRef.current;
      if (clock) waterUniformsRef.current.time.value = clock.getElapsedTime();

      r.render(s, c);
    };

    // Mouse orbit
    const onDown = (ev: MouseEvent) => {
      if (cameraMode !== "iso") return;
      orbitRef.current.isDown = true;
      orbitRef.current.lastX = ev.clientX;
      orbitRef.current.lastY = ev.clientY;
    };
    const onMove = (ev: MouseEvent) => {
      if (cameraMode !== "iso") return;
      const o = orbitRef.current;
      if (!o.isDown) return;
      const dx = ev.clientX - o.lastX;
      const dy = ev.clientY - o.lastY;
      o.lastX = ev.clientX;
      o.lastY = ev.clientY;
      o.yaw += dx * 0.006;
      o.pitch = clamp(o.pitch - dy * 0.006, -1.15, 1.15);
    };
    const onUp = () => {
      orbitRef.current.isDown = false;
    };
    const onWheel = (ev: WheelEvent) => {
      if (cameraMode !== "iso") return;
      const o = orbitRef.current;
      o.dist = clamp(o.dist + ev.deltaY * 0.01, 4.5, 18);
    };

    window.addEventListener("resize", resize);
    renderer.domElement.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: true });

    resize();
    animate();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      renderer.domElement.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      renderer.domElement.removeEventListener("wheel", onWheel as any);

      try {
        host.removeChild(renderer.domElement);
      } catch {}

      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update camera type/mode
  useEffect(() => {
    const host = containerRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!host || !renderer || !scene) return;

    // Swap camera object to avoid complex branching
    let cam: THREE.PerspectiveCamera | THREE.OrthographicCamera;

    if (cameraMode === "top") {
      const aspect = host.clientWidth / host.clientHeight;
      const frustum = 3.2;
      cam = new THREE.OrthographicCamera(-frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 100);
      cam.position.set(0, 8, 0.001);
      cam.up.set(0, 0, -1);
      cam.lookAt(0, 0, 0);
    } else {
      cam = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.1, 100);
      // actual position is driven by orbit state in the render loop
      cam.position.set(6, 7, 6);
      cam.lookAt(0, 0, 0);
    }

    cameraRef.current = cam;

    // Resize to update projection
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setSize(w, h, false);
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      (cam as THREE.PerspectiveCamera).aspect = w / h;
      (cam as THREE.PerspectiveCamera).updateProjectionMatrix();
    } else {
      const oc = cam as THREE.OrthographicCamera;
      const aspect = w / h;
      const frustum = 3.2;
      oc.left = -frustum * aspect;
      oc.right = frustum * aspect;
      oc.top = frustum;
      oc.bottom = -frustum;
      oc.updateProjectionMatrix();
    }
  }, [cameraMode]);

  useEffect(() => {
    return () => {
      Object.values(texCacheRef.current).forEach((tex) => tex.dispose());
      texCacheRef.current = {};
    };
  }, []);

  // Rebuild scene content when board changes
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Clear previous root group (keep lights are inside root anyway)
    const old = scene.getObjectByName("ROOT");
    if (old) scene.remove(old);

    const root = sceneData.root;
    root.name = "ROOT";

    // Lights (global)
    // Clear previous global lights
    const olds = scene.children.filter((o) => o.name === "GLOBAL_LIGHT");
    olds.forEach((o) => scene.remove(o));

    const amb = new THREE.AmbientLight(new THREE.Color(ambientColor), ambient);
    amb.name = "GLOBAL_LIGHT";
    scene.add(amb);

    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.name = "GLOBAL_LIGHT";
    dir.position.set(6, 9, 4);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    (dir.shadow.camera as any).near = 1;
    (dir.shadow.camera as any).far = 30;
    (dir.shadow.camera as any).left = -6;
    (dir.shadow.camera as any).right = 6;
    (dir.shadow.camera as any).top = 6;
    (dir.shadow.camera as any).bottom = -6;
    scene.add(dir);

    if (sceneData.hasTorch || sceneData.hasLight) {
      const hemi = new THREE.HemisphereLight(0xffffff, 0x202020, 0.12);
      hemi.name = "GLOBAL_LIGHT";
      scene.add(hemi);
    }

    scene.add(root);
  }, [sceneData, ambient]);

  // Click -> pick
  function pickFromMouse(ev: React.MouseEvent) {
    if (ev.button !== 0) return; // solo click sinistro per piazzare
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);

    const mouse = mouseNdcRef.current;
    mouse.set(mx, my);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(mouse, camera);

    const pickPlane = scene.getObjectByName("PICK_PLANE") as THREE.Mesh | null;
    if (!pickPlane) return;

    const hits = raycaster.intersectObject(pickPlane, false);
    if (!hits.length) return;

    const p = hits[0].point;
    const lx = p.x + halfW;
    const lz = p.z + halfH;

    const cx = clamp(Math.floor(lx / cellSize), 0, GRID_W - 1);
    const cy = clamp(Math.floor(lz / cellSize), 0, GRID_H - 1);

    const localX = lx - cx * cellSize;
    const localZ = lz - cy * cellSize;

    const edgeSnap = 0.18 * cellSize;
    const dLeft = localX;
    const dRight = cellSize - localX;
    const dTop = localZ;
    const dBottom = cellSize - localZ;
    const minD = Math.min(dLeft, dRight, dTop, dBottom);

    // UX rule:
    // - In "Celle" and "Oggetti" modes we ALWAYS treat a click as a CELL click.
    // - Only in "Bordi" mode we snap to edges.
    let pick: Pick;
    if (mode !== "edges") {
      pick = { kind: "cell", x: cx, y: cy };
    } else {
      if (minD <= edgeSnap) {
        if (minD === dTop) pick = { kind: "edge", dir: "h", x: cx, y: cy };
        else if (minD === dBottom) pick = { kind: "edge", dir: "h", x: cx, y: cy + 1 };
        else if (minD === dLeft) pick = { kind: "edge", dir: "v", x: cx, y: cy };
        else pick = { kind: "edge", dir: "v", x: cx + 1, y: cy };
      } else {
        pick = { kind: "cell", x: cx, y: cy };
      }
    }

    applyPick(pick);
  }

  function getCellFromMouse(ev: MouseEvent | React.MouseEvent) {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    const mouse = mouseNdcRef.current;
    mouse.set(mx, my);
    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(mouse, camera);
    const pickPlane = scene.getObjectByName("PICK_PLANE") as THREE.Mesh | null;
    if (!pickPlane) return null;
    const hits = raycaster.intersectObject(pickPlane, false);
    if (!hits.length) return null;
    const p = hits[0].point;
    const lx = p.x + halfW;
    const lz = p.z + halfH;
    const cx = clamp(Math.floor(lx / cellSize), 0, GRID_W - 1);
    const cy = clamp(Math.floor(lz / cellSize), 0, GRID_H - 1);
    return { x: cx, y: cy };
  }

  function startCustomDrag(ev: React.MouseEvent) {
    if (ev.button !== 2) return;
    const cell = getCellFromMouse(ev);
    if (!cell) return;
    const target = [...customObjects].reverse().find((c) => c.x === cell.x && c.y === cell.y);
    if (!target) return;
    dragStateRef.current = { id: target.id, mode: ev.altKey ? "scale" : "move", lastY: ev.clientY };
    setSelectedCustomId(target.id);
    ev.preventDefault();
  }

  function handleCustomDrag(ev: React.MouseEvent) {
    const st = dragStateRef.current;
    if (!st || st.id === null) return;
    if (st.mode === "move") {
      const cell = getCellFromMouse(ev);
      if (!cell) return;
      setCustomObjects((prev) => prev.map((c) => (c.id === st.id ? { ...c, x: cell.x, y: cell.y } : c)));
    } else {
      const dy = (st.lastY - ev.clientY) * 0.01;
      st.lastY = ev.clientY;
      setCustomObjects((prev) => prev.map((c) => (c.id === st.id ? { ...c, scale: clamp(c.scale + dy, 0.3, 3) } : c)));
    }
  }

  function endCustomDrag(ev: React.MouseEvent) {
    if (ev.button === 2) {
      dragStateRef.current = { id: null, mode: "move", lastY: 0 };
    }
  }

  function updateSelectedCustom(partial: Partial<Pick<CustomPlacement, "scale" | "yOffset" | "rotation">>) {
    if (selectedCustomId === null) return;
    setCustomObjects((prev) =>
      prev.map((c) => (c.id === selectedCustomId ? { ...c, ...partial } : c))
    );
  }

  function applyPick(pick: Pick) {
    // Placement / erase for custom GLB objects (when brush is custom + gomma attiva)
    if (mode === "objects" && pick.kind === "cell" && customBrush && objectBrush === "none") {
      if (!customTemplates[customBrush]) {
        setStatus("Carica un oggetto prima di piazzarlo.");
        setTimeout(() => setStatus(""), 1200);
        return;
      }
      setCustomObjects((prev) => {
        const existingIdx = prev.findIndex((c) => c.x === pick.x && c.y === pick.y);
        if (existingIdx >= 0) {
          const copy = [...prev];
          const removed = copy.splice(existingIdx, 1)[0];
          if (removed && removed.id === selectedCustomId) setSelectedCustomId(null);
          return copy;
        }
        const id = nextCustomIdRef.current++;
        const created: CustomPlacement = { id, name: customBrush, url: customBrush, x: pick.x, y: pick.y, scale: 1, yOffset: 0, rotation: 0 };
        setSelectedCustomId(id);
        return [...prev, created];
      });
      return;
    }

    setBoard((prev) => {
      const next: BoardState = {
        cells: [...prev.cells],
        hEdges: [...prev.hEdges],
        vEdges: [...prev.vEdges],
        objects: prev.objects.map((o) => ({ ...o })),
      };

      if (pick.kind === "cell") {
        const i = idxCell(pick.x, pick.y);

        if (mode === "cells") {
          next.cells[i] = cellBrush;
          setStatus(
            `Cella (${pick.x + 1},${pick.y + 1}) = ${
              cellBrush === "floor" ? "Pavimento" : cellBrush === "pit" ? "Baratro" : "Acqua"
            }`
          );
          setTimeout(() => setStatus(""), 900);
          if (cellBrush === "floor" && next.objects[i]?.type === "bridge") next.objects[i] = { type: "none", rotation: 0 };
          return next;
        }
        if (mode === "objects") {
          // reset custom selection if we draw base objects
          setSelectedCustomId(null);
          if (objectBrush === "light") {
            const prevLight = next.objects[i];
            next.objects[i] = {
              type: "light",
              rotation: prevLight?.rotation ?? 0,
              light: { ...lightBrush },
            };
            setSelectedLightCell(i);
            setEditingLight({ ...lightBrush });
            return next;
          }

          if (objectBrush === "bridge") {
            const base = next.cells[i];
            if (base !== "water" && base !== "pit") {
              setStatus("Il ponte si puo piazzare solo su Acqua o Baratro.");
              setTimeout(() => setStatus(""), 1400);
              return prev;
            }
          }

          if (objectBrush === "none") {
            next.objects[i] = { type: "none", rotation: 0 };
            if (selectedLightCell === i) {
              setSelectedLightCell(null);
              setEditingLight(null);
            }
            return next;
          }

          if (next.objects[i].type === objectBrush) {
            next.objects[i].rotation = ((next.objects[i].rotation + 90) % 360) as 0 | 90 | 180 | 270;
          } else {
            next.objects[i].type = objectBrush;
            next.objects[i].rotation = 0;
            next.objects[i].light = undefined;
            if (selectedLightCell === i) {
              setSelectedLightCell(null);
              setEditingLight(null);
            }
          }
          return next;
        }
        setStatus("Sei in modalita Bordi: per dipingere Acqua/Baratro passa a 'Celle'.");
        setTimeout(() => setStatus(""), 1200);
        return prev;
      }

      if (pick.kind === "edge") {
        if (mode !== "edges") return prev;
        if (pick.dir === "h") {
          const id = idxHEdge(pick.x, pick.y);
          next.hEdges[id] = next.hEdges[id] === edgeBrush ? "none" : edgeBrush;
          return next;
        }
        const id = idxVEdge(pick.x, pick.y);
        next.vEdges[id] = next.vEdges[id] === edgeBrush ? "none" : edgeBrush;
        return next;
      }

      return prev;
    });
  }

  function resetAll() {
    setBoard(makeEmptyState());
    setStatus("Reset completato.");
    setTimeout(() => setStatus(""), 1200);
  }

  function exportJson() {
    const payload = {
      version: 1,
      board,
      customObjects,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dungeon_4x4.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importJson(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const data = JSON.parse(text);
        if (!data || typeof data !== "object") throw new Error("Formato invalido");
        if (!data.board || !data.board.cells || !data.board.hEdges || !data.board.vEdges || !data.board.objects) {
          throw new Error("Board mancante");
        }
        const nextBoard: BoardState = {
          cells: Array.isArray(data.board.cells) && data.board.cells.length === GRID_W * GRID_H ? data.board.cells : makeEmptyState().cells,
          hEdges:
            Array.isArray(data.board.hEdges) && data.board.hEdges.length === (GRID_H + 1) * GRID_W
              ? data.board.hEdges
              : makeEmptyState().hEdges,
          vEdges:
            Array.isArray(data.board.vEdges) && data.board.vEdges.length === GRID_H * (GRID_W + 1)
              ? data.board.vEdges
              : makeEmptyState().vEdges,
          objects:
            Array.isArray(data.board.objects) && data.board.objects.length === GRID_W * GRID_H
              ? data.board.objects
              : makeEmptyState().objects,
        };
        setBoard(nextBoard);

        if (Array.isArray(data.customObjects)) {
          setCustomObjects(
            data.customObjects
              .filter((c: any) => typeof c?.name === "string" && typeof c?.x === "number" && typeof c?.y === "number")
              .map((c: any) => ({
                id: typeof c.id === "number" ? c.id : nextCustomIdRef.current++,
                name: c.name,
                url: c.url ?? c.name,
                x: clamp(c.x, 0, GRID_W - 1),
                y: clamp(c.y, 0, GRID_H - 1),
                scale: typeof c.scale === "number" ? clamp(c.scale, 0.3, 3) : 1,
                yOffset: typeof c.yOffset === "number" ? clamp(c.yOffset, -1, 3) : 0,
                rotation: typeof c.rotation === "number" ? c.rotation : 0,
              }))
          );
        }
        setSelectedLightCell(null);
        setEditingLight(null);
        setSelectedCustomId(null);
        setStatus("Dungeon caricato.");
        setTimeout(() => setStatus(""), 1200);
      } catch (err) {
        console.error(err);
        setStatus("Errore nel caricare il JSON.");
        setTimeout(() => setStatus(""), 1500);
      }
    };
    reader.readAsText(file);
  }

  function exportPng() {
    const renderer = rendererRef.current;
    if (!renderer) return;

    // optional high-res export by resizing temporarily
    const host = containerRef.current;
    if (!host) return;

    const w = host.clientWidth;
    const h = host.clientHeight;

    const targetW = Math.floor(w * renderScale);
    const targetH = Math.floor(h * renderScale);

    const prevPixelRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(targetW, targetH, false);

    // draw once
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (scene && camera) renderer.render(scene, camera);

    const url = renderer.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `dungeon_4x4_three_${targetW}x${targetH}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // restore
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(prevPixelRatio);
  }

  // Helpers per luci
  const lights = board.objects
    .map((o, idx) => ({ o, idx }))
    .filter(({ o }) => o.type === "light" && o.light)
    .map(({ o, idx }) => ({
      idx,
      light: o.light as LightProps,
      x: idx % GRID_W,
      y: Math.floor(idx / GRID_W),
    }));

  useEffect(() => {
    // Se la luce selezionata viene cancellata o cambiata, azzera selezione
    if (selectedLightCell === null) return;
    const current = board.objects[selectedLightCell];
    if (!current || current.type !== "light" || !current.light) {
      setSelectedLightCell(null);
      setEditingLight(null);
    }
  }, [board, selectedLightCell]);

  function updateSelectedLight(partial: Partial<LightProps>) {
    if (selectedLightCell === null) return;
    const current = board.objects[selectedLightCell];
    if (!current || current.type !== "light" || !current.light) return;
    const updated = { ...current.light, ...partial };
    setEditingLight(updated);
    setBoard((prev) => {
      const objects = prev.objects.map((o, idx) =>
        idx === selectedLightCell && o.type === "light" ? { ...o, light: updated } : o
      );
      return { ...prev, objects };
    });
  }

  const CellsPanel = () => (
    <div className="tree-node">
      <div className="tree-label">Celle</div>
      <div className="tree-children">
        <div>
          <div className="section-title">Pennello cella</div>
          <div className="controls-grid">
            {(["floor", "pit", "water"] as CellType[]).map((t) => (
              <button key={t} className={`btn ${cellBrush === t ? "active" : ""}`} onClick={() => setCellBrush(t)}>
                {t === "floor" ? "Pavimento" : t === "pit" ? "Baratro" : "Acqua"}
              </button>
            ))}
          </div>
        </div>
        <div className="tree-node">
          <div className="tree-label">Texture</div>
          <div className="tree-children">
            <div className="stack">
              <div className="section-title">Pavimento (PNG/JPG)</div>
              <div className="small break-all">{texFloorUrl ?? "-"}</div>
              <div className="flex gap-6">
                <input type="file" accept="image/*" onChange={setFromFile(setTexFloorUrl)} />
                <button className="btn" onClick={() => clearUrl(texFloorUrl, setTexFloorUrl)}>
                  Pulisci
                </button>
              </div>
            </div>
            <div className="stack">
              <div className="section-title">Acqua (PNG/JPG)</div>
              <div className="small break-all">{texWaterUrl ?? "-"}</div>
              <div className="flex gap-6">
                <input type="file" accept="image/*" onChange={setFromFile(setTexWaterUrl)} />
                <button className="btn" onClick={() => clearUrl(texWaterUrl, setTexWaterUrl)}>
                  Pulisci
                </button>
              </div>
            </div>
            <div className="stack">
              <div className="section-title">Baratro (PNG/JPG)</div>
              <div className="small break-all">{texPitUrl ?? "-"}</div>
              <div className="flex gap-6">
                <input type="file" accept="image/*" onChange={setFromFile(setTexPitUrl)} />
                <button className="btn" onClick={() => clearUrl(texPitUrl, setTexPitUrl)}>
                  Pulisci
                </button>
              </div>
            </div>
            <div className="controls-grid">
              <label className="text-xs">
                <div className="section-title">Ripetizione texture</div>
                <input type="range" min={1} max={6} step={1} value={texRepeat} onChange={(e) => setTexRepeat(Number(e.target.value))} />
                <div className="small">{texRepeat}x per cella</div>
              </label>
              <label className="text-xs">
                <div className="section-title">Opacita acqua</div>
                <input type="range" min={0.4} max={1} step={0.01} value={waterOpacity} onChange={(e) => setWaterOpacity(Number(e.target.value))} />
                <div className="small">{waterOpacity.toFixed(2)}</div>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const EdgesPanel = () => (
    <div className="tree-node">
      <div className="tree-label">Bordi</div>
      <div className="tree-children">
        <div>
          <div className="section-title">Pennello bordo</div>
          <div className="controls-grid">
            {(["wall", "door"] as const).map((t) => (
              <button key={t} className={`btn ${edgeBrush === t ? "active" : ""}`} onClick={() => setEdgeBrush(t)}>
                {t === "wall" ? "Parete" : "Porta"}
              </button>
            ))}
          </div>
          <div className="hint">Clic vicino al bordo tra due celle per inserire/rimuovere.</div>
        </div>
      </div>
    </div>
  );

  const ObjectsPanel = () => (
    <div className="tree-node">
      <div className="tree-label">Oggetti</div>
      <div className="tree-children">
        <div className="tree-node">
          <div className="tree-label">Pennello base</div>
          <div className="controls-grid">
            {(["lever", "trapdoor", "torch", "bridge", "light"] as const).map((t) => (
              <button key={t} className={`btn ${objectBrush === t ? "active" : ""}`} onClick={() => setObjectBrush(t)}>
                {t === "lever" ? "Leva" : t === "trapdoor" ? "Botola" : t === "torch" ? "Torcia" : t === "bridge" ? "Ponte" : "Luce"}
              </button>
            ))}
            <button className={`btn ${objectBrush === "none" ? "active" : ""}`} onClick={() => setObjectBrush("none")}>
              Gomma
            </button>
          </div>
          <div className="hint">Ponte solo su Acqua/Baratro. Riclic per ruotare. Le luci sono punti luce.</div>
        </div>

        <div className="tree-node">
          <div className="tree-label">Oggetti custom (.glb)</div>
          <div className="flex gap-6">
            <button className="btn active" onClick={() => fileInputRef.current?.click()}>Aggiungi oggetto</button>
            <input
              ref={fileInputRef as any}
              type="file"
              accept=".glb"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadCustomGlb(file);
                e.target.value = "";
              }}
            />
          </div>
          {Object.keys(customTemplates).length > 0 && (
            <div className="controls-grid" style={{ marginTop: 8 }}>
              {Object.keys(customTemplates).map((name) => (
                <button
                  key={name}
                  className={`btn ${customBrush === name ? "active" : ""}`}
                  onClick={() => {
                    setCustomBrush(name);
                    setObjectBrush("none");
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          {Object.keys(customTemplates).length === 0 && <div className="hint">Carica un .glb per piazzarlo con click sinistro.</div>}
          {customBrush && <div className="hint">Tasto destro: trascina per spostare, destro + Alt per scalare. Uno per cella per nome.</div>}
        </div>

        <div className="tree-node">
          <div className="tree-label">Luci</div>
          <div className="controls-grid">
            <label className="text-xs">
              <div className="section-title">Ambiente (intensita)</div>
              <input type="range" min={0} max={0.8} step={0.01} value={ambient} onChange={(e) => setAmbient(Number(e.target.value))} />
            </label>
            <div className="text-xs">
              <div className="section-title">Colore ambiente</div>
              <div className="flex items-center gap-4">
                <input type="color" value={ambientColor} onChange={(e) => setAmbientColor(e.target.value)} />
                <input value={ambientColor} onChange={(e) => setAmbientColor(e.target.value)} />
              </div>
            </div>
            <div className="text-xs">
              <div className="section-title">Colore torcia (mesh)</div>
              <div className="flex items-center gap-4">
                <input type="color" value={torchColor} onChange={(e) => setTorchColor(e.target.value)} />
                <input value={torchColor} onChange={(e) => setTorchColor(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="section-title" style={{ marginTop: 8 }}>
            Luci puntiformi piazzate
          </div>
          {lights.length === 0 && <div className="hint">Nessuna luce: scegli "Luce" e clicca una cella.</div>}
          {lights.length > 0 && (
            <div className="stack">
              {lights.map((l) => (
                <button
                  key={l.idx}
                  className={`btn ${selectedLightCell === l.idx ? "active" : ""}`}
                  onClick={() => {
                    setSelectedLightCell(l.idx);
                    setEditingLight({ ...l.light });
                  }}
                >
                  Luce ({l.x + 1},{l.y + 1})
                </button>
              ))}
            </div>
          )}

          {selectedLightCell !== null && editingLight && (
            <div className="controls-grid">
              <label className="text-xs">
                <div className="section-title">Luce: intensita</div>
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={0.1}
                  value={editingLight.intensity}
                  onChange={(e) => updateSelectedLight({ intensity: Number(e.target.value) })}
                />
              </label>
              <label className="text-xs">
                <div className="section-title">Luce: distanza</div>
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={0.1}
                  value={editingLight.distance}
                  onChange={(e) => updateSelectedLight({ distance: Number(e.target.value) })}
                />
              </label>
              <label className="text-xs">
                <div className="section-title">Luce: decay</div>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.1}
                  value={editingLight.decay}
                  onChange={(e) => updateSelectedLight({ decay: Number(e.target.value) })}
                />
              </label>
              <div className="text-xs">
                <div className="section-title">Luce: colore</div>
                <div className="flex items-center gap-4">
                  <input
                    type="color"
                    value={editingLight.color}
                    onChange={(e) => updateSelectedLight({ color: e.target.value })}
                  />
                  <input
                    value={editingLight.color}
                    onChange={(e) => updateSelectedLight({ color: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}
          <div className="controls-grid">
            <label className="text-xs">
              <div className="section-title">Torcia: intensita (solo fiamma visiva)</div>
              <input type="range" min={0} max={20} step={0.1} value={torchIntensity} onChange={(e) => setTorchIntensity(Number(e.target.value))} />
            </label>
            <label className="text-xs">
              <div className="section-title">Torcia: distanza</div>
              <input type="range" min={1} max={8} step={0.1} value={torchDistance} onChange={(e) => setTorchDistance(Number(e.target.value))} />
            </label>
            <label className="text-xs">
              <div className="section-title">Torcia: decay</div>
              <input type="range" min={0} max={3} step={0.1} value={torchDecay} onChange={(e) => setTorchDecay(Number(e.target.value))} />
            </label>
          </div>
        </div>

        {customObjects.length > 0 && (
          <div className="tree-node">
            <div className="tree-label">Oggetti piazzati</div>
            <div className="stack">
              {customObjects.map((c) => (
                <button
                  key={c.id}
                  className={`btn ${selectedCustomId === c.id ? "active" : ""}`}
                  onClick={() => setSelectedCustomId(c.id)}
                >
                  {c.name} ({c.x + 1},{c.y + 1})
                </button>
              ))}
            </div>
            {selectedCustomId !== null && (
              <div className="controls-grid" style={{ marginTop: 6 }}>
                <label className="text-xs">
                  <div className="section-title">Scala</div>
                  <input
                    type="range"
                    min={0.3}
                    max={3}
                    step={0.05}
                    value={customObjects.find((c) => c.id === selectedCustomId)?.scale ?? 1}
                    onChange={(e) => updateSelectedCustom({ scale: Number(e.target.value) })}
                  />
                </label>
                <label className="text-xs">
                  <div className="section-title">Altezza (y)</div>
                  <input
                    type="range"
                    min={-1}
                    max={3}
                    step={0.02}
                    value={customObjects.find((c) => c.id === selectedCustomId)?.yOffset ?? 0}
                    onChange={(e) => updateSelectedCustom({ yOffset: Number(e.target.value) })}
                  />
                </label>
                <label className="text-xs">
                  <div className="section-title">Rotazione (gradi)</div>
                  <input
                    type="range"
                    min={0}
                    max={359}
                    step={1}
                    value={customObjects.find((c) => c.id === selectedCustomId)?.rotation ?? 0}
                    onChange={(e) => updateSelectedCustom({ rotation: Number(e.target.value) })}
                  />
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const CameraPanel = () => (
    <div className="tree-node">
      <div className="tree-label">Camera</div>
      <div className="controls-grid">
        <button className={`btn ${cameraMode === "iso" ? "active" : ""}`} onClick={() => setCameraMode("iso")}>
          Isometrica
        </button>
        <button className={`btn ${cameraMode === "top" ? "active" : ""}`} onClick={() => setCameraMode("top")}>
          Top-down
        </button>
      </div>
    </div>
  );

  const ExportPanel = () => (
    <div className="tree-node">
      <div className="tree-label">Export</div>
      <div className="flex flex-wrap items-center gap-10">
        <button className="btn active" onClick={exportPng}>
          PNG (print)
        </button>
        <button className="btn" onClick={exportJson}>
          Salva dungeon (JSON)
        </button>
        <button className="btn" onClick={() => importJsonRef.current?.click()}>
          Carica dungeon
        </button>
        <input
          ref={importJsonRef as any}
          type="file"
          accept="application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importJson(file);
            e.target.value = "";
          }}
        />
        <button className="btn" onClick={resetAll}>
          Reset
        </button>
        <div className="small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>Render scale</span>
          <input style={{ width: 64 }} type="number" min={1} max={8} value={renderScale} onChange={(e) => setRenderScale(clamp(Number(e.target.value || 1), 1, 8))} />
        </div>
      </div>
      {status && <div className="small">{status}</div>}
    </div>
  );

  return (
    <div className="app-shell">
      <div className="panel">
        <div className="panel-scroll">
          <div className="stack">
            <div className="flex items-center justify-between gap-3">
              <div className="section-title">Tool</div>
              <div className="flex gap-6">
                <button className={`btn ${mode === "cells" ? "active" : ""}`} onClick={() => setMode("cells")}>
                  Celle
                </button>
                <button className={`btn ${mode === "edges" ? "active" : ""}`} onClick={() => setMode("edges")}>
                  Bordi
                </button>
                <button className={`btn ${mode === "objects" ? "active" : ""}`} onClick={() => setMode("objects")}>
                  Oggetti
                </button>
              </div>
            </div>

            {mode === "cells" && (
              <div>
                <div className="section-title">Pennello cella</div>
                <div className="controls-grid">
                  {(["floor", "pit", "water"] as CellType[]).map((t) => (
                    <button key={t} className={`btn ${cellBrush === t ? "active" : ""}`} onClick={() => setCellBrush(t)}>
                      {t === "floor" ? "Pavimento" : t === "pit" ? "Baratro" : "Acqua"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === "edges" && (
              <div>
                <div className="section-title">Pennello bordo</div>
                <div className="controls-grid">
                  {(["wall", "door"] as const).map((t) => (
                    <button key={t} className={`btn ${edgeBrush === t ? "active" : ""}`} onClick={() => setEdgeBrush(t)}>
                      {t === "wall" ? "Parete" : "Porta"}
                    </button>
                  ))}
                </div>
                <div className="hint">Clic vicino al bordo tra due celle per inserire/rimuovere.</div>
              </div>
            )}

            {mode === "objects" && (
              <div>
                <div className="section-title">Pennello oggetto</div>
                <div className="controls-grid">
                  {(["lever", "trapdoor", "torch", "bridge", "light"] as const).map((t) => (
                    <button key={t} className={`btn ${objectBrush === t ? "active" : ""}`} onClick={() => setObjectBrush(t)}>
                      {t === "lever" ? "Leva" : t === "trapdoor" ? "Botola" : t === "torch" ? "Torcia" : t === "bridge" ? "Ponte" : "Luce"}
                    </button>
                  ))}
                  <button className={`btn ${objectBrush === "none" ? "active" : ""}`} onClick={() => setObjectBrush("none")}>
                    Gomma
                  </button>
                </div>
                <div className="hint">Regola: il ponte si puo piazzare solo su Acqua o Baratro. Riclic per ruotare. Le luci sono solo punti luce.</div>

                <div className="section-title" style={{ marginTop: 10 }}>Oggetti custom (.glb)</div>
                <div className="flex gap-6">
                  <button className="btn active" onClick={() => fileInputRef.current?.click()}>Aggiungi oggetto</button>
                  <input
                    ref={fileInputRef as any}
                    type="file"
                    accept=".glb"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) loadCustomGlb(file);
                      e.target.value = "";
                    }}
                  />
                </div>
                {Object.keys(customTemplates).length > 0 && (
                  <div className="controls-grid" style={{ marginTop: 8 }}>
                    {Object.keys(customTemplates).map((name) => (
                      <button
                        key={name}
                        className={`btn ${customBrush === name ? "active" : ""}`}
                        onClick={() => {
                          setCustomBrush(name);
                          setObjectBrush("none");
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
                {Object.keys(customTemplates).length === 0 && <div className="hint">Carica un .glb per piazzarlo con click sinistro.</div>}
                {customBrush && <div className="hint">Tasto destro: trascina per spostare, destro + Alt per scalare. Uno per cella per nome.</div>}
              </div>
            )}

            <div>
              <div className="section-title">Camera</div>
              <div className="controls-grid">
                <button className={`btn ${cameraMode === "iso" ? "active" : ""}`} onClick={() => setCameraMode("iso")}>
                  Isometrica
                </button>
                <button className={`btn ${cameraMode === "top" ? "active" : ""}`} onClick={() => setCameraMode("top")}>
                  Top-down
                </button>
              </div>
            </div>

            <div>
              <div className="section-title">Texture</div>
              <div className="stack">
                <div className="stack">
                  <div className="section-title">Pavimento (PNG/JPG)</div>
                  <div className="small break-all">{texFloorUrl ?? "-"}</div>
                  <div className="flex gap-6">
                    <input type="file" accept="image/*" onChange={setFromFile(setTexFloorUrl)} />
                    <button className="btn" onClick={() => clearUrl(texFloorUrl, setTexFloorUrl)}>
                      Pulisci
                    </button>
                  </div>
                </div>
                <div className="stack">
                  <div className="section-title">Acqua (PNG/JPG)</div>
                  <div className="small break-all">{texWaterUrl ?? "-"}</div>
                  <div className="flex gap-6">
                    <input type="file" accept="image/*" onChange={setFromFile(setTexWaterUrl)} />
                    <button className="btn" onClick={() => clearUrl(texWaterUrl, setTexWaterUrl)}>
                      Pulisci
                    </button>
                  </div>
                </div>
                <div className="stack">
                  <div className="section-title">Baratro (PNG/JPG)</div>
                  <div className="small break-all">{texPitUrl ?? "-"}</div>
                  <div className="flex gap-6">
                    <input type="file" accept="image/*" onChange={setFromFile(setTexPitUrl)} />
                    <button className="btn" onClick={() => clearUrl(texPitUrl, setTexPitUrl)}>
                      Pulisci
                    </button>
                  </div>
                </div>
                <div className="controls-grid">
                  <label className="text-xs">
                    <div className="section-title">Ripetizione texture</div>
                    <input type="range" min={1} max={6} step={1} value={texRepeat} onChange={(e) => setTexRepeat(Number(e.target.value))} />
                    <div className="small">{texRepeat}x per cella</div>
                  </label>
                  <label className="text-xs">
                    <div className="section-title">Opacita acqua</div>
                    <input type="range" min={0.4} max={1} step={0.01} value={waterOpacity} onChange={(e) => setWaterOpacity(Number(e.target.value))} />
                    <div className="small">{waterOpacity.toFixed(2)}</div>
                  </label>
                </div>
              </div>
            </div>

            <div>
              <div className="section-title">Luci</div>
              <div className="controls-grid">
                <label className="text-xs">
                  <div className="section-title">Ambiente (intensita)</div>
                  <input type="range" min={0} max={0.8} step={0.01} value={ambient} onChange={(e) => setAmbient(Number(e.target.value))} />
                </label>
                <div className="text-xs">
                  <div className="section-title">Colore ambiente</div>
                  <div className="flex items-center gap-4">
                    <input type="color" value={ambientColor} onChange={(e) => setAmbientColor(e.target.value)} />
                    <input value={ambientColor} onChange={(e) => setAmbientColor(e.target.value)} />
                  </div>
                </div>
                <div className="text-xs">
                  <div className="section-title">Colore torcia (solo mesh)</div>
                  <div className="flex items-center gap-4">
                    <input type="color" value={torchColor} onChange={(e) => setTorchColor(e.target.value)} />
                    <input value={torchColor} onChange={(e) => setTorchColor(e.target.value)} />
                  </div>
                </div>
              </div>
              <div className="section-title" style={{ marginTop: 8 }}>
                Luci puntiformi piazzate
              </div>
              {lights.length === 0 && <div className="hint">Nessuna luce: scegli "Luce" e clicca una cella.</div>}
              {lights.length > 0 && (
                <div className="stack">
                  {lights.map((l) => (
                    <button
                      key={l.idx}
                      className={`btn ${selectedLightCell === l.idx ? "active" : ""}`}
                      onClick={() => {
                        setSelectedLightCell(l.idx);
                        setEditingLight({ ...l.light });
                      }}
                    >
                      Luce ({l.x + 1},{l.y + 1})
                    </button>
                  ))}
                </div>
              )}

              {selectedLightCell !== null && editingLight && (
                <div className="controls-grid">
                  <label className="text-xs">
                    <div className="section-title">Luce: intensita</div>
                    <input
                      type="range"
                      min={0}
                      max={20}
                      step={0.1}
                      value={editingLight.intensity}
                      onChange={(e) => updateSelectedLight({ intensity: Number(e.target.value) })}
                    />
                  </label>
                  <label className="text-xs">
                    <div className="section-title">Luce: distanza</div>
                    <input
                      type="range"
                      min={1}
                      max={8}
                      step={0.1}
                      value={editingLight.distance}
                      onChange={(e) => updateSelectedLight({ distance: Number(e.target.value) })}
                    />
                  </label>
                  <label className="text-xs">
                    <div className="section-title">Luce: decay</div>
                    <input
                      type="range"
                      min={0}
                      max={3}
                      step={0.1}
                      value={editingLight.decay}
                      onChange={(e) => updateSelectedLight({ decay: Number(e.target.value) })}
                    />
                  </label>
                  <div className="text-xs">
                    <div className="section-title">Luce: colore</div>
                    <div className="flex items-center gap-4">
                      <input
                        type="color"
                        value={editingLight.color}
                        onChange={(e) => updateSelectedLight({ color: e.target.value })}
                      />
                      <input
                        value={editingLight.color}
                        onChange={(e) => updateSelectedLight({ color: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              )}
              {customObjects.length > 0 && (
                <div>
                  <div className="section-title" style={{ marginTop: 8 }}>
                    Oggetti piazzati
                  </div>
                  <div className="stack">
                    {customObjects.map((c) => (
                      <button
                        key={c.id}
                        className={`btn ${selectedCustomId === c.id ? "active" : ""}`}
                        onClick={() => setSelectedCustomId(c.id)}
                      >
                        {c.name} ({c.x + 1},{c.y + 1})
                      </button>
                    ))}
                  </div>
                  {selectedCustomId !== null && (
                    <div className="controls-grid" style={{ marginTop: 6 }}>
                      <label className="text-xs">
                        <div className="section-title">Scala</div>
                        <input
                          type="range"
                          min={0.3}
                          max={3}
                          step={0.05}
                          value={customObjects.find((c) => c.id === selectedCustomId)?.scale ?? 1}
                          onChange={(e) => updateSelectedCustom({ scale: Number(e.target.value) })}
                        />
                      </label>
                      <label className="text-xs">
                        <div className="section-title">Altezza (y)</div>
                        <input
                          type="range"
                          min={-1}
                          max={3}
                          step={0.02}
                          value={customObjects.find((c) => c.id === selectedCustomId)?.yOffset ?? 0}
                          onChange={(e) => updateSelectedCustom({ yOffset: Number(e.target.value) })}
                        />
                      </label>
                      <label className="text-xs">
                        <div className="section-title">Rotazione (gradi)</div>
                        <input
                          type="range"
                          min={0}
                          max={359}
                          step={1}
                          value={customObjects.find((c) => c.id === selectedCustomId)?.rotation ?? 0}
                          onChange={(e) => updateSelectedCustom({ rotation: Number(e.target.value) })}
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
              <div className="controls-grid">
                <label className="text-xs">
                  <div className="section-title">Torcia: intensita (solo fiamma visiva)</div>
                  <input type="range" min={0} max={20} step={0.1} value={torchIntensity} onChange={(e) => setTorchIntensity(Number(e.target.value))} />
                </label>
                <label className="text-xs">
                  <div className="section-title">Torcia: distanza</div>
                  <input type="range" min={1} max={8} step={0.1} value={torchDistance} onChange={(e) => setTorchDistance(Number(e.target.value))} />
                </label>
                <label className="text-xs">
                  <div className="section-title">Torcia: decay</div>
                  <input type="range" min={0} max={3} step={0.1} value={torchDecay} onChange={(e) => setTorchDecay(Number(e.target.value))} />
                </label>
              </div>
            </div>

            <div>
              <div className="section-title">Export</div>
              <div className="flex flex-wrap items-center gap-10">
                <button className="btn active" onClick={exportPng}>
                  PNG (print)
                </button>
                <button className="btn" onClick={exportJson}>
                  Salva dungeon (JSON)
                </button>
                <button className="btn" onClick={() => importJsonRef.current?.click()}>
                  Carica dungeon
                </button>
                <input
                  ref={importJsonRef as any}
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) importJson(file);
                    e.target.value = "";
                  }}
                />
                <button className="btn" onClick={resetAll}>
                  Reset
                </button>
                <div className="small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span>Render scale</span>
                  <input style={{ width: 64 }} type="number" min={1} max={8} value={renderScale} onChange={(e) => setRenderScale(clamp(Number(e.target.value || 1), 1, 8))} />
                </div>
              </div>
              {status && <div className="small">{status}</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="panel viewport-wrap">
        <div className="flex items-center justify-between gap-3">
          <div className="section-title">Viewport 3D</div>
          <div className="hint">Clic per editare. In iso: drag ruota, rotella zoom.</div>
        </div>
        <div className="viewport">
          <div
            ref={containerRef}
            onMouseDown={(e) => startCustomDrag(e as any)}
            onMouseMove={(e) => handleCustomDrag(e as any)}
            onMouseUp={(e) => {
              endCustomDrag(e as any);
              pickFromMouse(e as any);
            }}
            onContextMenu={(e) => e.preventDefault()}
            style={{ width: "100%", height: "100%", cursor: "crosshair" }}
          />
        </div>
        <div className="hint">
          <div>- Celle: clic al centro tile.</div>
          <div>- Bordi: clic vicino al bordo.</div>
          <div>- Oggetti: clic al centro; riclic per ruotare.</div>
        </div>
      </div>
    </div>
  );
}

// Esporta nel global scope per l'uso diretto in index.html
window.DungeonBoardEditorTrue3D = DungeonBoardEditorTrue3D;

// Monta automaticamente se esiste #root (utile per index.html senza bundler)
const _rootEl = document.getElementById("root");
if (_rootEl) {
  const _root = ReactDOM.createRoot(_rootEl);
  _root.render(React.createElement(DungeonBoardEditorTrue3D));
}
