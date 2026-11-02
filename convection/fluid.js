/*
  GPU fluid solver for the convection sketch (WebGL2).

  Same model and the same sequence of operations as the original CPU version
  (see git history for sketch.js before the port), but every grid loop is now
  a fragment-shader pass. Each field lives in a float texture, one texel per
  grid cell, and passes ping-pong between a "read" and a "write" texture.
  Textures only have the channels they need (velocity: 2, scalars: 1), which
  matters because most passes are limited by memory traffic, not math.

  Two grids: velocity and pressure live on the simulation grid (nx x ny).
  Temperature lives on a grid temperatureScale times finer, because it is
  what you see: thin plumes stay sharp, while the expensive pressure solve
  stays on the coarser grid. Advection samples the velocity smoothly at the
  finer cells, and buoyancy uses the average temperature of each velocity
  cell.

  Grid conventions:
  - Cell (i, j) is texel (i, j). j = 0 is the BOTTOM row (GL is y-up), so
    buoyancy accelerates fluid toward +y.
  - Cells are square. The domain is 1 unit tall, so h = 1 / ny and the
    physics does not depend on the grid resolution.
  - Velocity is stored in .xy, scalars (temperature, pressure, divergence)
    in .x.
*/

const FLUID_DEFAULTS = {
  // How the pressure equation is solved each projection.
  // 'multigrid': also solves on coarser and coarser copies of the grid, so
  //   pressure can reach across the whole domain in a few passes. This is
  //   what lets big circulating rolls form.
  // 'jacobi': the original scheme. Each pass only spreads pressure one cell,
  //   so with a limited number of passes the flow stays in rigid columns.
  pressureSolver: 'multigrid',
  multigridCycles: 2,     // V-cycles per projection
  // Jacobi passes on the smallest (9x6) grid. That grid carries the single
  // domain-wide pressure mode, which sets how much fluid enters or leaves
  // through the open edges overall. It converges slowly, and with only 8
  // passes the error built up over hundreds of steps (edge divergence 3x,
  // cold fluid flooding the domain), so this stays at 40.
  coarsestIterations: 40,
  pressureIterations: 40, // Jacobi passes per projection (jacobi solver only)
  // Sweeps of the implicit viscosity and thermal diffusion solves (each sweep
  // is two passes: red cells, then black cells): at least diffusionIterations,
  // more when the diffusion is strong. Broad shapes need about
  // 5 * sqrt(alpha) sweeps (alpha = diffusivity * dt / h^2) to spread at the
  // correct rate; with a fixed 8, the strongest thermal diffusion setting
  // spread heat only 61% as fast as it should.
  diffusionIterations: 8,
  sweepsPerSqrtAlpha: 5,
  // Upper limit on sweeps, so extreme settings can't freeze the frame rate.
  // When a solve needs more, it is only partly solved and
  // diffusionAccuracy() reports it.
  maxSweepsVelocity: 48,
  maxSweepsTemperature: 32,
  // Temperature grid cells per velocity grid cell, in each direction (1-4).
  temperatureScale: 2,
  // 'maccormack' keeps plumes and swirls sharp; 'semi-lagrangian' is the
  // simpler, blurrier scheme the CPU original used.
  advection: 'maccormack',
  // Each plate's temperature excess flickers by up to this fraction, varying
  // along the plate. Real surfaces are never
  // perfectly uniform, and these small differences are what break the
  // boundary layers into separate plumes.
  plateFluctuation: 0.03,
  // Flow tracers: particles carried by the velocity field, drawn as streaks
  // that fade over tracerTrailTime (in simulation time units).
  tracerCount: 128 * 16,
  tracerTrailTime: 0.5,
  tracerIntensity: 0.3, // brightness each step adds to a streak
  // Mouse brush: how fast fluid under the brush center takes on the brush's
  // temperature (per simulation time unit).
  brushRate: 6,
  ambientT: 0.0,
  // Domain edges.
  // 'open': all four edges are open to ambient surroundings, the same way:
  //   fluid may flow in or out anywhere, inflowing fluid is at ambient
  //   temperature, outflowing fluid keeps its temperature, and pressure is
  //   zero at the edges. Top and bottom are treated alike.
  // 'original': the CPU sketch's edges: a floor held at ambient temperature,
  //   a top that only lets fluid out, and sides held at ambient.
  boundaries: 'open',
  // Open edges only. Fluid drawn in through an edge comes from still
  // surroundings, so it arrives at a pressure lowered by the energy it took to
  // get moving (Bernoulli: p = -1/2 rho u_n^2). That costs every inflow a
  // drag growing with its speed. Without it, inflow arrives already moving and
  // pays nothing, so the open sides turn into a frictionless chimney: a draft
  // of ambient-temperature fluid builds up beside the plates (measured at 3x
  // the speed between the plates) and never slows down.
  bernoulliInflow: true,
};

const VERTEX_SHADER = `#version 300 es
// One oversized triangle that covers the whole viewport; no vertex buffers.
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uSize; // grid size in cells
out vec4 outColor;

ivec2 gridSize() { return ivec2(uSize); }
ivec2 cell() { return ivec2(gl_FragCoord.xy); }

bool onEdge(ivec2 c) {
  ivec2 n = gridSize();
  return c.x == 0 || c.y == 0 || c.x == n.x - 1 || c.y == n.y - 1;
}

vec4 fetch(sampler2D t, ivec2 c) { return texelFetch(t, c, 0); }

// rect = (x0, x1, y0, y1) in cells. A cell (spanning [i, i+1) x [j, j+1))
// counts as inside only if it lies entirely within the rect. On the full
// grids the plate edges are whole numbers, so this is just x0 <= i < x1. On
// coarse multigrid levels the scaled edges fall mid-cell: a partly covered
// coarse cell stays fluid, so no fluid is ever hidden under a coarse plate,
// and the rule treats both ends alike, so it keeps the setup mirror
// symmetric. (An earlier center-based, end-exclusive test made the coarse
// hot plate thinner than the cold one and tilted the whole flow cold.)
bool inRect(ivec2 c, vec4 rect) {
  vec2 lo = vec2(c);
  vec2 hi = lo + 1.0;
  return lo.x >= rect.x && hi.x <= rect.y && lo.y >= rect.z && hi.y <= rect.w;
}

// The two plates are the only solid cells inside the domain.
uniform vec4 uHotPlate;
uniform vec4 uColdPlate;
bool isSolid(ivec2 c) { return inRect(c, uHotPlate) || inRect(c, uColdPlate); }

uniform float uOpenEdges;  // 1: all edges open (see FLUID_DEFAULTS.boundaries)
uniform float uFreeStream; // > 0: the left edge is a fixed inlet
bool openEdges() { return uOpenEdges > 0.5; }
bool forcedInlet() { return uFreeStream > 1e-8; }

// For an edge cell: the neighboring interior cell, and the inward direction.
ivec2 interiorNeighbor(ivec2 c) {
  ivec2 n = gridSize();
  return ivec2(clamp(c.x, 1, n.x - 2), clamp(c.y, 1, n.y - 2));
}

// Bilinear interpolation; p is in cell units with cell centers at integers.
vec4 sampleBilinear(sampler2D t, vec2 p, vec2 lo, vec2 hi) {
  p = clamp(p, lo, hi);
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - vec2(i0);
  vec4 a = mix(fetch(t, i0), fetch(t, i0 + ivec2(1, 0)), f.x);
  vec4 b = mix(fetch(t, i0 + ivec2(0, 1)), fetch(t, i0 + ivec2(1, 1)), f.x);
  return mix(a, b, f.y);
}
`;

