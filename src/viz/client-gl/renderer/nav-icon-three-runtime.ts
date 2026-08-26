// A deliberately narrow, lazy Three.js surface for the navigation meshes.
// Keeping these named exports in their own chunk lets Vite tree-shake the
// engine instead of `import('three')` retaining its entire namespace.
export {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
