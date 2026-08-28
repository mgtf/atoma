import {
  POINTER_LIGHT_CORE_RADIUS_PX,
  POINTER_LIGHT_RADIUS_PX,
} from '../pointer-light.js';

/**
 * GPU shader sources. Timeline events deliberately share one sand-grain card
 * material; their action accent remains geometry/copy colour, not a second
 * family-specific texture vocabulary.
 *
 * Extracted from gpu-renderer.ts (2026-08-15 decomposition): the shaders are
 * pure source constants with both GLSL and WGSL variants — the two-backend
 * contract (WebGPU with WebGL fallback) means every visual effect ships both
 * or ships neither.
 */
export const POINTER_LIGHT_GLSL_VERTEX = /* glsl */ `
  in vec2 aPosition;
  out vec2 vTextureCoord;
  out vec2 vScreenPx;
  uniform vec4 uInputSize;
  uniform vec4 uOutputFrame;
  uniform vec4 uOutputTexture;

  void main() {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y =
      position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) -
      uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
    vScreenPx = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  }
`;

export const POINTER_LIGHT_GLSL = /* glsl */ `
  in vec2 vTextureCoord;
  in vec2 vScreenPx;
  out vec4 finalColor;
  uniform sampler2D uTexture;
  uniform vec4 uInputPixel;
  uniform vec2 uLightPx;
  uniform float uStrength;
  uniform float uRadiusScale;
  uniform float uHueShift;

  float luminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  vec3 rotateHue(vec3 color, float degrees) {
    if (abs(degrees) < 0.001) return color;
    float angle = radians(degrees);
    vec3 axis = vec3(0.57735027);
    float cosA = cos(angle);
    return max(
      vec3(0.0),
      color * cosA + cross(axis, color) * sin(angle) +
        axis * dot(axis, color) * (1.0 - cosA)
    );
  }

  void main() {
    vec2 uv = vTextureCoord;
    vec4 sampleColor = texture(uTexture, uv);
    float sampleLuminance = luminance(sampleColor.rgb);
    vec4 rightSample = texture(uTexture, uv + vec2(uInputPixel.z, 0.0));
    vec4 downSample = texture(uTexture, uv + vec2(0.0, uInputPixel.w));
    vec2 gradient = vec2(
      luminance(rightSample.rgb) - sampleLuminance,
      luminance(downSample.rgb) - sampleLuminance
    );
    vec2 alphaGradient = vec2(
      rightSample.a - sampleColor.a,
      downSample.a - sampleColor.a
    );
    vec2 outwardNormal = -(gradient + alphaGradient * 0.16);
    vec2 toLight = normalize(uLightPx - vScreenPx + vec2(0.001));
    float normalLength = length(outwardNormal);
    float facing = max(0.0, dot(outwardNormal / max(0.001, normalLength), toLight));
    float edgeResponse = clamp(normalLength * 4.4, 0.0, 1.0);
    float distancePx = length(vScreenPx - uLightPx);
    float scale = max(0.05, uRadiusScale);
    float halo = exp(-2.2 * pow(distancePx / (${POINTER_LIGHT_RADIUS_PX.toFixed(1)} * scale), 2.0));
    float core = exp(-2.8 * pow(distancePx / (${POINTER_LIGHT_CORE_RADIUS_PX.toFixed(1)} * scale), 2.0));
    vec3 lightColor = rotateHue(
      mix(vec3(0.20, 0.56, 1.0), vec3(0.78, 0.95, 1.0), core),
      uHueShift
    );
    // Interior wash + edges. The 0.075 term is what lights filled UI
    // (buttons, cards, header). It is a disc on ANY filled mesh, so the
    // crystal must NOT live under this filter — it sits on markRoot.
    float illumination = halo * (0.075 + edgeResponse * (0.24 + facing * 0.36));
    sampleColor.rgb += lightColor * illumination * uStrength * sampleColor.a;
    finalColor = sampleColor;
  }
`;

export const POINTER_LIGHT_WGSL = /* wgsl */ `
  struct GlobalFilterUniforms {
    uInputSize: vec4<f32>,
    uInputPixel: vec4<f32>,
    uInputClamp: vec4<f32>,
    uOutputFrame: vec4<f32>,
    uGlobalFrame: vec4<f32>,
    uOutputTexture: vec4<f32>,
  };

  struct PointerLightUniforms {
    uLightPx: vec2<f32>,
    uStrength: f32,
    uRadiusScale: f32,
    uHueShift: f32,
  };

  @group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
  @group(0) @binding(1) var uTexture: texture_2d<f32>;
  @group(0) @binding(2) var uSampler: sampler;
  @group(1) @binding(0) var<uniform> pointerLight: PointerLightUniforms;

  struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) screenPx: vec2<f32>,
  };

  fn rotateHue(color: vec3<f32>, degrees: f32) -> vec3<f32> {
    if (abs(degrees) < 0.001) { return color; }
    let angle = radians(degrees);
    let axis = vec3<f32>(0.57735027);
    let cosA = cos(angle);
    return max(
      vec3<f32>(0.0),
      color * cosA + cross(axis, color) * sin(angle) +
        axis * dot(axis, color) * (1.0 - cosA)
    );
  }

  fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
  }

  fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  }

  @vertex
  fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
    let screenPx = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition), screenPx);
  }

  fn luminance(color: vec3<f32>) -> f32 {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  @fragment
  fn mainFragment(
    @location(0) uv: vec2<f32>,
    @location(1) screenPx: vec2<f32>
  ) -> @location(0) vec4<f32> {
    var sampleColor = textureSample(uTexture, uSampler, uv);
    let sampleLuminance = luminance(sampleColor.rgb);
    let gradient = vec2(dpdx(sampleLuminance), dpdy(sampleLuminance));
    let alphaGradient = vec2(dpdx(sampleColor.a), dpdy(sampleColor.a));
    let outwardNormal = -(gradient + alphaGradient * 0.16);
    let toLight = normalize(pointerLight.uLightPx - screenPx + vec2(0.001));
    let normalLength = length(outwardNormal);
    let facing = max(0.0, dot(outwardNormal / max(0.001, normalLength), toLight));
    let edgeResponse = clamp(normalLength * 4.4, 0.0, 1.0);
    let distancePx = length(screenPx - pointerLight.uLightPx);
    let scale = max(0.05, pointerLight.uRadiusScale);
    let halo = exp(-2.2 * pow(distancePx / (${POINTER_LIGHT_RADIUS_PX.toFixed(1)} * scale), 2.0));
    let core = exp(-2.8 * pow(distancePx / (${POINTER_LIGHT_CORE_RADIUS_PX.toFixed(1)} * scale), 2.0));
    let lightColor = rotateHue(
      mix(vec3(0.20, 0.56, 1.0), vec3(0.78, 0.95, 1.0), core),
      pointerLight.uHueShift
    );
    // Twin of the GLSL above — interior wash for UI, crystal is not in this
    // filtered layer.
    let illumination = halo * (0.075 + edgeResponse * (0.24 + facing * 0.36));
    sampleColor.r += lightColor.r * illumination * pointerLight.uStrength * sampleColor.a;
    sampleColor.g += lightColor.g * illumination * pointerLight.uStrength * sampleColor.a;
    sampleColor.b += lightColor.b * illumination * pointerLight.uStrength * sampleColor.a;
    return sampleColor;
  }
`;

// ---------------------------------------------------------------------------
// Brand mark shell
//
// The mark is a MESH: a thick-shell regular octahedron, eight outer facets and
// eight cavity facets, drawn by these two programs. Positions arrive already
// projected by `buildAtomaMarkFrame` — the vertex stage only maps the local
// 28×28 box through Pixi's matrices, so there is exactly one projection in the
// codebase and a shader cannot drift from it.
//
// The fragment stage is where the bead becomes a real light: its falloff is the
// same smoothstep as `coreLightFalloff` in `brand-mark.ts` (change one, change
// the other), applied PER PIXEL against each facet's own flat normal. That is
// what the 2D version could only fake with a flat glaze per face.
//
// Two programs, one behaviour: WGSL for the WebGPU backend, GLSL ES 3 for the
// WebGL fallback. Pixi binds `globalUniforms` and `localUniforms` itself; the
// mark's own values live in `markUniforms`.
// ---------------------------------------------------------------------------

/**
 * Radius of the pointer's finite emitter in model units. Surface roughness
 * still comes from the material; this is only the source's angular size, so a
 * polished diamond reflects a compact light instead of an infinite point.
 */
export const MARK_POINTER_SOURCE_RADIUS_MODEL = 0.055;
const MARK_POINTER_SOURCE_RADIUS_SQ = MARK_POINTER_SOURCE_RADIUS_MODEL ** 2;
const MARK_POINTER_LOBE_SUPPORT_INNER = 6.25;
const MARK_POINTER_LOBE_SUPPORT_OUTER = 9;