const SHADERS = {
  copy: `
uniform sampler2D uSrc;
void main() { outColor = fetch(uSrc, cell()); }`,

  // Boussinesq approximation for thermal buoyancy
  buoyancy: `
uniform sampler2D uVel;
uniform sampler2D uTemp;
uniform float uTempScale; // temperature cells per velocity cell
uniform float uStrength;
uniform float uDt;
uniform float uAmbient;

// Average temperature of the finer temperature cells inside velocity cell c.
float temperatureAt(ivec2 c) {
  int s = int(uTempScale);
  float sum = 0.0;
  for (int dy = 0; dy < 4; dy++) {
    if (dy >= s) break;
    for (int dx = 0; dx < 4; dx++) {
      if (dx >= s) break;
      sum += fetch(uTemp, c * s + ivec2(dx, dy)).x;
    }
  }
  return sum / float(s * s);
}

void main() {
  ivec2 c = cell();
  vec4 v = fetch(uVel, c);
  if (!onEdge(c) && !isSolid(c)) {
    v.y += uStrength * (temperatureAt(c) - uAmbient) * uDt;
  }
  outColor = v;
}`,

  // Half a sweep of implicit diffusion, (1 - alpha * laplacian) x = b, by
  // red-black Gauss-Seidel with over-relaxation (SOR). Cells are colored
  // like a checkerboard; this pass updates one color, whose four neighbors
  // all have the other color and so are already up to date. Each update
  // overshoots the plain average by uOmega, which converges much faster
  // than Jacobi when heat spreads several cells per step.
  // Plate cells are not updated: they keep their fixed temperature (or zero
  // velocity), so neighboring fluid sees them as fixed walls.
  diffuse: `
uniform sampler2D uX;
uniform sampler2D uB;
uniform float uAlpha; // diffusivity * dt / h^2
uniform float uColor; // 0 or 1: which checkerboard color to update
uniform float uOmega; // over-relaxation, between 1 and 2
void main() {
  ivec2 c = cell();
  vec4 x = fetch(uX, c);
  if (!onEdge(c) && !isSolid(c) && (c.x + c.y) % 2 == int(uColor)) {
    vec4 sum = fetch(uX, c + ivec2(-1, 0)) + fetch(uX, c + ivec2(1, 0)) +
               fetch(uX, c + ivec2(0, -1)) + fetch(uX, c + ivec2(0, 1));
    vec4 gaussSeidel = (fetch(uB, c) + uAlpha * sum) / (1.0 + 4.0 * uAlpha);
    x = mix(x, gaussSeidel, uOmega);
  }
  outColor = x;
}`,

  // Semi-Lagrangian advection with bilinear interpolation: each cell looks
  // back along the flow and takes the value it finds there.
  advect: `
uniform sampler2D uVel;
uniform sampler2D uSrc;
uniform float uDt;
uniform float uInvH;     // 1 / cell size of the field being moved
uniform vec2 uVelSize;   // velocity grid size
uniform float uVelScale; // velocity cells per field cell (1, or 0.5 for 2x temperature)

vec2 velocityAt(ivec2 c) {
  vec2 p = (vec2(c) + 0.5) * uVelScale - 0.5;
  return sampleBilinear(uVel, p, vec2(0.0), uVelSize - 1.001).xy;
}

void main() {
  ivec2 c = cell();
  vec4 s = fetch(uSrc, c);
  if (!onEdge(c)) {
    vec2 from = vec2(c) - uDt * uInvH * velocityAt(c);
    s = sampleBilinear(uSrc, from, vec2(0.5), uSize - 1.5);
  }
  outColor = s;
}`,

  // MacCormack correction. Semi-Lagrangian advection blurs a little every
  // step. MacCormack measures that blur by advecting the result backwards
  // (uBack should match the original uSrc) and adds half the error back.
  // The result is clamped to the values it was interpolated from, so the
  // correction can never create new hot or cold extremes.
  maccormack: `
uniform sampler2D uVel;
uniform sampler2D uSrc;
uniform sampler2D uForward; // semi-Lagrangian result
uniform sampler2D uBack;    // uForward advected back by -dt
uniform float uDt;
uniform float uInvH;
uniform vec2 uVelSize;
uniform float uVelScale;

vec2 velocityAt(ivec2 c) {
  vec2 p = (vec2(c) + 0.5) * uVelScale - 0.5;
  return sampleBilinear(uVel, p, vec2(0.0), uVelSize - 1.001).xy;
}

void main() {
  ivec2 c = cell();
  vec4 forward = fetch(uForward, c);
  if (onEdge(c)) {
    outColor = forward;
    return;
  }
  vec4 corrected = forward + 0.5 * (fetch(uSrc, c) - fetch(uBack, c));

  vec2 from = clamp(vec2(c) - uDt * uInvH * velocityAt(c), vec2(0.5), uSize - 1.5);
  ivec2 i0 = ivec2(floor(from));
  vec4 a = fetch(uSrc, i0);
  vec4 b = fetch(uSrc, i0 + ivec2(1, 0));
  vec4 d = fetch(uSrc, i0 + ivec2(0, 1));
  vec4 e = fetch(uSrc, i0 + ivec2(1, 1));
  outColor = clamp(corrected, min(min(a, b), min(d, e)), max(max(a, b), max(d, e)));
}`,

  // Mouse brush: eases a soft round patch of the temperature toward a target
  // (the hot or cold plate temperature). Easing instead of adding means
  // dragging over the same spot can never overshoot.
  brush: `
uniform sampler2D uSrc;
uniform vec2 uCenter;  // in this grid's cells
uniform float uRadius; // in this grid's cells
uniform vec4 uTarget;
uniform float uAmount; // 0..1: how far to move toward uTarget at the center
void main() {
  ivec2 c = cell();
  vec4 s = fetch(uSrc, c);
  if (!onEdge(c) && !isSolid(c)) {
    vec2 d = vec2(c) - uCenter;
    float weight = exp(-dot(d, d) / (uRadius * uRadius));
    s = mix(s, uTarget, weight * uAmount);
  }
  outColor = s;
}`,

  // Finite-difference velocity divergence, pre-scaled for the pressure solve.
  // Solid plate cells have zero velocity and are left out of the solve.
  divergence: `
uniform sampler2D uVel;
uniform float uH;
vec2 vel(ivec2 c) { return isSolid(c) ? vec2(0.0) : fetch(uVel, c).xy; }
void main() {
  ivec2 c = cell();
  float d = 0.0;
  if (!onEdge(c) && !isSolid(c)) {
    d = -0.5 * uH * (
      vel(c + ivec2(1, 0)).x - vel(c + ivec2(-1, 0)).x +
      vel(c + ivec2(0, 1)).y - vel(c + ivec2(0, -1)).y
    );
  }
  outColor = vec4(d, 0.0, 0.0, 1.0);
}`,

  // ---- Pressure solve ----
  // Unknown p, right-hand side b (the pre-scaled divergence on the full grid).
  // For each fluid cell: count * p - (sum of fluid-neighbor p) = b, where
  // count is the number of fluid neighbors. With open edges pressure is zero
  // on all edges (except a free-stream inlet: zero gradient); with the
  // original edges it is zero at the top and has zero gradient elsewhere. It
  // always has zero gradient across plate faces (solid neighbors are left out
  // of the sum), so nothing pushes fluid into a plate.
  // The same shaders run on every multigrid level; on coarser levels p is a
  // correction and b is the leftover error (residual) from the level above.

  // One (weighted) Jacobi pass: move p toward the value its neighbors imply.
  pressureSmooth: `
uniform sampler2D uP;
uniform sampler2D uRhs;
uniform float uWeight; // 1 = plain Jacobi; 0.8 damps it, which multigrid prefers

// Adds a neighbor's pressure to the sum. Solid neighbors are skipped: they act
// as a mirror of this cell (zero gradient across the plate face).
void addNeighbor(ivec2 n, inout float sum, inout float count) {
  if (!isSolid(n)) {
    sum += fetch(uP, n).x;
    count += 1.0;
  }
}

void main() {
  ivec2 c = cell();
  ivec2 n = gridSize();
  float p;
  if (openEdges() && onEdge(c)) {
    // Open edges keep the pressure set by pressureInlet before the solve
    // (zero on coarse levels, where p is a correction). A fixed inlet has its
    // velocity given instead (zero pressure gradient).
    p = (forcedInlet() && c.x == 0) ? fetch(uP, ivec2(1, c.y)).x : fetch(uP, c).x;
  } else if (c.y == n.y - 1) {
    p = 0.0;
  } else if (c.y == 0) {
    p = fetch(uP, ivec2(clamp(c.x, 1, n.x - 2), 1)).x;
  } else if (c.x == 0) {
    p = fetch(uP, ivec2(1, c.y)).x;
  } else if (c.x == n.x - 1) {
    p = fetch(uP, ivec2(n.x - 2, c.y)).x;
  } else if (isSolid(c)) {
    p = 0.0; // never read: fluid cells mirror themselves across plate faces
  } else {
    float sum = 0.0;
    float count = 0.0;
    addNeighbor(c + ivec2(-1, 0), sum, count);
    addNeighbor(c + ivec2(1, 0), sum, count);
    addNeighbor(c + ivec2(0, -1), sum, count);
    addNeighbor(c + ivec2(0, 1), sum, count);
    float jacobi = (fetch(uRhs, c).x + sum) / count;
    p = mix(fetch(uP, c).x, jacobi, uWeight);
  }
  outColor = vec4(p, 0.0, 0.0, 1.0);
}`,

  // How far each fluid cell is from satisfying its equation.
  pressureResidual: `
uniform sampler2D uP;
uniform sampler2D uRhs;
void main() {
  ivec2 c = cell();
  float r = 0.0;
  if (!onEdge(c) && !isSolid(c)) {
    float p = fetch(uP, c).x;
    float sum = 0.0;
    float count = 0.0;
    for (int k = 0; k < 4; k++) {
      ivec2 nb = c + ivec2(k == 0 ? -1 : k == 1 ? 1 : 0, k == 2 ? -1 : k == 3 ? 1 : 0);
      if (!isSolid(nb)) {
        sum += fetch(uP, nb).x;
        count += 1.0;
      }
    }
    r = fetch(uRhs, c).x - (count * p - sum);
  }
  outColor = vec4(r, 0.0, 0.0, 1.0);
}`,

  // Fine residual -> coarse right-hand side. Each coarse cell covers 2x2 fine
  // cells. Summing them (4x the average) accounts for the coarse cells being
  // twice as wide, since the equation is scaled by cell size squared.
  // Coarse edge cells are boundary cells, but they cover a strip of real
  // fine cells, so that strip's residual is folded into the neighboring
  // coarse interior cell instead of being lost.
  restrict: `
uniform sampler2D uFine;

float block(ivec2 k) {
  ivec2 f = 2 * k;
  return fetch(uFine, f).x + fetch(uFine, f + ivec2(1, 0)).x +
         fetch(uFine, f + ivec2(0, 1)).x + fetch(uFine, f + ivec2(1, 1)).x;
}

void main() {
  ivec2 c = cell();
  ivec2 n = gridSize();
  float r = 0.0;
  if (!onEdge(c)) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec2 k = c + ivec2(dx, dy);
        bool xOk = dx == 0 || k.x == 0 || k.x == n.x - 1;
        bool yOk = dy == 0 || k.y == 0 || k.y == n.y - 1;
        if (xOk && yOk) r += block(k);
      }
    }
  }
  outColor = vec4(r, 0.0, 0.0, 1.0);
}`,

  // Coarse correction -> fine grid: add the bilinearly interpolated
  // correction. Only fluid coarse cells are interpolated from; solid plate
  // cells hold no meaningful pressure and would drag the result toward zero.
  prolong: `
uniform sampler2D uP;
uniform sampler2D uCoarse;
uniform vec2 uCoarseSize;
uniform vec4 uCoarseHotPlate;
uniform vec4 uCoarseColdPlate;

void addCoarse(ivec2 k, float w, inout float sum, inout float weight) {
  if (!inRect(k, uCoarseHotPlate) && !inRect(k, uCoarseColdPlate)) {
    sum += w * fetch(uCoarse, k).x;
    weight += w;
  }
}

void main() {
  ivec2 c = cell();
  vec2 pos = clamp((vec2(c) + 0.5) * 0.5 - 0.5, vec2(0.0), uCoarseSize - 1.001);
  ivec2 k = ivec2(floor(pos));
  vec2 f = pos - vec2(k);
  float sum = 0.0;
  float weight = 0.0;
  addCoarse(k, (1.0 - f.x) * (1.0 - f.y), sum, weight);
  addCoarse(k + ivec2(1, 0), f.x * (1.0 - f.y), sum, weight);
  addCoarse(k + ivec2(0, 1), (1.0 - f.x) * f.y, sum, weight);
  addCoarse(k + ivec2(1, 1), f.x * f.y, sum, weight);
  float e = weight > 0.0 ? sum / weight : 0.0;
  // Open-edge pressures are fixed values, not unknowns: leave them alone.
  if (openEdges() && onEdge(c) && !(forcedInlet() && c.x == 0)) e = 0.0;
  outColor = vec4(fetch(uP, c).x + e, 0.0, 0.0, 1.0);
}`,

  // Pressure on the open edges before the solve (zero inside). Where fluid
  // flows in, it was drawn from still surroundings at ambient pressure, so
  // its pressure is lower by the kinetic energy of its inward motion:
  // p = -1/2 u_n^2. The solver's p is pressure * dt / density (the gradient
  // pass subtracts grad p from the velocity), hence the factor uDt.
  pressureInlet: `
uniform sampler2D uVel;
uniform float uDt;
void main() {
  ivec2 c = cell();
  float p = 0.0;
  if (openEdges() && onEdge(c) && !(forcedInlet() && c.x == 0)) {
    ivec2 inside = interiorNeighbor(c);
    vec2 inward = normalize(vec2(inside - c));
    float un = max(dot(fetch(uVel, inside).xy, inward), 0.0);
    p = -0.5 * un * un * uDt;
  }
  outColor = vec4(p, 0.0, 0.0, 1.0);
}`,

  // Finite-difference pressure gradient correction. Across a plate face the
  // pressure is mirrored, so the plate exerts no push along its normal.
  gradient: `
uniform sampler2D uVel;
uniform sampler2D uP;
uniform float uInvH;
void main() {
  ivec2 c = cell();
  vec4 v = fetch(uVel, c);
  if (!onEdge(c) && !isSolid(c)) {
    float here = fetch(uP, c).x;
    float right = isSolid(c + ivec2(1, 0)) ? here : fetch(uP, c + ivec2(1, 0)).x;
    float left = isSolid(c + ivec2(-1, 0)) ? here : fetch(uP, c + ivec2(-1, 0)).x;
    float up = isSolid(c + ivec2(0, 1)) ? here : fetch(uP, c + ivec2(0, 1)).x;
    float down = isSolid(c + ivec2(0, -1)) ? here : fetch(uP, c + ivec2(0, -1)).x;
    v.x -= 0.5 * uInvH * (right - left);
    v.y -= 0.5 * uInvH * (up - down);
  }
  outColor = v;
}`,

  // Velocity boundary conditions for natural and forced convection
  velocityBoundary: `
uniform sampler2D uVel;
void main() {
  ivec2 c = cell();
  ivec2 n = gridSize();
  vec2 v = fetch(uVel, c).xy;
  bool forced = forcedInlet();

  if (openEdges() && onEdge(c)) {
    // Open edge: the flow passes through unchanged (zero gradient), in or
    // out. With a free stream, the left edge is the fixed inlet instead.
    v = (forced && c.x == 0) ? vec2(uFreeStream, 0.0) : fetch(uVel, interiorNeighbor(c)).xy;
  } else if (c.y == 0) {
    // Bottom boundary is a stationary wall.
    v = vec2(0.0);
  } else if (c.y == n.y - 1) {
    // Open top: zero normal gradient, and fluid may only leave (no downflow).
    if (forced && c.x == 0) {
      v = vec2(uFreeStream, 0.0);
    } else {
      vec2 below = fetch(uVel, ivec2(clamp(c.x, 1, n.x - 2), n.y - 2)).xy;
      v = vec2(below.x, max(below.y, 0.0));
    }
  } else if (c.x == 0) {
    // Forced: uniform inlet. Natural: open, zero-gradient side.
    v = forced ? vec2(uFreeStream, 0.0) : fetch(uVel, ivec2(1, c.y)).xy;
  } else if (c.x == n.x - 1) {
    // Outflow / open side: copy the last interior state.
    v = fetch(uVel, ivec2(n.x - 2, c.y)).xy;
  }

  // Both isothermal plates are stationary no-slip solids.
  if (isSolid(c)) {
    v = vec2(0.0);
  }
  outColor = vec4(v, 0.0, 1.0);
}`,

  // Thermal boundary conditions
  temperatureBoundary: `
uniform sampler2D uTemp;
uniform sampler2D uVel; // velocity grid, to tell inflow from outflow
uniform vec2 uVelSize;
uniform float uAmbient;
uniform float uHotT;
uniform float uColdT;
uniform float uFluctuation; // 0 = perfectly uniform plates
uniform float uSeed;        // changes every step
uniform float uRes;         // grid cells per original-sketch cell

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Smooth random value in [-1, 1] along the plate, new every step. It varies
// over about one original-sketch cell, so it looks the same at any ?res.
float plateNoise(float x, float plateId) {
  float u = x / uRes;
  float k = floor(u);
  float a = hash(vec2(k, uSeed + plateId * 7.31));
  float b = hash(vec2(k + 1.0, uSeed + plateId * 7.31));
  return 2.0 * mix(a, b, smoothstep(0.0, 1.0, u - k)) - 1.0;
}

void main() {
  ivec2 c = cell();
  ivec2 n = gridSize();
  float t = fetch(uTemp, c).x;
  bool forced = forcedInlet();

  if (openEdges() && onEdge(c)) {
    // Open edge: fluid flowing in arrives at ambient temperature; fluid
    // flowing out keeps its own (zero gradient).
    ivec2 inside = interiorNeighbor(c);
    vec2 inward = vec2(inside - c); // points into the domain
    vec2 velPos = (vec2(inside) + 0.5) * (uVelSize / uSize) - 0.5;
    vec2 v = sampleBilinear(uVel, velPos, vec2(0.0), uVelSize - 1.001).xy;
    t = dot(v, inward) > 0.0 ? uAmbient : fetch(uTemp, inside).x;
  } else if (c.y == 0) {
    // Unheated lower wall is held at ambient temperature.
    t = uAmbient;
  } else if (c.x == 0) {
    // Ambient far field (natural) or fresh ambient inflow (forced).
    t = uAmbient;
  } else if (c.x == n.x - 1) {
    // Forced: temperature leaves downstream unimposed. Natural: ambient.
    t = forced ? fetch(uTemp, ivec2(n.x - 2, min(c.y, n.y - 2))).x : uAmbient;
  } else if (c.y == n.y - 1) {
    // Open top with zero normal temperature gradient.
    t = fetch(uTemp, ivec2(c.x, n.y - 2)).x;
  }

  // Constant-temperature hot and cold plates, with optional small fluctuations.
  if (inRect(c, uHotPlate)) {
    t = uAmbient + (uHotT - uAmbient) * (1.0 + uFluctuation * plateNoise(float(c.x), 0.0));
  }
  if (inRect(c, uColdPlate)) {
    t = uAmbient + (uColdT - uAmbient) * (1.0 + uFluctuation * plateNoise(float(c.x), 1.0));
  }
  outColor = vec4(t, 0.0, 0.0, 1.0);
}`,


  // Temperature color map, drawn to the visible canvas
  display: `
uniform sampler2D uTemp;
uniform vec2 uTempSize;
uniform sampler2D uTrail;     // tracer streaks (filtered, canvas-sized)
uniform float uShowTracers;   // 0 or 1
uniform vec2 uCanvas;
uniform float uAmbient;
uniform float uHotT;
uniform float uColdT;

// Color map: five user-chosen colors (0-255 RGB). The cold half runs
// max cold -> cold -> middle, the hot half middle -> hot -> max hot, with
// cold and hot halfway along their halves.
uniform vec3 uMaxColdColor;
uniform vec3 uColdColor;
uniform vec3 uMiddleColor;
uniform vec3 uHotColor;
uniform vec3 uMaxHotColor;

vec3 thermal(float t) {
  vec3 c;
  if (t <= uAmbient) {
    float q = clamp((t - uColdT) / max(1e-6, uAmbient - uColdT), 0.0, 1.0);
    c = q < 0.5 ? mix(uMaxColdColor, uColdColor, q * 2.0)
                : mix(uColdColor, uMiddleColor, (q - 0.5) * 2.0);
  } else {
    float q = clamp((t - uAmbient) / max(1e-6, uHotT - uAmbient), 0.0, 1.0);
    c = q < 0.5 ? mix(uMiddleColor, uHotColor, q * 2.0)
                : mix(uHotColor, uMaxHotColor, (q - 0.5) * 2.0);
  }
  return c / 255.0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uCanvas;
  vec2 p = uv * uTempSize - 0.5;
  float t = sampleBilinear(uTemp, p, vec2(0.0), uTempSize - 1.001).x;
  vec3 color = thermal(clamp(t, uColdT, uHotT));


  if (uShowTracers > 0.5) {
    // Light streaks over dark fluid, dark streaks over bright fluid, so the
    // tracers stay visible without hiding the temperature colors.
    float streak = clamp(texture(uTrail, uv).x, 0.0, 1.0);
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    vec3 ink = mix(vec3(1.0), vec3(0.04, 0.05, 0.1), smoothstep(0.45, 0.7, luma));
    color = mix(color, ink, 0.8 * streak);
  }
  outColor = vec4(color, 1.0);
}`,

  // ---- Flow tracers ----

  // Moves each tracer particle (one texel per particle: x, y in cells, age,
  // lifetime) through the velocity field, and respawns it at a random spot
  // when it gets old, leaves the domain or hits a plate.
  tracerUpdate: `
uniform sampler2D uState;
uniform sampler2D uVel;
uniform vec2 uGrid;   // fluid grid size (uSize is the particle texture size)
uniform float uDt;
uniform float uInvH;
uniform float uSeed;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 velocityAt(vec2 p) {
  return sampleBilinear(uVel, p, vec2(0.0), uGrid - 1.001).xy;
}

void main() {
  ivec2 c = cell();
  vec4 s = fetch(uState, c);
  vec2 pos = s.xy;
  float age = s.z + uDt;
  float life = s.w;

  // Midpoint (RK2) step: follows curved streamlines better than one Euler step.
  vec2 mid = pos + 0.5 * uDt * uInvH * velocityAt(pos);
  pos += uDt * uInvH * velocityAt(mid);

  bool outside = any(lessThan(pos, vec2(1.0))) || any(greaterThan(pos, uGrid - 2.0));
  if (age > life || outside || isSolid(ivec2(floor(pos + 0.5)))) {
    vec2 seed = vec2(c) + uSeed;
    pos = vec2(1.0) + vec2(hash(seed), hash(seed + 17.0)) * (uGrid - 3.0);
    age = 0.0;
    life = mix(1.5, 4.0, hash(seed + 41.0));
    // With a free stream, fluid keeps entering at the left edge, so some
    // tracers are born there too (more for a faster stream).
    float inletShare = uFreeStream * 1.8 / (1.0 + uFreeStream * 1.8);
    if (hash(seed + 73.0) < inletShare) {
      pos.x = 1.0 + 2.0 * hash(seed + 91.0);
    }
  }
  outColor = vec4(pos, age, life);
}`,

  // Fades the streak layer a little every step.
  tracerFade: `
uniform sampler2D uTrail;
uniform float uFade;
void main() { outColor = fetch(uTrail, cell()) * uFade; }`,
};

// Draws every tracer as a short line from where it was one step ago to where
// it is now (two vertices per particle, no vertex buffers).
const TRACER_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform sampler2D uVel;
uniform vec2 uGrid;
uniform float uDt;
uniform float uInvH;
uniform int uStateWidth;
out float vAlpha;

vec2 velocityAt(vec2 p) {
  p = clamp(p, vec2(0.0), uGrid - 1.001);
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - vec2(i0);
  vec2 a = mix(texelFetch(uVel, i0, 0).xy, texelFetch(uVel, i0 + ivec2(1, 0), 0).xy, f.x);
  vec2 b = mix(texelFetch(uVel, i0 + ivec2(0, 1), 0).xy, texelFetch(uVel, i0 + ivec2(1, 1), 0).xy, f.x);
  return mix(a, b, f.y);
}

void main() {
  int particle = gl_VertexID / 2;
  vec4 s = texelFetch(uState, ivec2(particle % uStateWidth, particle / uStateWidth), 0);
  vec2 pos = s.xy;
  if (gl_VertexID % 2 == 1) {
    pos -= uDt * uInvH * velocityAt(pos); // tail: one step back along the flow
  }
  gl_Position = vec4((pos + 0.5) / uGrid * 2.0 - 1.0, 0.0, 1.0);
  // Fade in after spawning and out before respawning.
  vAlpha = smoothstep(0.0, 0.4, s.z) * (1.0 - smoothstep(s.w - 0.6, s.w, s.z));
}`;

const TRACER_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in float vAlpha;
uniform float uIntensity;
out vec4 outColor;
void main() { outColor = vec4(vec3(vAlpha * uIntensity), 1.0); }`;