export const MARK_SHELL_WGSL = /* wgsl */ `
  struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
  }

  struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
  }

  struct MarkUniforms {
    uCore: vec3<f32>,
    uLightDir: vec3<f32>,
    uCoreTint: vec3<f32>,
    uLamp: vec4<f32>,
    uCoreReach: f32,
    uCoreIntensity: f32,
    uAmbient: f32,
    uPulse: f32,
    uWall: f32,
    uMinPath: f32,
    uOpacityRef: f32,
    uSplit: f32,
    uBend: f32,
    uMaxBend: f32,
    uRefract: f32,
    uRefractOn: f32,
    uSpecular: f32,
    uRim: f32,
    uLocalSize: f32,
    uBackdropTexel: vec2<f32>,
    uCoreRadius: f32,
    uEnvOn: f32,
    uEnvJump: f32,
    uPointerClip: vec4<f32>,
    uCameraZ: f32,
    uProjectScale: f32,
  }

  @group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
  @group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
  @group(2) @binding(0) var<uniform> markUniforms: MarkUniforms;
  // What is BEHIND this facet: the back half of the shell plus the bead, drawn
  // into their own texture before the front half runs. Sampling it is the only
  // way a facet can bend what it transmits, because nothing else in the pipeline
  // knows what the interior looks like at this pixel.
  @group(2) @binding(1) var uBackdrop: texture_2d<f32>;
  @group(2) @binding(2) var uBackdropSampler: sampler;
  // The Pixi scene WITHOUT the gem, in screen UV. Fresnel samples this,
  // including the aurora field on ambientRoot.
  @group(2) @binding(3) var uEnv: texture_2d<f32>;
  @group(2) @binding(4) var uEnvSampler: sampler;

  struct VertexInput {
    @location(0) aPosition: vec2<f32>,
    @location(1) aWorld: vec3<f32>,
    @location(2) aNormal: vec3<f32>,
    @location(3) aTint: vec3<f32>,
    @location(4) aSurface: vec2<f32>,
    @location(5) aMaterial: vec4<f32>,
    @location(6) aFinish: vec3<f32>,
    @location(7) aBary: vec3<f32>,
  }

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vWorld: vec3<f32>,
    @location(1) vNormal: vec3<f32>,
    @location(2) vTint: vec3<f32>,
    @location(3) vSurface: vec2<f32>,
    @location(4) vColor: vec4<f32>,
    @location(5) vMaterial: vec4<f32>,
    @location(6) vFinish: vec3<f32>,
    // Where this pixel lands in the backdrop texture, 0..1. Derived from the
    // SAME clip position the rasteriser uses, so the sample cannot drift from
    // the geometry it belongs to.
    @location(7) vScreen: vec2<f32>,
    @location(8) vBary: vec3<f32>,
    // Clip UV of this pixel in the viewport, 0..1. The env capture is a scaled
    // screenshot of the Pixi stage, so a reflected ray walks THIS space, not
    // the 28x28 backdrop box vScreen is for.
    @location(9) vClipUv: vec2<f32>,
  }

  @vertex
  fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let matrix = globalUniforms.uProjectionMatrix *
      globalUniforms.uWorldTransformMatrix *
      localUniforms.uTransformMatrix;
    let clip = matrix * vec3<f32>(input.aPosition, 1.0);
    out.position = vec4<f32>(clip.xy, 0.0, 1.0);
    out.vWorld = input.aWorld;
    out.vNormal = input.aNormal;
    out.vTint = input.aTint;
    out.vSurface = input.aSurface;
    out.vColor = localUniforms.uColor * globalUniforms.uWorldColorAlpha;
    out.vMaterial = input.aMaterial;
    out.vFinish = input.aFinish;
    out.vBary = input.aBary;
    // The backdrop texture holds the mark's own 28x28 box and nothing else, so
    // the sampling coord comes from the LOCAL position — not from clip space,
    // which spans the whole viewport and would have every facet sampling an
    // unrelated part of the screen.
    out.vScreen = input.aPosition / markUniforms.uLocalSize;
    out.vClipUv = clip.xy * 0.5 + 0.5;
    return out;
  }

  @fragment
  fn mainFragment(
    @location(0) vWorld: vec3<f32>,
    @location(1) vNormal: vec3<f32>,
    @location(2) vTint: vec3<f32>,
    @location(3) vSurface: vec2<f32>,
    @location(4) vColor: vec4<f32>,
    @location(5) vMaterial: vec4<f32>,
    @location(6) vFinish: vec3<f32>,
    @location(7) vScreen: vec2<f32>,
    @location(8) vBary: vec3<f32>,
    @location(9) vClipUv: vec2<f32>,
  ) -> @location(0) vec4<f32> {
    let normal = normalize(vNormal);
    let outer = vSurface.y;
    // Every face currently receives the diamond profile selected by
    // markMaterialForOctant. The former per-rank selector stays commented beside
    // that function for restoration. Nothing here is a free-floating look knob.
    let specularPower = vMaterial.x;
    let dispersion = vMaterial.y;
    let f0 = vMaterial.z;
    let absorption = vMaterial.w;
    // IOR minus one: the strength of the bend, zero for a material that does
    // not refract at all.
    let iorBend = vFinish.x;
    let transmit = vFinish.y;
    let body = vFinish.z;

    // VIEW. The mark is a 3D object, not an orthographic sticker. A ray from
    // the camera to a pixel at the edge of the box is not the same ray as the
    // one through the centre. On eight FLAT facets a constant view makes N·H
    // constant too, so a directional key glazes a whole face at once — which
    // is why the crystal read as painted triangles. Varying V across the face
    // is what lets a highlight become a spot.
    //
    // 1.15 is a stylised half-width: the authored camera is farther than that,
    // but a smaller offset left N·H almost constant across a flat facet, so
    // the key glazed the whole triangle. Stretching V is what turns a glaze
    // into a spot. vScreen is y-down Pixi; world Y is up.
    let viewOffset = vec2<f32>(vScreen.x - 0.5, 0.5 - vScreen.y) * 1.15;
    let viewDir = normalize(vec3<f32>(viewOffset.x, viewOffset.y, 1.0));
    let nDotV = min(abs(dot(normal, viewDir)), 1.0);

    // SOLID, not surfaced — but the two consequences of that are split on
    // purpose. OPACITY is Beer-Lambert at the material's REFERENCE depth, so a
    // wedge is exactly as dense as its own glass and stays that dense whichever
    // way it turns. BULK is the EXTRA material a grazing ray crosses beyond
    // that depth, and it is spent on COLOUR: obsidian goes black through the
    // thick of the wedge while diamond stays clear through the same geometry.
    // Alpha itself must not follow the live path. An octahedron facet swings
    // from face-on to edge-on every turn, so a path-driven alpha made each of
    // the four wedges breathe between clear and solid on the rotation — read as
    // a pulsing opacity, which is not what a block of glass does.
    // Path uses N·V, not N·Z: the extra length is along the actual view ray.
    let path = markUniforms.uWall / max(nDotV, 0.16);
    let opacity = (1.0 - exp(-absorption * markUniforms.uMinPath)) /
      max(markUniforms.uOpacityRef, 1e-4);
    let bulk = 1.0 - exp(-absorption * max(path - markUniforms.uMinPath, 0.0) * 0.35);

    let toCore = markUniforms.uCore - vWorld;
    let distance = length(toCore);
    let coreDir = toCore / max(distance, 1e-4);
    let reach = clamp(1.0 - distance / markUniforms.uCoreReach, 0.0, 1.0);
    let falloff = reach * reach * (3.0 - 2.0 * reach);
    let incidence = max(dot(normal, coreDir), 0.0);
    let core = falloff * (0.34 + 0.66 * incidence) *
      markUniforms.uCoreIntensity * (0.86 + 0.14 * markUniforms.uPulse) *
      transmit * mix(1.0, 0.45, bulk);

    // The camera sees the INSIDE of a back-facing outer wall. Lighting that
    // surface with the outward normal leaves N·L negative against a camera-side
    // key, so the far hull in the backdrop is ambient-only — a black cavity,
    // and every near table a veil over nothing. Flip only the body; specular
    // stays on the true outward N so the dark side does not grow a glaze.
    let facingView = dot(normal, viewDir);
    let trueSun = max(dot(normal, markUniforms.uLightDir), 0.0);
    let bodyNormal = select(normal, -normal, outer > 0.5 && facingView < 0.0);
    let sun = max(dot(bodyNormal, markUniforms.uLightDir), 0.0);
    // CONVEXITY. A perfectly flat facet has constant N, so a directional key
    // that faces it glazes the whole triangle (the turn film clipped 45k
    // pixels on one white face). A real table is never that planar. Pulling
    // N a little toward the local screen centre is a cut, not a bump map, and
    // it is used ONLY for the highlights — Lambert, path and refraction keep
    // the true face so the solid stays faceted.
    let convex = vec3<f32>(vScreen.x - 0.5, 0.5 - vScreen.y, 0.02) * 2.8;
    let shadeNormal = normalize(normal + convex);
    let half = normalize(markUniforms.uLightDir + viewDir);
    let facing = max(dot(shadeNormal, half), 0.0);
    // FIRE. The same highlight raised to three exponents: a tighter exponent is
    // a smaller spot, so blue collapses into the core while red keeps a wide
    // skirt — the order a prism throws. Dispersion is how far a material is
    // allowed down that path; plain glass stays white.
    let spectral = vec3<f32>(
      pow(facing, specularPower * 0.85),
      pow(facing, specularPower * 1.25),
      pow(facing, specularPower * 1.85)
    );
    // Schlick at V·H, the microfacet half-angle: how much the surface reflects
    // the key toward the eye. N·H was a stand-in that made the Fresnel of the
    // highlight disagree with the Fresnel of the body on the same pixel.
    let specF = f0 + (1.0 - f0) * pow(1.0 - max(dot(viewDir, half), 0.0), 5.0);
    // GEOMETRY. Specular on a face the key does not see is a glaze on the dark
    // side. Smith's height-correlated form, in the cheap Schlick shape: N·L
    // and N·V, correlated, so grazing and back-facing both go to zero.
    // NORMALISATION. A tighter Blinn-Phong lobe packs the same energy into a
    // smaller spot, which is why diamond fire is bright and obsidian's smear
    // is not — without this the four glasses shared one peak and only differed
    // in width. 51 is (glass's exponent + 2) / 2, so typical-pose geo * specNorm
    // stays near 1 and uSpecular remains the scene-wide loudness.
    let geo = trueSun * nDotV / max(trueSun + nDotV - trueSun * nDotV, 1e-4);
    let specNorm = (specularPower + 2.0) / 51.0;
    let inPlane = vWorld - normal * dot(vWorld, normal);
    // TABLE LOBE. Bending N toward the face centroid created NEW alignments
    // (clip_px_max jumped 9k to 27k). Windowing the highlight by distance
    // from that centroid can only shrink a glaze; it cannot invent one.
    let tableLobe = exp(-dot(inPlane, inPlane) * 36.0);
    let highlight = mix(vec3<f32>(spectral.y), spectral, dispersion) *
      specF * geo * specNorm * markUniforms.uSpecular * outer * tableLobe;
    // STUDIO WINDOW. Specular only. A fill that lifts the body was tried and
    // reverted: on a near-black field what reads as transparency is seeing
    // the far facets through the near one, and any light that lifts the near
    // facet's floor buries them. A highlight does not lift the floor. Aimed
    // orthogonal to the key so the two catch different faces.
    let windowDir = normalize(vec3<f32>(0.85, 0.35, 0.15));
    let windowHalf = normalize(windowDir + viewDir);
    let windowFacing = max(dot(shadeNormal, windowHalf), 0.0);
    let windowNdotL = max(dot(normal, windowDir), 0.0);
    let windowGeo = windowNdotL * nDotV /
      max(windowNdotL + nDotV - windowNdotL * nDotV, 1e-4);
    let windowSpecF = f0 + (1.0 - f0) *
      pow(1.0 - max(dot(viewDir, windowHalf), 0.0), 5.0);
    let windowHighlight = vec3<f32>(0.78, 0.88, 1.0) *
      pow(windowFacing, specularPower) * windowSpecF * windowGeo * specNorm *
      markUniforms.uSpecular * outer * 0.28 * tableLobe;
    // FRESNEL, Schlick's approximation proper: F0 + (1 - F0)(1 - cos0)^5.
    //
    // Both halves used to be wrong. The exponent was 2.2, a curve that rises far
    // too early, and there was no F0 at all — the material carried a hand-set
    // fresnelGain instead, which had drifted to give obsidian stronger edges
    // than plain glass despite near-identical indices. F0 comes from the IOR
    // now, so diamond's edges are four times glass's because its index says so.
    let fresnel = f0 + (1.0 - f0) * pow(1.0 - nDotV, 5.0);
    // ENERGY. A dielectric reflects F of the light and lets 1-F into the body.
    // Without this the body, the highlight and the transmitted interior were
    // three independent adds, so grazing edges stacked a painted face, a
    // highlight AND a full interior — the opposite of glass, which becomes a
    // mirror there and hides what is behind it.
    let bounce = 1.0 - fresnel;

    // POINTER LAMP. A finite emitter in FRONT of the gem, in model space.
    // Its lobe uses the real camera and the unmodified facet normal. Therefore
    // N=H exactly at the mirror-law point; there is no screen-space window
    // glued under the cursor and no bent normal moving the peak back there.
    // Specular only — Lambert from this lamp buried the far facets.
    let camera = vec3<f32>(0.0, 0.0, markUniforms.uCameraZ);
    // vWorld is affine-interpolated after the CPU's pinhole projection, so it
    // is coplanar but not the 3D point seen at this fragment. Rebuild that point
    // by intersecting the camera ray through vScreen with the facet plane.
    let screenPoint = vec3<f32>(
      (vScreen.x - 0.5) * markUniforms.uLocalSize /
        markUniforms.uProjectScale,
      (0.5 - vScreen.y) * markUniforms.uLocalSize /
        markUniforms.uProjectScale,
      0.0
    );
    let surfaceRay = screenPoint - camera;
    let surfacePlaneOffset = dot(normal, vWorld);
    let surfaceDenom = dot(normal, surfaceRay);
    let safeSurfaceDenom = select(
      max(surfaceDenom, 1e-4),
      min(surfaceDenom, -1e-4),
      surfaceDenom < 0.0
    );
    let surfaceT = (surfacePlaneOffset - dot(normal, camera)) /
      safeSurfaceDenom;
    let surfacePoint = camera + surfaceRay * surfaceT;
    let surfaceValid = step(1e-4, abs(surfaceDenom)) * step(0.0, surfaceT);
    let toLampView = camera - surfacePoint;
    let lampViewDir = toLampView / max(length(toLampView), 1e-4);
    let toLamp = markUniforms.uLamp.xyz - surfacePoint;
    let lampDist = length(toLamp);
    let lampDir = toLamp / max(lampDist, 1e-4);
    let lampNdotL = max(dot(normal, lampDir), 0.0);
    let lampNdotV = max(dot(normal, lampViewDir), 0.0);
    let lampHalfSum = lampDir + lampViewDir;
    let lampHalfLength2 = dot(lampHalfSum, lampHalfSum);
    let lampHalf = lampHalfSum / sqrt(max(lampHalfLength2, 1e-6));
    let lampFacing = clamp(dot(normal, lampHalf), 0.0, 1.0);
    let lampSpecF = f0 + (1.0 - f0) *
      pow(1.0 - max(dot(lampViewDir, lampHalf), 0.0), 5.0);
    let lampGeo = lampNdotL * lampNdotV /
      max(lampNdotL + lampNdotV - lampNdotL * lampNdotV, 1e-4);
    let lampGate = smoothstep(0.0, 0.08, lampNdotL) *
      smoothstep(0.0, 0.08, lampNdotV) * step(1e-6, lampHalfLength2) *
      surfaceValid;
    // Invert markSpecularPower to recover material roughness squared, then
    // add the finite source's angular variance. H(P) maps that isotropic lobe
    // onto the correct screen ellipse and puts its maximum at the mirror point.
    let roughness2 = 2.0 / max(specularPower + 2.0, 2.0);
    let sourceAlpha2 = ${MARK_POINTER_SOURCE_RADIUS_SQ.toFixed(6)} / max(
      4.0 * lampDist * lampDist * max(lampNdotL * lampNdotV, 0.0256),
      1e-5
    );
    let alpha2 = roughness2 + sourceAlpha2;
    let lampFacing2 = lampFacing * lampFacing;
    let tanHalf2 = (1.0 - lampFacing2) / max(lampFacing2, 1e-5);
    let rho2 = tanHalf2 / max(alpha2, 1e-5);
    let lampSupport = 1.0 - smoothstep(
      ${MARK_POINTER_LOBE_SUPPORT_INNER.toFixed(2)},
      ${MARK_POINTER_LOBE_SUPPORT_OUTER.toFixed(1)},
      rho2
    );
    let lampSpectral = exp(
      -rho2 * vec3<f32>(0.88, 1.0, 1.18)
    ) * lampSupport;
    let lampRaw = mix(vec3<f32>(lampSpectral.y), lampSpectral, dispersion * 0.4) *
      lampSpecF * lampGeo * lampGate * specNorm *
      vec3<f32>(0.86, 0.96, 1.0) *
      markUniforms.uSpecular * markUniforms.uLamp.w * outer * 2.15;
    let lampPeak = max(lampRaw.x, max(lampRaw.y, lampRaw.z));
    let lampHighlight = lampRaw *
      (1.0 / (1.0 + max(lampPeak - 0.22, 0.0) * 3.4));

    // INNER IMAGE. A plane mirror of the filament, not a Blinn glint, in the
    // SAME pinhole the CPU uses for the real bead. The virtual bead is the
    // real one reflected across this inner wall; it is then projected like
    // every other vertex so the ghost and the filament agree on size and
    // place. Lighting-reach falloff does not belong here: that is how far
    // the bead ILLUMINATES a surface, and it killed the ghost the moment
    // the bead left the face. Outer facets see the bead as TRANSMITTED.
    // TIR does not belong here either. The cavity is air, so these walls
    // are air-to-glass; a critical-angle test on N·V turned the octahedron
    // into chrome. Schlick on this image is the real reflection amount.
    //
    // Near inner walls (facingView < 0) used to be skipped: as a card they
    // hid the far hull. They now carry ONLY this image, so a copy of the
    // bead can sit on the glass you are looking through.
    let nearInner = (1.0 - outer) * select(0.0, 1.0, facingView < 0.0);
    let wallDist = dot(markUniforms.uCore - vWorld, normal);
    let virtualCore = markUniforms.uCore - normal * (2.0 * wallDist);
    let virtPersp = markUniforms.uCameraZ /
      max(markUniforms.uCameraZ - virtualCore.z, 1e-4);
    let virtUv = vec2<f32>(
      0.5 + virtualCore.x * markUniforms.uProjectScale * virtPersp /
        markUniforms.uLocalSize,
      0.5 - virtualCore.y * markUniforms.uProjectScale * virtPersp /
        markUniforms.uLocalSize
    );
    let imageR = markUniforms.uCoreRadius * markUniforms.uProjectScale *
      virtPersp / markUniforms.uLocalSize *
      (1.0 + 0.18 * markUniforms.uPulse);
    let toGhost = vScreen - virtUv;
    let coreImage = exp(-dot(toGhost, toGhost) / max(imageR * imageR * 1.7, 1e-8)) *
      step(0.0, wallDist);
    let coreImageF = f0 + (1.0 - f0) * pow(1.0 - nDotV, 5.0);
    let coreHighlight = markUniforms.uCoreTint *
      mix(coreImage, 1.0, nearInner) *
      mix(0.34, 1.0, coreImageF) *
      markUniforms.uCoreIntensity * (0.86 + 0.14 * markUniforms.uPulse) *
      (1.0 - outer);

    // EDGE FRINGE. A prism separates by ANGLE, so the separation is widest where
    // the ray leaves the glass most obliquely — the rim of the silhouette and
    // every visible arete, never the middle of a face. FRESNEL already measures
    // exactly that obliquity, so the fringe rides it rather than introducing a
    // second, disagreeing notion of grazing.
    //
    // The three channels peak at three different obliquities: red turns least
    // and so peaks a little inside the edge, blue turns most and hugs it. The
    // result sweeps red-through-violet across the last few pixels of a facet.
    // Width and strength are DISPERSION's alone, so obsidian gets nothing,
    // plain glass a hint of warmth, and diamond a full spectrum.
    let fringeBand = 1.0 - fresnel;
    let fringe = vec3<f32>(
      exp(-fringeBand * fringeBand * 42.0),
      exp(-fringeBand * fringeBand * 78.0),
      exp(-fringeBand * fringeBand * 130.0)
    ) * dispersion * outer;

    // CHROMATIC TRANSMISSION. The interior seen THROUGH this facet, sampled once
    // per channel along the refraction direction. Offset scales with three
    // things and each is load-bearing: DISPERSION, so obsidian bends nothing and
    // diamond bends most; BULK, so the deeper the ray goes through the wedge the
    // further the channels drift apart, which is what ties the effect to the
    // volume rather than to the surface; and OUTER, so only the hull refracts —
    // the cavity walls are already behind the bead and must not smear it twice.
    //
    // The direction is the refracted incident ray's screen-space remainder.
    // A facet presenting flat to the view still displaces nothing; an oblique
    // one shears the interior along Snell rather than along its own normal.
    // REFRACTION, and it is NOT the same thing as dispersion.
    //
    // Every glass here bends light: obsidian's index is 1.5, so it displaces
    // what is behind it exactly as plain glass does. What it does not do is
    // SPLIT that displacement by wavelength — that is dispersion, and only
    // diamond has much of it. The two were fused before: BEND was gated on
    // dispersion, so obsidian refracted nothing at all, which is wrong for a
    // material with an ordinary index.
    //
    // Snell's law, the real one. The small-angle stand-in was normal.xy *
    // (IOR-1), which ignores the view: two pixels on the same flat facet
    // bent identically, so the interior sheared as a rigid stamp. refract()
    // takes the actual incident ray, so the displacement varies across a
    // face the way a lens does, and diamond's eta is what makes it bend
    // further than glass — iorBend must not also scale the offset or the
    // index is counted twice.
    let backdropUv = vScreen;
    // CLAMPED in texel units. A grazing facet drives BULK to saturation and the
    // raw displacement past what the backdrop can resolve — the sampler then
    // steps over whole texels between neighbouring pixels and the edge breaks
    // into a coloured checkerboard. That is aliasing, not a strong effect, and
    // no gain reduction fixes it: the ceiling has to be a distance the texture
    // can actually supply.
    // FADED OUT at grazing, on top of the clamp. Right at the silhouette the
    // facet is edge-on, the wedge is only a few pixels wide, and the
    // displacement swings hard between neighbouring pixels — the clamp caps its
    // SIZE but not that swing. A real refraction has little to show there
    // either, since the ray travels along the surface rather than through it.
    //
    // BULK stays in the product. Removing it was tried on the theory that it
    // double-counted obliquity, and it measurably made the aliasing WORSE
    // (high-frequency energy 90 -> 102 on the worst frame): its 0.35 floor is
    // what holds the displacement down on face-on facets, which is most of the
    // mark most of the time.
    // uRefractOn is 0 WHILE THE BACKDROP IS BEING RENDERED. The back and front
    // shells share one shader, and the back facets are OUTER too, so during
    // the pass they were running this very sampler against last frame's texture
    // and their output was written straight back into it. That closed loop is
    // what the pixel-grid checkerboard was — it compounded every frame until it
    // saturated. It survived a clamp, a grazing fade and 2x supersampling
    // because none of those break a feedback path; only refusing to sample
    // during the pass does.
    let grazingFade = smoothstep(0.05, 0.24, nDotV) * markUniforms.uRefractOn;
    let eta = 1.0 / max(iorBend + 1.0, 1.001);
    let frontNormal = select(normal, -normal, dot(normal, viewDir) < 0.0);
    let bounceDir = reflect(-viewDir, frontNormal);
    // SCENE REFLECTION. F of the dielectric, not TIR. A critical-angle test
    // on N·V turned every octahedron face into chrome; Schlick keeps face-on
    // tables as windows and only the grazing rim as a mirror. The sample is
    // the Pixi stage without the gem. Gated on uRefractOn so the interior
    // backdrop pass cannot write the env into itself, and on uEnvOn so the
    // navigation mark (too small to read a card, too expensive to recapture one)
    // stays inert.
    let envUv = vClipUv + vec2<f32>(bounceDir.x, -bounceDir.y) *
      markUniforms.uEnvJump;
    let envSample = textureSample(uEnv, uEnvSampler, envUv);
    var envHighlight = envSample.rgb * envSample.a * fresnel * outer *
      markUniforms.uEnvOn * markUniforms.uRefractOn;
    // Local pointer reflection. The long uEnvJump looks at the tagline; when
    // the cursor sits ON the gem that sample misses the echo, and Fresnel
    // hides face-on tables anyway. A short hop from the pointer UV, gated to
    // facets near it, is the silhouette in the glass — not a Lambert fill.
    let toPointer = markUniforms.uPointerClip.xy - vClipUv;
    let cursorNear = exp(-dot(toPointer, toPointer) * 110.0) *
      markUniforms.uPointerClip.z;
    let cursorUv = markUniforms.uPointerClip.xy +
      vec2<f32>(bounceDir.x, -bounceDir.y) * markUniforms.uPointerClip.w;
    let cursorSample = textureSample(uEnv, uEnvSampler, cursorUv);
    envHighlight += cursorSample.rgb * cursorSample.a * cursorNear * outer *
      markUniforms.uEnvOn * markUniforms.uRefractOn;
    let refracted = refract(-viewDir, frontNormal, eta);
    let rawBend = refracted.xy * markUniforms.uBend *
      mix(0.55, 1.0, bulk) * outer * grazingFade;
    let bendLength = length(rawBend);
    let bend = select(
      rawBend,
      rawBend * markUniforms.uMaxBend / max(bendLength, 1e-4),
      bendLength > markUniforms.uMaxBend
    );
    let offset = bend * markUniforms.uBackdropTexel;
    // The dispersive HALF-SPREAD around that common displacement: red bends
    // least, blue most. Zero for obsidian, which refracts without splitting.
    // uSplit is a PIXEL distance — the half-spread when the bend saturates at
    // its ceiling — so it is scaled by the bend's own ratio to that ceiling.
    // Multiplying the offset by the raw pixel count instead made the split a
    // MULTIPLE of the whole displacement: ~75px per channel on the hero
    // backdrop, which tore the filament into three separate discs and drew a
    // ghost hull. The header only survived it because its ceiling is 3px.
    let spread = offset * dispersion *
      (markUniforms.uSplit / max(markUniforms.uMaxBend, 1e-3));
    let straight = textureSample(uBackdrop, uBackdropSampler, backdropUv + offset);
    let shiftR = textureSample(uBackdrop, uBackdropSampler,
      backdropUv + offset - spread).r;
    let shiftB = textureSample(uBackdrop, uBackdropSampler,
      backdropUv + offset + spread).b;
    // What refraction ADDS is the difference between the displaced sample and
    // the undisplaced one, PER CHANNEL — red against red, blue against blue.
    //
    // Subtracting the green channel from all three instead, as this first did,
    // is not a colour difference at all: it zeroes green by construction and
    // leaves red and blue carrying absolute brightness, so every lit part of the
    // interior gained flat magenta whether or not anything was displaced. The
    // rank hues did not survive it.
    //
    // Where the offset is zero — a facet presenting flat, or obsidian, which
    // bends nothing — the two samples are the same texel and this is exactly
    // zero. That is the property worth having: the effect cannot tint anything
    // it did not actually displace.
    let split = clamp(
      vec3<f32>(shiftR - straight.r, 0.0, shiftB - straight.b),
      vec3<f32>(-0.25),
      vec3<f32>(0.25)
    ) * transmit;

    // TRANSMISSION. The glass DRAWS what is behind it, rather than letting the
    // alpha blend show it through.
    //
    // This used to be a corrective difference against the undisplaced interior,
    // which only worked because alpha was capped at 0.44 and the blend below
    // was doing the real transmitting. That cap was the last arbitrary number
    // in the material model: how much a glass hides is Beer-Lambert over the
    // path, and nothing else. So the facet now samples the interior at the BENT
    // position and attenuates it by the same absorption that drives its
    // opacity — obsidian swallows what is behind it, diamond passes it almost
    // whole — and alpha is free to approach 1.
    //
    // The bead behind a diamond facet is therefore seen genuinely displaced,
    // not merely fringed: the displacement is the transmitted image itself.
    // EMPTY CAVITY. Beer-Lambert on the near slab is the right model for a hot
    // filament; applied to the far hull it eats those faces to black, and a
    // table — especially the grey obsidian one — reads as a veil over the
    // field. When the inspect checkbox has killed the bead, pass the far walls
    // through as glass. The far faces already have their own material.
    let cavity = smoothstep(0.0, 0.35, markUniforms.uCoreIntensity);
    let attenuation = exp(-absorption * path);
    let slabPass = mix(1.0, attenuation, cavity);
    let transmittedRaw = straight.rgb * slabPass * transmit * bounce;
    // The filament is authored at alpha 1, so a clear table copies 8-bit white
    // into a disc. Compress only the excess; midtones of the interior stay put.
    // WGSL let is immutable: assigning back to transmitted is a refused
    // pipeline, and the turn film then captures only the aura (peak ~22).
    let interiorPeak = max(transmittedRaw.x, max(transmittedRaw.y, transmittedRaw.z));
    let transmitted = transmittedRaw *
      (1.0 / (1.0 + max(interiorPeak - 0.82, 0.0) * 1.6));

    // The facet's OWN shading: body, wall scatter, highlights, edges. Body and
    // chromatic split ride BOUNCE so they yield to the mirror at grazing; the
    // highlight and rim ARE that mirror.
    // WALL SCATTER. The bead lights the glass it sits behind. Outer facets
    // used to ignore the analytic core (it is the same light as TRANSMITTED),
    // so a face the key did not hit was a flat painted triangle. A little of
    // that core as SURFACE, not as interior, is the wall glowing — a gradient
    // toward the bead, which is what a lit cavity does to the near glass.
    let scatter = vTint * core * bounce * outer * 0.28;
    // COVER. Seeing through a clear table and painting Lambert on it are the
    // same energy counted twice: the turn film clipped 16k RGB-255 pixels on
    // a face the camera sees, and diamond's Blinn exponent is 200 so that
    // glaze is not the key. Yield the body where transmission already
    // carries the interior.
    let interiorWeight = max(transmitted.x, max(transmitted.y, transmitted.z));
    // Face-on table as a window onto the far hull, only while the cavity is
    // empty. With the bead lit, interiorWeight already yields Lambert; adding
    // this then would punch a hole next to a bright filament.
    let tableWindow = (1.0 - cavity) * outer * nDotV * mix(1.0, 0.4, bulk);
    let cover = 1.0 - clamp(max(interiorWeight * outer, tableWindow) * 0.85, 0.0, 1.0);
    let shade = vec3<f32>(markUniforms.uAmbient) +
      vec3<f32>(1.0, 0.94, 0.84) * (0.42 * sun);
    let surface = vTint * body * shade *
        mix(1.0, 0.58, bulk) * bounce * cover * (1.0 - nearInner) +
      scatter +
      highlight * 0.9 +
      windowHighlight +
      lampHighlight +
      envHighlight +
      coreHighlight * 1.15 +
      fringe * 0.32 +
      split * 0.9 * bounce +
      // RIM is the grazing term only. Face-on Schlick is F0, which should
      // reflect the near-black field, not a 0.20 white floor; that floor is
      // why clip_px_max stayed at 8k after the key gain was pulled.
      vec3<f32>(0.75, 0.88, 1.0) *
        (pow(1.0 - nDotV, 5.0) * markUniforms.uRim) * (1.0 - nearInner);

    // CORE and TRANSMITTED are the SAME light counted two ways: CORE is the
    // bead computed analytically against this facet, TRANSMITTED is that same
    // bead read out of the backdrop texture. Adding both was double-counting —
    // the interior came out twice as bright as it should and washed the rank
    // tints out from underneath.
    //
    // Outer facets take the sampled version, which is the physical one and the
    // only one that carries the refracted displacement. Cavity facets have no
    // backdrop behind them and keep the analytic term, which is what gives the
    // crystal its lit interior.
    let interior = mix(
      markUniforms.uCoreTint * core * (1.0 - nearInner),
      transmitted * markUniforms.uRefract,
      outer
    );
    let lit = surface + interior;
    // The bead only NUDGES alpha. It crosses the cavity several times a second,
    // so whatever it adds here reads as flicker rather than as light; its
    // brightness belongs in LIT, where it lands on colour instead of density.
    // Fresnel is scaled DOWN into alpha. At full weight diamond's edges alone
    // moved alpha by half, and a facet goes from face-on to edge-on every turn:
    // that is a density swing wearing the costume of an edge highlight. It keeps
    // its full weight in LIT, where it belongs.
    // ALPHA is COVERAGE, not density. The facet paints its own shading plus the
    // interior it transmits, so it must replace the undistorted behind rather
    // than let a second copy blend through. How much of the interior you SEE is
    // in TRANSMITTED (Beer-Lambert over the path). Using 1 - attenuation *
    // transmit as outer alpha punched a hole in diamond — its transmit is 1.32,
    // so that expression went negative, and the undistorted bead ghosted next
    // to the refracted one.
    //
    // The cavity facets keep the old behaviour: they have nothing behind them
    // worth transmitting and are what gives the crystal its interior body, so
    // vSurface.x still scales them.
    let alpha = clamp(
      mix(
        mix(coreImage, vSurface.x * opacity, 1.0 - nearInner),
        1.0,
        outer
      ) + core * 0.1 * (1.0 - nearInner),
      0.0,
      1.0
    );
    // COVERAGE AA, grazing outer edges only. Fading every barycentric edge
    // punched dark aretes through the crystal: a shared crease is one triangle
    // against the dark field, not against its neighbour. Grazing is the
    // silhouette against that field, which is the stair-step the film shows.
    let baryMin = min(vBary.x, min(vBary.y, vBary.z));
    let edgeCover = smoothstep(0.0, max(fwidth(baryMin), 1e-5), baryMin);
    let silhouette = 1.0 - smoothstep(0.12, 0.32, nDotV);
    let alphaOut = alpha * mix(1.0, edgeCover, outer * silhouette);
    return vec4<f32>(lit * alphaOut, alphaOut) * vColor;
  }
`;

export const MARK_SHELL_GLSL_VERTEX = /* glsl */ `#version 300 es
  in vec2 aPosition;
  in vec3 aWorld;
  in vec3 aNormal;
  in vec3 aTint;
  in vec2 aSurface;
  in vec4 aMaterial;
  in vec3 aFinish;
  in vec3 aBary;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  uniform vec4 uColor;
  uniform vec4 uWorldColorAlpha;
  uniform float uLocalSize;

  out vec3 vWorld;
  out vec3 vNormal;
  out vec3 vTint;
  out vec2 vSurface;
  out vec4 vColor;
  out vec4 vMaterial;
  out vec3 vFinish;
  out vec2 vScreen;
  out vec3 vBary;
  out vec2 vClipUv;

  void main() {
    mat3 matrix = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec3 clip = matrix * vec3(aPosition, 1.0);
    gl_Position = vec4(clip.xy, 0.0, 1.0);
    vWorld = aWorld;
    vNormal = aNormal;
    vTint = aTint;
    vSurface = aSurface;
    vColor = uColor * uWorldColorAlpha;
    vMaterial = aMaterial;
    vFinish = aFinish;
    vBary = aBary;
    vScreen = aPosition / uLocalSize;
    vClipUv = clip.xy * 0.5 + 0.5;
  }
`;