class FluidSolver {
  constructor({ nx, ny, res, width, height, parent, options = {} }) {
    this.nx = nx;
    this.ny = ny;
    this.res = res;
    this.h = 1 / ny;
    this.config = { ...FLUID_DEFAULTS, ...options };

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.className = 'sim-canvas';
    parent.appendChild(canvas);
    this.canvas = canvas;
    this.displayWidth = width;
    this.displayHeight = height;

    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
    if (!gl) {
      throw new Error('WebGL2 is not available in this browser.');
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This browser/GPU cannot render to float textures (EXT_color_buffer_float).');
    }
    this.gl = gl;
    this.vao = gl.createVertexArray();

    this.programs = {};
    for (const [name, source] of Object.entries(SHADERS)) {
      this.programs[name] = this.createProgram(name, FRAGMENT_HEADER + source);
    }
    this.programs.tracerDraw = this.createProgram('tracerDraw', TRACER_FRAGMENT_SHADER, TRACER_VERTEX_SHADER);

    this.tempScale = this.config.temperatureScale;
    this.velocity = this.createField(nx, ny, 2);
    this.temperature = this.createField(nx * this.tempScale, ny * this.tempScale, 1);
    this.pressure = this.createDoubleTarget(nx, ny, { channels: 1 });
    this.divergence = this.createTarget(nx, ny, { channels: 1 });
    this.stepCount = 0;
    this.noiseSeed = 0;
    this.lastDiffusion = new Map(); // field -> { needed, used } sweeps
    this.tracers = null; // created the first time tracers are switched on

    // Multigrid levels: level 0 is the full grid, each next level is half as
    // wide and tall, down to a few cells across.
    const scalar = { channels: 1 };
    this.levels = [{ p: this.pressure, rhs: this.divergence, residual: this.createTarget(nx, ny, scalar), scale: 1 }];
    let w = nx;
    let h = ny;
    while (w % 2 === 0 && h % 2 === 0 && Math.min(w, h) / 2 >= 4) {
      w /= 2;
      h /= 2;
      this.levels.push({
        p: this.createDoubleTarget(w, h, scalar),
        rhs: this.createTarget(w, h, scalar),
        residual: this.createTarget(w, h, scalar),
        scale: nx / w,
      });
    }
  }