export const MARK_SHELL_GLSL = /* glsl */ `#version 300 es
  precision highp float;

  in vec3 vWorld;
  in vec3 vNormal;
  in vec3 vTint;
  in vec2 vSurface;
  in vec4 vColor;
  in vec4 vMaterial;
  in vec3 vFinish;
  in vec2 vScreen;
  in vec3 vBary;
  in vec2 vClipUv;
  out vec4 finalColor;

  uniform sampler2D uBackdrop;
  uniform sampler2D uEnv;

  uniform vec3 uCore;
  uniform vec3 uLightDir;
  uniform vec3 uCoreTint;
  uniform vec4 uLamp;
  uniform float uCoreReach;
  uniform float uCoreIntensity;
  uniform float uAmbient;
  uniform float uPulse;
  uniform float uWall;
  uniform float uMinPath;
  uniform float uOpacityRef;
  uniform float uSplit;
  uniform float uBend;
  uniform float uMaxBend;
  uniform float uRefract;
  uniform float uRefractOn;
  uniform float uSpecular;
  uniform float uRim;
  uniform float uLocalSize;
  uniform vec2 uBackdropTexel;
  uniform float uCoreRadius;
  uniform float uEnvOn;
  uniform float uEnvJump;
  uniform vec4 uPointerClip;
  uniform float uCameraZ;
  uniform float uProjectScale;

  void main() {
    vec3 normal = normalize(vNormal);
    float outer = vSurface.y;
    // Same all-diamond material attributes as the WGSL path; keep both in step.
    float specularPower = vMaterial.x;
    float dispersion = vMaterial.y;
    float f0 = vMaterial.z;
    float absorption = vMaterial.w;
    float iorBend = vFinish.x;
    float transmit = vFinish.y;
    float body = vFinish.z;

    // Same view ray as the WGSL path; keep the two in step.
    vec2 viewOffset = vec2(vScreen.x - 0.5, 0.5 - vScreen.y) * 1.15;
    vec3 viewDir = normalize(vec3(viewOffset.x, viewOffset.y, 1.0));
    float nDotV = min(abs(dot(normal, viewDir)), 1.0);

    // Same volume model as the WGSL path; keep the two in step. Opacity at the
    // material's reference depth, bulk for the extra length a grazing ray takes.
    float path = uWall / max(nDotV, 0.16);
    float opacity = (1.0 - exp(-absorption * uMinPath)) / max(uOpacityRef, 1e-4);
    float bulk = 1.0 - exp(-absorption * max(path - uMinPath, 0.0) * 0.35);

    vec3 toCore = uCore - vWorld;
    float dist = length(toCore);
    vec3 coreDir = toCore / max(dist, 1e-4);
    float reach = clamp(1.0 - dist / uCoreReach, 0.0, 1.0);
    float falloff = reach * reach * (3.0 - 2.0 * reach);
    float incidence = max(dot(normal, coreDir), 0.0);
    float core = falloff * (0.34 + 0.66 * incidence) *
      uCoreIntensity * (0.86 + 0.14 * uPulse) * transmit * mix(1.0, 0.45, bulk);

    float facingView = dot(normal, viewDir);
    float trueSun = max(dot(normal, uLightDir), 0.0);
    vec3 bodyNormal = (outer > 0.5 && facingView < 0.0) ? -normal : normal;
    float sun = max(dot(bodyNormal, uLightDir), 0.0);
    vec3 convex = vec3(vScreen.x - 0.5, 0.5 - vScreen.y, 0.02) * 2.8;
    vec3 shadeNormal = normalize(normal + convex);
    vec3 halfVector = normalize(uLightDir + viewDir);
    float facing = max(dot(shadeNormal, halfVector), 0.0);
    vec3 spectral = vec3(
      pow(facing, specularPower * 0.85),
      pow(facing, specularPower * 1.25),
      pow(facing, specularPower * 1.85)
    );
    float specF = f0 + (1.0 - f0) * pow(1.0 - max(dot(viewDir, halfVector), 0.0), 5.0);
    float geo = trueSun * nDotV / max(trueSun + nDotV - trueSun * nDotV, 1e-4);
    float specNorm = (specularPower + 2.0) / 51.0;
    vec3 inPlane = vWorld - normal * dot(vWorld, normal);
    float tableLobe = exp(-dot(inPlane, inPlane) * 36.0);
    vec3 highlight = mix(vec3(spectral.y), spectral, dispersion) *
      specF * geo * specNorm * uSpecular * outer * tableLobe;
    vec3 windowDir = normalize(vec3(0.85, 0.35, 0.15));
    vec3 windowHalf = normalize(windowDir + viewDir);
    float windowFacing = max(dot(shadeNormal, windowHalf), 0.0);
    float windowNdotL = max(dot(normal, windowDir), 0.0);
    float windowGeo = windowNdotL * nDotV /
      max(windowNdotL + nDotV - windowNdotL * nDotV, 1e-4);
    float windowSpecF = f0 + (1.0 - f0) *
      pow(1.0 - max(dot(viewDir, windowHalf), 0.0), 5.0);
    vec3 windowHighlight = vec3(0.78, 0.88, 1.0) *
      pow(windowFacing, specularPower) * windowSpecF * windowGeo * specNorm *
      uSpecular * outer * 0.28 * tableLobe;
    // Same Schlick as the WGSL path; keep the two in step.
    float fresnel = f0 + (1.0 - f0) * pow(1.0 - nDotV, 5.0);
    float bounce = 1.0 - fresnel;

    // POINTER LAMP. Same physical finite-source lobe as the WGSL path.
    vec3 camera = vec3(0.0, 0.0, uCameraZ);
    vec3 screenPoint = vec3(
      (vScreen.x - 0.5) * uLocalSize / uProjectScale,
      (0.5 - vScreen.y) * uLocalSize / uProjectScale,
      0.0
    );
    vec3 surfaceRay = screenPoint - camera;
    float surfacePlaneOffset = dot(normal, vWorld);
    float surfaceDenom = dot(normal, surfaceRay);
    float safeSurfaceDenom = abs(surfaceDenom) < 1e-4
      ? (surfaceDenom < 0.0 ? -1e-4 : 1e-4)
      : surfaceDenom;
    float surfaceT = (surfacePlaneOffset - dot(normal, camera)) /
      safeSurfaceDenom;
    vec3 surfacePoint = camera + surfaceRay * surfaceT;
    float surfaceValid = step(1e-4, abs(surfaceDenom)) * step(0.0, surfaceT);
    vec3 toLampView = camera - surfacePoint;
    vec3 lampViewDir = toLampView / max(length(toLampView), 1e-4);
    vec3 toLamp = uLamp.xyz - surfacePoint;
    float lampDist = length(toLamp);
    vec3 lampDir = toLamp / max(lampDist, 1e-4);
    float lampNdotL = max(dot(normal, lampDir), 0.0);
    float lampNdotV = max(dot(normal, lampViewDir), 0.0);
    vec3 lampHalfSum = lampDir + lampViewDir;
    float lampHalfLength2 = dot(lampHalfSum, lampHalfSum);
    vec3 lampHalf = lampHalfSum / sqrt(max(lampHalfLength2, 1e-6));
    float lampFacing = clamp(dot(normal, lampHalf), 0.0, 1.0);
    float lampSpecF = f0 + (1.0 - f0) *
      pow(1.0 - max(dot(lampViewDir, lampHalf), 0.0), 5.0);
    float lampGeo = lampNdotL * lampNdotV /
      max(lampNdotL + lampNdotV - lampNdotL * lampNdotV, 1e-4);
    float lampGate = smoothstep(0.0, 0.08, lampNdotL) *
      smoothstep(0.0, 0.08, lampNdotV) * step(1e-6, lampHalfLength2) *
      surfaceValid;
    float roughness2 = 2.0 / max(specularPower + 2.0, 2.0);
    float sourceAlpha2 = ${MARK_POINTER_SOURCE_RADIUS_SQ.toFixed(6)} / max(
      4.0 * lampDist * lampDist * max(lampNdotL * lampNdotV, 0.0256),
      1e-5
    );
    float alpha2 = roughness2 + sourceAlpha2;
    float lampFacing2 = lampFacing * lampFacing;
    float tanHalf2 = (1.0 - lampFacing2) / max(lampFacing2, 1e-5);
    float rho2 = tanHalf2 / max(alpha2, 1e-5);
    float lampSupport = 1.0 - smoothstep(
      ${MARK_POINTER_LOBE_SUPPORT_INNER.toFixed(2)},
      ${MARK_POINTER_LOBE_SUPPORT_OUTER.toFixed(1)},
      rho2
    );
    vec3 lampSpectral = exp(-rho2 * vec3(0.88, 1.0, 1.18)) * lampSupport;
    vec3 lampRaw = mix(vec3(lampSpectral.y), lampSpectral, dispersion * 0.4) *
      lampSpecF * lampGeo * lampGate * specNorm *
      vec3(0.86, 0.96, 1.0) *
      uSpecular * uLamp.w * outer * 2.15;
    float lampPeak = max(lampRaw.x, max(lampRaw.y, lampRaw.z));
    vec3 lampHighlight = lampRaw *
      (1.0 / (1.0 + max(lampPeak - 0.22, 0.0) * 3.4));

    // INNER IMAGE. Same virtual filament as the WGSL path; keep the two in step.
    float nearInner = (1.0 - outer) * (facingView < 0.0 ? 1.0 : 0.0);
    float wallDist = dot(uCore - vWorld, normal);
    vec3 virtualCore = uCore - normal * (2.0 * wallDist);
    float virtPersp = uCameraZ / max(uCameraZ - virtualCore.z, 1e-4);
    vec2 virtUv = vec2(
      0.5 + virtualCore.x * uProjectScale * virtPersp / uLocalSize,
      0.5 - virtualCore.y * uProjectScale * virtPersp / uLocalSize
    );
    float imageR = uCoreRadius * uProjectScale * virtPersp / uLocalSize *
      (1.0 + 0.18 * uPulse);
    vec2 toGhost = vScreen - virtUv;
    float coreImage = exp(-dot(toGhost, toGhost) / max(imageR * imageR * 1.7, 1e-8)) *
      step(0.0, wallDist);
    float coreImageF = f0 + (1.0 - f0) * pow(1.0 - nDotV, 5.0);
    vec3 coreHighlight = uCoreTint *
      mix(coreImage, 1.0, nearInner) *
      mix(0.34, 1.0, coreImageF) *
      uCoreIntensity * (0.86 + 0.14 * uPulse) *
      (1.0 - outer);

    // Same chromatic transmission as the WGSL path; keep the two in step.
    // Same refraction/dispersion split as the WGSL path; keep the two in step.
    // Same texel clamp as the WGSL path; keep the two in step.
    // Same grazing fade as the WGSL path; keep the two in step.
    float grazingFade = smoothstep(0.05, 0.24, nDotV) * uRefractOn;
    float eta = 1.0 / max(iorBend + 1.0, 1.001);
    vec3 frontNormal = dot(normal, viewDir) < 0.0 ? -normal : normal;
    vec3 bounceDir = reflect(-viewDir, frontNormal);
    vec2 envUv = vClipUv + vec2(bounceDir.x, -bounceDir.y) * uEnvJump;
    vec4 envSample = texture(uEnv, envUv);
    vec3 envHighlight = envSample.rgb * envSample.a * fresnel * outer *
      uEnvOn * uRefractOn;
    vec2 toPointer = uPointerClip.xy - vClipUv;
    float cursorNear = exp(-dot(toPointer, toPointer) * 110.0) * uPointerClip.z;
    vec2 cursorUv = uPointerClip.xy + vec2(bounceDir.x, -bounceDir.y) * uPointerClip.w;
    vec4 cursorSample = texture(uEnv, cursorUv);
    envHighlight += cursorSample.rgb * cursorSample.a * cursorNear * outer *
      uEnvOn * uRefractOn;
    vec3 refracted = refract(-viewDir, frontNormal, eta);
    vec2 rawBend = refracted.xy * uBend * mix(0.55, 1.0, bulk) * outer * grazingFade;
    float bendLength = length(rawBend);
    vec2 bend = bendLength > uMaxBend
      ? rawBend * uMaxBend / max(bendLength, 1e-4)
      : rawBend;
    vec2 offset = bend * uBackdropTexel;
    // Same pixel-true half-spread as the WGSL path; keep the two in step.
    vec2 spread = offset * dispersion * (uSplit / max(uMaxBend, 1e-3));
    vec4 straight = texture(uBackdrop, vScreen + offset);
    float shiftR = texture(uBackdrop, vScreen + offset - spread).r;
    float shiftB = texture(uBackdrop, vScreen + offset + spread).b;
    vec3 split = clamp(
      vec3(shiftR - straight.r, 0.0, shiftB - straight.b),
      -0.25,
      0.25
    ) * transmit;

    // Same transmission as the WGSL path; keep the two in step.
    float cavity = smoothstep(0.0, 0.35, uCoreIntensity);
    float attenuation = exp(-absorption * path);
    float slabPass = mix(1.0, attenuation, cavity);
    vec3 transmitted = straight.rgb * slabPass * transmit * bounce;
    float interiorPeak = max(transmitted.x, max(transmitted.y, transmitted.z));
    transmitted = transmitted * (1.0 / (1.0 + max(interiorPeak - 0.82, 0.0) * 1.6));

    // Same edge fringe as the WGSL path; keep the two in step.
    float fringeBand = 1.0 - fresnel;
    vec3 fringe = vec3(
      exp(-fringeBand * fringeBand * 42.0),
      exp(-fringeBand * fringeBand * 78.0),
      exp(-fringeBand * fringeBand * 130.0)
    ) * dispersion * outer;

    // Same split as the WGSL path; keep the two in step.
    vec3 scatter = vTint * core * bounce * outer * 0.28;
    float interiorWeight = max(transmitted.x, max(transmitted.y, transmitted.z));
    float tableWindow = (1.0 - cavity) * outer * nDotV * mix(1.0, 0.4, bulk);
    float cover = 1.0 - clamp(max(interiorWeight * outer, tableWindow) * 0.85, 0.0, 1.0);
    vec3 shade = vec3(uAmbient) + vec3(1.0, 0.94, 0.84) * (0.42 * sun);
    vec3 surface = vTint * body * shade *
      mix(1.0, 0.58, bulk) * bounce * cover * (1.0 - nearInner) +
      scatter +
      highlight * 0.9 +
      windowHighlight +
      lampHighlight +
      envHighlight +
      coreHighlight * 1.15 +
      fringe * 0.32 +
      split * 0.9 * bounce +
      vec3(0.75, 0.88, 1.0) * (pow(1.0 - nDotV, 5.0) * uRim) * (1.0 - nearInner);
    vec3 interior = mix(uCoreTint * core * (1.0 - nearInner), transmitted * uRefract, outer);
    vec3 lit = surface + interior;
    // Same coverage model as the WGSL path; keep the two in step.
    float alpha = clamp(
      mix(
        mix(coreImage, vSurface.x * opacity, 1.0 - nearInner),
        1.0,
        outer
      ) + core * 0.1 * (1.0 - nearInner),
      0.0,
      1.0
    );
    float baryMin = min(vBary.x, min(vBary.y, vBary.z));
    float edgeCover = smoothstep(0.0, max(fwidth(baryMin), 1e-5), baryMin);
    float silhouette = 1.0 - smoothstep(0.12, 0.32, nDotV);
    alpha = alpha * mix(1.0, edgeCover, outer * silhouette);
    finalColor = vec4(lit * alpha, alpha) * vColor;
  }
`;

/**
 * AVATAR ORB — the account's picture under a faceted glass sphere.
 *
 * One quad, one program, no render-to-texture pass: the "sphere" is entirely
 * in the fragment shader. `aUv` spans -1..1 over the quad, so `length(uv)` is
 * the disc coordinate and `z = sqrt(1 - r^2)` is the hemisphere the light and
 * the refraction are computed against.
 *
 * The photo is sampled with a LENS PINCH rather than wrapped on a turning
 * sphere. A face mapped onto a rotating sphere spends half of every revolution
 * facing away, which is exactly wrong for an avatar; a glass ball sitting over
 * a photo magnifies and bends it while the face stays put, and the turn reads
 * in the moving facet highlights instead of in the subject.
 *
 * With no photo (`uHasPhoto = 0`) the interior is a two-colour gradient from
 * the principal's hash, so an account without a provider picture gets the same
 * material and the same motion rather than a grey placeholder.
 */
export const AVATAR_ORB_WGSL = /* wgsl */ `
  struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
  }

  struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
  }

  struct OrbUniforms {
    uAccentA: vec3<f32>,
    uAccentB: vec3<f32>,
    uAccentC: vec3<f32>,
    uSeedA: vec3<f32>,
    uSeedB: vec3<f32>,
    uLight: vec2<f32>,
    uSpin: f32,
    uHover: f32,
    uHasPhoto: f32,
    uFacets: f32,
    uRadiusPx: f32,
  }

  @group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
  @group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
  @group(2) @binding(0) var<uniform> orbUniforms: OrbUniforms;
  // Declared from the first draw even when there is no picture yet: a resource
  // that appears later would change the bind-group layout mid-life, which
  // WebGPU refuses. Texture.EMPTY keeps the layout fixed and the sample inert.
  @group(2) @binding(1) var uPhoto: texture_2d<f32>;
  @group(2) @binding(2) var uPhotoSampler: sampler;

  struct VertexInput {
    @location(0) aPosition: vec2<f32>,
    @location(1) aUv: vec2<f32>,
  }

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUv: vec2<f32>,
    @location(1) vColor: vec4<f32>,
  }

  @vertex
  fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let matrix = globalUniforms.uProjectionMatrix *
      globalUniforms.uWorldTransformMatrix *
      localUniforms.uTransformMatrix;
    let clip = matrix * vec3<f32>(input.aPosition, 1.0);
    out.position = vec4<f32>(clip.xy, 0.0, 1.0);
    out.vUv = input.aUv;
    out.vColor = localUniforms.uColor * globalUniforms.uWorldColorAlpha;
    return out;
  }

  @fragment
  fn mainFragment(
    @location(0) vUv: vec2<f32>,
    @location(1) vColor: vec4<f32>,
  ) -> @location(0) vec4<f32> {
    let r = length(vUv);
    // Edge coverage in UV units: one pixel and a half of the actual on-screen
    // radius, so the silhouette stays smooth at every orb size.
    let aa = 1.5 / max(orbUniforms.uRadiusPx, 1.0);
    // NO EARLY RETURN outside the disc, deliberately: WGSL requires
    // textureSample to be reached in UNIFORM control flow, and a discard-shaped
    // branch on r (a per-pixel varying) makes it non-uniform — Dawn refuses to
    // compile the module at all. Coverage is applied to alpha at the bottom
    // instead, which costs one sample outside the circle and is why this
    // shader is one flat pass with no branches.
    let cover = 1.0 - smoothstep(1.0 - aa, 1.0, r);
    let z = sqrt(max(1.0 - r * r, 0.0));
    let normal = vec3<f32>(vUv, z);

    // Facet wedges of the shell. The cell index turns with uSpin, so the
    // facets sweep past the light while the subject stays centred.
    let tau = 6.28318530718;
    let wedge = tau / max(orbUniforms.uFacets, 3.0);
    let angle = atan2(vUv.y, vUv.x) + orbUniforms.uSpin;
    let cell = floor(angle / wedge);
    let facetAngle = (cell + 0.5) * wedge;
    let facetDir = vec3<f32>(cos(facetAngle), sin(facetAngle), 1.35);
    let facetNormal = normalize(mix(normal, normalize(facetDir), 0.34));
    // Per-facet brightness. A shell cut from glass never shows two neighbours
    // at the same value; without this the wedges only differ by their light
    // response and the orb reads as a flat pinwheel rather than as facets.
    let facetJitter = fract(sin(cell * 12.9898) * 43758.5453) - 0.5;
    // The seam crease is a feature OF THE SHELL, so it fades toward the
    // centre. Constant along the radius it drew hard spokes to the middle.
    let seam = abs(fract(angle / wedge) - 0.5) * 2.0;
    let crease = smoothstep(0.80, 1.0, seam) *
      smoothstep(0.40, 0.98, r) *
      (0.07 + 0.20 * orbUniforms.uHover);

    // Refraction: a lens pinch toward the centre, plus a slow parallax nudge
    // so the interior breathes with the turn instead of sitting still.
    let pinch = 0.20 + 0.06 * orbUniforms.uHover;
    let drift = vec2<f32>(sin(orbUniforms.uSpin), cos(orbUniforms.uSpin * 0.8)) *
      0.014 * (1.0 - z);
    let lensUv = vUv * (1.0 - pinch * (1.0 - z)) + drift;
    let photoUv = clamp(lensUv * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
    let sampled = textureSample(uPhoto, uPhotoSampler, photoUv).rgb;
    let gradient = mix(
      orbUniforms.uSeedA,
      orbUniforms.uSeedB,
      clamp(0.5 + 0.5 * (lensUv.y * 0.9 + lensUv.x * 0.4), 0.0, 1.0)
    );
    let interior = mix(gradient, sampled, orbUniforms.uHasPhoto);

    // Key light, parallaxed by the pointer sample the renderer already keeps.
    let lightDir = normalize(vec3<f32>(
      orbUniforms.uLight.x * 0.8 - 0.30,
      orbUniforms.uLight.y * 0.8 - 0.42,
      0.86
    ));
    let view = vec3<f32>(0.0, 0.0, 1.0);
    // Named halfVector, not half: WGSL reserves 'half'.
    let halfVector = normalize(lightDir + view);
    // Two lobes: a broad sheen that shapes the sphere and a tight glint that
    // says GLASS. One exponent could not do both — 46 alone left the body
    // unlit, and a low exponent alone washed the facets out.
    let facing = max(dot(facetNormal, halfVector), 0.0);
    let specular = pow(facing, 26.0) * (0.30 + 0.55 * orbUniforms.uHover) +
      pow(facing, 90.0) * (0.55 + 0.95 * orbUniforms.uHover);
    let diffuse = (0.52 + 0.48 * max(dot(facetNormal, lightDir), 0.0)) *
      (1.0 + facetJitter * 0.16);
    let fresnel = pow(1.0 - z, 4.0);

    // Rim: teal at rest, ramping to amber on hover, with violet held on the
    // grazing edge so the three brand faces are all present.
    let rim = mix(
      mix(orbUniforms.uAccentA, orbUniforms.uAccentB, orbUniforms.uHover),
      orbUniforms.uAccentC,
      smoothstep(0.62, 1.0, r) * 0.42
    );
    // Glass absorbs toward the silhouette: the far edge is thicker glass.
    let body = interior * diffuse * (0.74 + 0.26 * z);
    let lit = body +
      rim * fresnel * (0.72 + 0.55 * orbUniforms.uHover) +
      vec3<f32>(0.92, 0.96, 1.0) * specular +
      rim * crease;
    let alpha = cover;
    return vec4<f32>(lit * alpha, alpha) * vColor;
  }
`;