  // ---------- public API ----------

  // params: see boundaryUniforms
  reset(params) {
    this.clearTarget(this.velocity.read, 0);
    this.clearTarget(this.velocity.write, 0);
    this.clearTarget(this.temperature.read, this.config.ambientT);
    this.clearTarget(this.temperature.write, this.config.ambientT);
    this.clearTarget(this.pressure.read, 0);
    this.clearTarget(this.pressure.write, 0);

    this.stepCount = 0;
    // A new random pattern of plate fluctuations every run. With a fixed
    // seed every reset replayed exactly the same flow.
    this.noiseSeed = Math.floor(Math.random() * 1000);
    this.applyVelocityBoundaries(params);
    this.applyTemperatureBoundaries(params);
    if (this.tracers) this.clearTracers();
  }

  // params: { dt, viscosity, thermalDiffusion, buoyancy, freeStream, hotT,
  //           coldT, plates, showTracers }
  step(params) {
    const { dt } = params;
    this.stepCount++;

    this.applyVelocityBoundaries(params);
    this.applyTemperatureBoundaries(params);

    this.runPass('buoyancy', this.velocity, {
      uVel: this.velocity.read.texture,
      uTemp: this.temperature.read.texture,
      uTempScale: this.tempScale,
      ...this.boundaryUniforms(params),
      uStrength: params.buoyancy,
      uDt: dt,
      uAmbient: this.config.ambientT,
    });

    this.diffuse(this.velocity, params.viscosity, dt, params);
    this.applyVelocityBoundaries(params);
    this.project(params);

    this.advect(this.velocity, dt);
    this.applyVelocityBoundaries(params);
    this.project(params, dt); // the inflow drag is applied once per step, here

    this.diffuse(this.temperature, params.thermalDiffusion, dt, params);
    this.applyTemperatureBoundaries(params);
    this.advect(this.temperature, dt);

    this.applyVelocityBoundaries(params);
    this.applyTemperatureBoundaries(params);

    if (params.showTracers) this.stepTracers(params);
  }