export const AVATAR_ORB_GLSL_VERTEX = /* glsl */ `#version 300 es
  in vec2 aPosition;
  in vec2 aUv;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  uniform vec4 uColor;
  uniform vec4 uWorldColorAlpha;

  out vec2 vUv;
  out vec4 vColor;

  void main() {
    mat3 matrix = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec3 clip = matrix * vec3(aPosition, 1.0);
    gl_Position = vec4(clip.xy, 0.0, 1.0);
    vUv = aUv;
    vColor = uColor * uWorldColorAlpha;
  }
`;

export const AVATAR_ORB_GLSL = /* glsl */ `#version 300 es
  precision highp float;

  in vec2 vUv;
  in vec4 vColor;

  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform vec3 uAccentC;
  uniform vec3 uSeedA;
  uniform vec3 uSeedB;
  uniform vec2 uLight;
  uniform float uSpin;
  uniform float uHover;
  uniform float uHasPhoto;
  uniform float uFacets;
  uniform float uRadiusPx;
  uniform sampler2D uPhoto;

  out vec4 finalColor;

  void main() {
    float r = length(vUv);
    float aa = 1.5 / max(uRadiusPx, 1.0);
    // Branchless for the same reason as the WGSL path; keep the two in step.
    float cover = 1.0 - smoothstep(1.0 - aa, 1.0, r);
    float z = sqrt(max(1.0 - r * r, 0.0));
    vec3 normal = vec3(vUv, z);

    float tau = 6.28318530718;
    float wedge = tau / max(uFacets, 3.0);
    float angle = atan(vUv.y, vUv.x) + uSpin;
    float cell = floor(angle / wedge);
    float facetAngle = (cell + 0.5) * wedge;
    vec3 facetDir = vec3(cos(facetAngle), sin(facetAngle), 1.35);
    vec3 facetNormal = normalize(mix(normal, normalize(facetDir), 0.34));
    float facetJitter = fract(sin(cell * 12.9898) * 43758.5453) - 0.5;
    float seam = abs(fract(angle / wedge) - 0.5) * 2.0;
    float crease = smoothstep(0.80, 1.0, seam) *
      smoothstep(0.40, 0.98, r) *
      (0.07 + 0.20 * uHover);

    float pinch = 0.20 + 0.06 * uHover;
    vec2 drift = vec2(sin(uSpin), cos(uSpin * 0.8)) * 0.014 * (1.0 - z);
    vec2 lensUv = vUv * (1.0 - pinch * (1.0 - z)) + drift;
    vec2 photoUv = clamp(lensUv * 0.5 + 0.5, vec2(0.0), vec2(1.0));
    vec3 sampled = texture(uPhoto, photoUv).rgb;
    vec3 gradient = mix(
      uSeedA,
      uSeedB,
      clamp(0.5 + 0.5 * (lensUv.y * 0.9 + lensUv.x * 0.4), 0.0, 1.0)
    );
    vec3 interior = mix(gradient, sampled, uHasPhoto);

    vec3 lightDir = normalize(vec3(uLight.x * 0.8 - 0.30, uLight.y * 0.8 - 0.42, 0.86));
    vec3 view = vec3(0.0, 0.0, 1.0);
    vec3 halfVector = normalize(lightDir + view);
    float facing = max(dot(facetNormal, halfVector), 0.0);
    float specular = pow(facing, 26.0) * (0.30 + 0.55 * uHover) +
      pow(facing, 90.0) * (0.55 + 0.95 * uHover);
    float diffuse = (0.52 + 0.48 * max(dot(facetNormal, lightDir), 0.0)) *
      (1.0 + facetJitter * 0.16);
    float fresnel = pow(1.0 - z, 4.0);

    vec3 rim = mix(
      mix(uAccentA, uAccentB, uHover),
      uAccentC,
      smoothstep(0.62, 1.0, r) * 0.42
    );
    vec3 body = interior * diffuse * (0.74 + 0.26 * z);
    vec3 lit = body +
      rim * fresnel * (0.72 + 0.55 * uHover) +
      vec3(0.92, 0.96, 1.0) * specular +
      rim * crease;
    float alpha = cover;
    finalColor = vec4(lit * alpha, alpha) * vColor;
  }
`;