  render(params) {
    const gl = this.gl;
    const showTracers = params.showTracers && this.tracers !== null;
    this.runPass('display', null, {
      uTemp: this.temperature.read.texture,
      uTempSize: [this.temperature.read.width, this.temperature.read.height],
      uTrail: showTracers ? this.tracers.trail.read.texture : this.temperature.read.texture,
      uShowTracers: showTracers ? 1 : 0,
      uCanvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      uAmbient: this.config.ambientT,
      uHotT: params.hotT,
      uColdT: params.coldT,
      uMaxColdColor: params.palette.maxCold,
      uColdColor: params.palette.cold,
      uMiddleColor: params.palette.middle,
      uHotColor: params.palette.hot,
      uMaxHotColor: params.palette.maxHot,
    });
  }

  // Changes the on-screen size (the simulation grid stays the same).
  resize(width, height) {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    if (width === this.displayWidth && height === this.displayHeight) return;
    this.displayWidth = width;
    this.displayHeight = height;
    // The streak layer is one texel per CSS pixel: rebuild it at the new size.
    if (this.tracers) {
      const old = this.tracers.trail;
      for (const t of [old.read, old.write]) {
        this.gl.deleteTexture(t.texture);
        this.gl.deleteFramebuffer(t.fbo);
      }
      this.tracers.trail = this.createDoubleTarget(width, height, { channels: 1, half: true, filter: 'linear' });
      this.clearTarget(this.tracers.trail.read, 0);
      this.clearTarget(this.tracers.trail.write, 0);
    }
  }

  // ---------- mouse brush ----------

  // brush: { x, y, radius } in velocity-grid cells (y up from the bottom),
  //        mode: 'heat' or 'cool'
  applyBrush(brush, params) {
    const amount = 1 - Math.exp(-params.dt * this.config.brushRate);
    // Same spot on the finer temperature grid.
    const s = this.tempScale;
    this.runPass('brush', this.temperature, {
      uSrc: this.temperature.read.texture,
      uCenter: [(brush.x + 0.5) * s - 0.5, (brush.y + 0.5) * s - 0.5],
      uRadius: brush.radius * s,
      uTarget: [brush.mode === 'heat' ? params.hotT : params.coldT, 0, 0, 0],
      uAmount: amount,
      ...this.boundaryUniforms(params, 1 / s),
    });
  }

  // ---------- flow tracers ----------

  // Moves the tracers along the current velocity, fades the old streaks a
  // little, and draws each tracer's latest step into the streak layer.
  stepTracers(params) {
    if (!this.tracers) this.createTracers();
    const gl = this.gl;
    const { state, trail, stateWidth, count } = this.tracers;
    const dt = params.dt;

    this.runPass('tracerUpdate', state, {
      uState: state.read.texture,
      uVel: this.velocity.read.texture,
      uGrid: [this.nx, this.ny],
      uDt: dt,
      uInvH: 1 / this.h,
      ...this.boundaryUniforms(params),
      // after the spread: boundaryUniforms has its own (integer) uSeed
      uSeed: (this.stepCount % 4096) * 0.618,
    });

    this.runPass('tracerFade', trail, {
      uTrail: trail.read.texture,
      uFade: Math.exp(-dt / this.config.tracerTrailTime),
    });

    // Additive line drawing straight into the faded streak layer.
    const program = this.programs.tracerDraw;
    gl.useProgram(program.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, trail.read.fbo);
    gl.viewport(0, 0, trail.read.width, trail.read.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.read.texture);
    gl.uniform1i(program.location('uState'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform1i(program.location('uVel'), 1);
    gl.uniform2f(program.location('uGrid'), this.nx, this.ny);
    gl.uniform1f(program.location('uDt'), dt);
    gl.uniform1f(program.location('uInvH'), 1 / this.h);
    gl.uniform1i(program.location('uStateWidth'), stateWidth);
    gl.uniform1f(program.location('uIntensity'), this.config.tracerIntensity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.LINES, 0, 2 * count);
    gl.disable(gl.BLEND);
  }

  createTracers() {
    const stateWidth = 128;
    const stateHeight = Math.ceil(this.config.tracerCount / stateWidth);
    this.tracers = {
      stateWidth,
      count: stateWidth * stateHeight,
      state: this.createDoubleTarget(stateWidth, stateHeight),
      // One texel per CSS pixel; filtered when it is stretched to the canvas.
      trail: this.createDoubleTarget(this.displayWidth, this.displayHeight, { channels: 1, half: true, filter: 'linear' }),
    };
    this.clearTracers();
  }

  clearTracers() {
    const { state, trail } = this.tracers;
    // A negative lifetime makes every tracer respawn on its first update.
    this.clearTarget(state.read, -1);
    this.clearTarget(state.write, -1);
    this.clearTarget(trail.read, 0);
    this.clearTarget(trail.write, 0);
  }

  // RMS of the velocity divergence (in the solver's pre-scaled units).
  // Reads back from the GPU, so call it occasionally, not every frame.
  measureDivergence(params) {
    const gl = this.gl;
    this.runPass('divergence', this.divergence, {
      uVel: this.velocity.read.texture,
      uH: this.h,
      ...this.boundaryUniforms(params),
    });
    const data = new Float32Array(this.nx * this.ny * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.divergence.fbo);
    gl.readPixels(0, 0, this.nx, this.ny, gl.RGBA, gl.FLOAT, data);
    let sum = 0;
    for (let k = 0; k < data.length; k += 4) sum += data[k] * data[k];
    // Undo the -0.5 * h pre-scaling so the value is du/dx + dv/dy.
    // d = -0.5 * h * (du + dv) and the divergence is (du + dv) / (2h), so
    // the divergence is -d / h^2.
    return Math.sqrt(sum / (this.nx * this.ny)) / (this.h * this.h);
  }


  // ---------- solver stages ----------

  // How many SOR sweeps a diffusion solve needs, and how many it gets.
  diffusionPlan(field, diffusivity, dt) {
    const alpha = diffusivity * dt / (field.h * field.h);
    const needed = Math.max(
      this.config.diffusionIterations,
      Math.ceil(this.config.sweepsPerSqrtAlpha * Math.sqrt(Math.max(alpha, 0)))
    );
    const cap = field === this.velocity ? this.config.maxSweepsVelocity : this.config.maxSweepsTemperature;
    return { needed, used: Math.min(needed, cap) };
  }

  // Whether the last viscosity and heat diffusion solves got all the sweeps
  // they needed.
  diffusionAccuracy() {
    const v = this.lastDiffusion.get(this.velocity);
    const t = this.lastDiffusion.get(this.temperature);
    return {
      viscosityCapped: !!v && v.needed > v.used,
      heatCapped: !!t && t.needed > t.used,
    };
  }

  // Root-mean-square flow speed over the domain (domain heights per time
  // unit). Reads back from the GPU, so call it occasionally.
  measureSpeed() {
    const gl = this.gl;
    const V = this.velocity.read;
    const data = new Float32Array(V.width * V.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, V.fbo);
    gl.readPixels(0, 0, V.width, V.height, gl.RGBA, gl.FLOAT, data);
    let sum = 0;
    for (let k = 0; k < data.length; k += 4) sum += data[k] * data[k] + data[k + 1] * data[k + 1];
    return Math.sqrt(sum / (V.width * V.height));
  }

  // Implicit diffusion, solved by red-black SOR
  diffuse(field, diffusivity, dt, params) {
    const alpha = diffusivity * dt / (field.h * field.h);
    if (alpha <= 0) return;
    // Optimal over-relaxation for this alpha (from the Jacobi convergence rate).
    const jacobiRate = 4 * alpha / (1 + 4 * alpha);
    const omega = 2 / (1 + Math.sqrt(1 - jacobiRate * jacobiRate));
    const source = field.scratch.source;
    this.runPass('copy', source, { uSrc: field.read.texture });
    const plan = this.diffusionPlan(field, diffusivity, dt);
    const sweeps = plan.used;
    this.lastDiffusion.set(field, plan);
    for (let i = 0; i < sweeps; i++) {
      for (const color of [0, 1]) {
        this.runPass('diffuse', field, {
          uX: field.read.texture,
          uB: source.texture,
          uAlpha: alpha,
          uColor: color,
          uOmega: omega,
          ...this.boundaryUniforms(params, field.plateScale),
        });
      }
    }
  }

  // Advection of any field by the current velocity
  advect(field, dt) {
    const common = {
      uVel: this.velocity.read.texture,
      uVelSize: [this.nx, this.ny],
      uVelScale: field.read.width === this.nx ? 1 : this.nx / field.read.width,
      uInvH: 1 / field.h,
    };
    if (this.config.advection !== 'maccormack') {
      this.runPass('advect', field, { ...common, uSrc: field.read.texture, uDt: dt });
      return;
    }
    const { forward, back } = field.scratch;
    this.runPass('advect', forward, { ...common, uSrc: field.read.texture, uDt: dt });
    this.runPass('advect', back, { ...common, uSrc: forward.texture, uDt: -dt });
    this.runPass('maccormack', field, {
      ...common,
      uSrc: field.read.texture,
      uForward: forward.texture,
      uBack: back.texture,
      uDt: dt,
    });
  }

  // Pressure projection for incompressible flow
  // inflowDt > 0 sets the Bernoulli pressure on inflowing open-edge cells
  // (see FLUID_DEFAULTS.bernoulliInflow); otherwise the edges are at zero.
  project(params, inflowDt = 0) {
    const plates = this.boundaryUniforms(params);
    this.runPass('divergence', this.divergence, { uVel: this.velocity.read.texture, uH: this.h, ...plates });

    this.runPass('pressureInlet', this.pressure, {
      uVel: this.velocity.read.texture,
      uDt: this.config.bernoulliInflow ? inflowDt : 0,
      ...plates,
    });
    if (this.config.pressureSolver === 'multigrid') {
      for (let i = 0; i < this.config.multigridCycles; i++) {
        this.vCycle(0, params);
      }
    } else {
      this.smoothPressure(this.levels[0], params, this.config.pressureIterations, 1.0);
    }

    this.runPass('gradient', this.velocity, {
      uVel: this.velocity.read.texture,
      uP: this.pressure.read.texture,
      uInvH: 1 / this.h,
      ...plates,
    });
    this.applyVelocityBoundaries(params);
  }

  // Multigrid V-cycle. Jacobi quickly fixes errors a few cells wide but is
  // very slow on errors as wide as the domain. So: smooth a little, hand the
  // leftover error to a half-size grid (where it is half as wide in cells),
  // repeat down to a tiny grid, then add the coarse corrections back up.
  vCycle(index, params) {
    const level = this.levels[index];
    const coarser = this.levels[index + 1];
    if (!coarser) {
      this.smoothPressure(level, params, this.config.coarsestIterations, 1.0); // tiny grid: just solve it
      return;
    }

    this.smoothPressure(level, params, 2, 0.8);

    const plates = this.boundaryUniforms(params, level.scale);
    this.runPass('pressureResidual', level.residual, {
      uP: level.p.read.texture,
      uRhs: level.rhs.texture,
      ...plates,
    });
    this.runPass('restrict', coarser.rhs, { uFine: level.residual.texture });
    this.clearTarget(coarser.p.read, 0);

    this.vCycle(index + 1, params);

    const coarsePlates = this.boundaryUniforms(params, coarser.scale);
    this.runPass('prolong', level.p, {
      uP: level.p.read.texture,
      uCoarse: coarser.p.read.texture,
      uCoarseSize: [coarser.rhs.width, coarser.rhs.height],
      uCoarseHotPlate: coarsePlates.uHotPlate,
      uCoarseColdPlate: coarsePlates.uColdPlate,
      uOpenEdges: coarsePlates.uOpenEdges,
      uFreeStream: coarsePlates.uFreeStream,
    });
    this.smoothPressure(level, params, 2, 0.8);
  }

  smoothPressure(level, params, iterations, weight) {
    const plates = this.boundaryUniforms(params, level.scale);
    for (let i = 0; i < iterations; i++) {
      this.runPass('pressureSmooth', level.p, {
        uP: level.p.read.texture,
        uRhs: level.rhs.texture,
        uWeight: weight,
        ...plates,
      });
    }
  }

  applyVelocityBoundaries(params) {
    this.runPass('velocityBoundary', this.velocity, {
      uVel: this.velocity.read.texture,
      ...this.boundaryUniforms(params),
    });
  }

  applyTemperatureBoundaries(params) {
    this.runPass('temperatureBoundary', this.temperature, {
      uTemp: this.temperature.read.texture,
      uVel: this.velocity.read.texture,
      uVelSize: [this.nx, this.ny],
      ...this.boundaryUniforms(params, 1 / this.tempScale),
    });
  }

  // Plate rects are given in velocity-grid cells. scale converts them to
  // another grid: > 1 for coarse multigrid levels, < 1 for the finer
  // temperature grid.
  boundaryUniforms(params, scale = 1) {
    const p = params.plates;
    const rect = (x0, x1, y0, y1) => [x0 / scale, x1 / scale, y0 / scale, y1 / scale];
    return {
      uFreeStream: params.freeStream,
      uOpenEdges: this.config.boundaries === 'open' ? 1 : 0,
      uAmbient: this.config.ambientT,
      uHotT: params.hotT,
      uColdT: params.coldT,
      uHotPlate: rect(p.i0, p.i1, p.hotJ0, p.hotJ1),
      uColdPlate: rect(p.i0, p.i1, p.coldJ0, p.coldJ1),
      uFluctuation: this.config.plateFluctuation,
      uSeed: (this.stepCount + this.noiseSeed) % 1000, // kept small so the hash stays precise
      uRes: this.res / scale, // grid cells per original-sketch cell
    };
  }

  // ---------- WebGL plumbing ----------

  createProgram(name, fragmentSource, vertexSource = VERTEX_SHADER) {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Shader "${name}" failed to compile:\n${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Shader "${name}" failed to link:\n${gl.getProgramInfoLog(program)}`);
    }

    const locations = {};
    return {
      program,
      location(uniformName) {
        if (!(uniformName in locations)) {
          locations[uniformName] = gl.getUniformLocation(program, uniformName);
        }
        return locations[uniformName];
      },
    };
  }

  // A simulated quantity: a read/write texture pair plus the scratch
  // textures that diffusion and advection need, and its cell size h.
  createField(width, height, channels) {
    const options = { channels };
    const field = this.createDoubleTarget(width, height, options);
    field.h = 1 / height; // the domain is 1 unit tall
    field.plateScale = this.ny / height; // plate rects are in velocity cells
    field.scratch = {
      source: this.createTarget(width, height, options),
      forward: this.createTarget(width, height, options),
      back: this.createTarget(width, height, options),
    };
    return field;
  }

  // options.channels: 1, 2 or 4 (default 4)
  // options.half: 16-bit floats instead of 32-bit
  // options.filter: 'linear' for smooth sampling with texture()
  createTarget(width = this.nx, height = this.ny, options = {}) {
    const gl = this.gl;
    const formats = {
      1: [gl.R32F, gl.R16F, gl.RED],
      2: [gl.RG32F, gl.RG16F, gl.RG],
      4: [gl.RGBA32F, gl.RGBA16F, gl.RGBA],
    };
    const [full, half, layout] = formats[options.channels || 4];
    const texture = gl.createTexture();
    const filter = options.filter === 'linear' ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, options.half ? half : full, width, height, 0, layout, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Float framebuffer is not supported on this GPU.');
    }
    return { texture, fbo, width, height };
  }

  // A pair of targets: passes read from .read, write to .write, then swap.
  createDoubleTarget(width = this.nx, height = this.ny, options = {}) {
    let read = this.createTarget(width, height, options);
    let write = this.createTarget(width, height, options);
    return {
      get read() { return read; },
      get write() { return write; },
      swap() { [read, write] = [write, read]; },
    };
  }

  clearTarget(target, value) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(value, value, value, value);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Runs one full-grid shader pass. destination is a double target (written,
  // then swapped), a single target, or null for the visible canvas.
  runPass(name, destination, uniforms) {
    const gl = this.gl;
    const program = this.programs[name];
    gl.useProgram(program.program);

    const isDouble = destination && 'swap' in destination;
    const target = isDouble ? destination.write : destination;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.width, target.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    // uSize is the size of the grid being written (the full grid when drawing
    // to the screen).
    let unit = 0;
    const size = target ? [target.width, target.height] : [this.nx, this.ny];
    const all = { uSize: size, ...uniforms };
    for (const [uniformName, value] of Object.entries(all)) {
      const loc = program.location(uniformName);
      if (loc === null) continue;
      if (value instanceof WebGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value);
        gl.uniform1i(loc, unit++);
      } else if (typeof value === 'number') {
        gl.uniform1f(loc, value);
      } else if (value.length === 2) {
        gl.uniform2f(loc, value[0], value[1]);
      } else if (value.length === 3) {
        gl.uniform3f(loc, value[0], value[1], value[2]);
      } else if (value.length === 4) {
        gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
      }
    }

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (isDouble) destination.swap();
  }
}
