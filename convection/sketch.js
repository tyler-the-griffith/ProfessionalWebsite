/*
  Natural and forced convection between thermal resevoirs.

  Model:
  - 2D incompressible flow on a regular grid.
  - Temperature is advected by the velocity field AND diffuses thermally.
  - Buoyancy is added with a Boussinesq approximation: warmer fluid accelerates upward.
  - Pressure projection enforces approximately divergence-free velocity field (incompressible).
  - A horizontal plate near the bottom is held hot.
  - A second horizontal plate near the top is held below ambient temperature.
  - Optional uniform ambient-temperature free stream enters from the left boundary.
  - At U∞ = 0 the side boundaries revert to the symmetric natural-convection case.

  This is a low-resolution CFD model. It captures plume formation,
  entrainment, recirculation, and thermal mixing qualitatively, but it is not a
  validated engineering solver.

  The solver runs on the GPU in fluid.js (WebGL2 fragment shaders). This file
  is the p5.js side: the frame loop, the overlay on the simulation (plates,
  labels, brush) drawn on a transparent canvas above the WebGL canvas, and the
  HTML side panel and controls. The layout fits the window: the side panel
  sits beside the simulation when there is room and below it otherwise.
*/

/*
  METHODS:
  - 2D incompressible Navier-Stokes equations
  - Boussinesq approximation for thermal buoyancy
  - Advection-diffusion equation for temperature
  - Semi-Lagrangian advection with bilinear interpolation, sharpened with a
    MacCormack error correction
  - Finite-difference spatial derivatives
  - Red-black SOR for diffusion; multigrid (Jacobi smoothing on a stack of
    coarser grids) for pressure
  - Pressure projection for incompressibility, with the plates as solids
  - Isothermal, no-slip plate boundaries
  - Open/outflow and optional free-stream inlet boundaries
  - Small plate-temperature fluctuations (always on) to break symmetry
*/

// resolution
// The original CPU sketch used a 72 x 48 grid. RES multiplies that; it can be
// overridden from the URL, e.g. index.html?res=8
const BASE_NX = 72;
const BASE_NY = 48;
const RES = constrainInt(new URLSearchParams(window.location.search).get('res'), 1, 16, 4);
const NX = BASE_NX * RES;
const NY = BASE_NY * RES;

// On-screen size of the simulation. Set by applyLayout() to fit the window,
// always 3:2 like the grid.
const SIDE_W = 190;      // side panel width when it sits beside the simulation
const WIDE_LAYOUT_MIN = 760; // narrower windows put the side panel below
let SIM_W = 864;
let SIM_H = 576;
let CELL_PX = SIM_W / NX;

// Plate bands, in original-sketch rows counted up from the bottom edge
// (end-exclusive). Hot: rows 2-4, cold: rows 43-45 of 48, so each plate is
// 2 rows from its edge and the setup is a mirror image top to bottom.
const HOT_PLATE_ROWS = [2, 5];
const COLD_PLATE_ROWS = [43, 46];

// temperature setup
const AMBIENT_T = 0.0;
let hotPlateTemperature = 1.0;
let coldPlateTemperature = -1.0;

// ---- Control ranges ----
// Each control has an accurate range, where the simulation can be trusted
// on its own, and a wider extended range for experimenting (the Range
// button). Some combinations inside the accurate ranges can still leave the
// accurate region (for example very strong viscosity at low Ra); the status
// line under the flow numbers says so when that happens. Log sliders span
// orders of magnitude.
const RANGES = {
  buoyancy:   { label: 'Buoyancy',          accurate: [0.05, 5],     extended: [0.005, 50],  log: true },
  viscosity:  { label: 'Viscosity',         accurate: [1e-6, 0.03],  extended: [1e-7, 0.3],  log: true },
  heat:       { label: 'Thermal diffusion', accurate: [1e-6, 0.006], extended: [1e-7, 0.05], log: true },
  rayleigh:   { label: 'Rayleigh number',   accurate: [1e2, 3e7],    extended: [10, 1e10],   log: true },
  prandtl:    { label: 'Prandtl number',    accurate: [0.01, 1000],  extended: [0.001, 1e5], log: true },
  plateWidth: { label: 'Plate width',       accurate: [0.1, 0.9],    extended: [0.03, 0.97], step: 0.01 },
  freeStream: { label: 'Free stream',       accurate: [0, 1.5],      extended: [0, 5],       step: 0.01 },
  speed:      { label: 'Simulation speed',  accurate: [0.25, 2],     extended: [0.05, 5],    step: 0.05 },
  // each plate's difference from ambient (hot is +, cold is -)
  plateT:     { label: 'Plate temperature', accurate: [0.05, 1.5],   extended: [0.01, 5] },
};
// Every control's default (All defaults button).
const DEFAULTS = {
  buoyancy: 1.7,
  viscosity: 0.00035,
  heat: 0.0003,
  plateWidth: 0.52,
  freeStream: 0,
  speed: 0.25, // slow combinations below set their own, faster speed
  hotT: 1,
  coldT: -1,
};

// Known interesting combinations for the Surprise me button. Each sets Ra
// and Pr (and anything else listed); the rest go to their defaults. To add
// one, use Copy settings on the page and paste the text here with a name
// and a one-line description.
const PRESETS = [
  { name: 'Turbulent air', about: 'air with strong heating: busy plumes and one big roll',
    ra: 1.6e7, pr: 0.71 },
  { name: 'Water plumes', about: 'water: sharper, slower plumes that curl into mushroom caps',
    ra: 3e6, pr: 7 },
  { name: 'Steady rolls', about: 'just past the point where convection starts: slow, orderly rolls',
    ra: 2e4, pr: 0.71, speed: 1.5 },
  { name: 'Liquid metal', about: 'heat spreads much faster than motion: soft temperature, quick swirls',
    ra: 5e6, pr: 0.025 },
  { name: 'Olive oil', about: 'a thick fluid: slow, thin fingers of hot and cold',
    ra: 2e7, pr: 1000, speed: 0.85 },
  { name: 'Crosswind', about: 'a breeze from the left bends the plumes into wakes',
    ra: 1.6e7, pr: 0.71, freeStream: 0.5 },
  { name: 'Strong wind', about: 'the wind nearly wins: long, streaming wakes',
    ra: 1.6e7, pr: 0.71, freeStream: 1.2 },
  { name: 'Narrow plates', about: 'small plates: single plumes rising and falling',
    ra: 1e7, pr: 7, plateWidth: 0.2 },
  { name: 'Wide plates', about: 'plates nearly as wide as the room: many plumes side by side',
    ra: 1e7, pr: 7, plateWidth: 0.85 },
  { name: 'Hot floor, mild ceiling', about: 'a much hotter bottom plate: warm fluid takes over',
    ra: 1e7, pr: 0.71, hotT: 1.5, coldT: -0.3 },
  // Added from the page (Copy settings). Its viscosity is more than one step
  // fully solves, so the status chip shows it as outside the reasonable
  // range; the look depends on that.
  { name: 'Seemingly balanced?', about: 'a syrupy, oil-like fluid (Pr ≈ 700) where rising and sinking look evenly matched',
    ra: 280000, pr: 704, buoyancy: 0.361, hotT: 1, coldT: -1, plateWidth: 0.52, freeStream: 0, speed: 2 },
  // Added from the page. Viscosity and heat diffusion are both at the top of
  // their sliders and more than one step fully solves.
  { name: 'Diagonal divide', about: 'barely past the point where convection starts (Ra ≈ 2,000): warm and cold settle on either side of a slanted boundary',
    ra: 1990, pr: 5, buoyancy: 0.361, hotT: 1, coldT: -1, plateWidth: 0.52, freeStream: 0, speed: 2 },
];
let lastPreset = null;

// Above this the thin hot and cold layers on the plates (about
// gap * Ra^(-1/3) thick) get thinner than one temperature cell.
const RA_RESOLVED = 3e7;

// Substances by Prandtl number, at room temperature unless noted. Values
// vary with temperature, honey's especially.
const SUBSTANCES = [
  { name: 'liquid sodium', pr: 0.005 },
  { name: 'mercury', pr: 0.025 },
  { name: 'air', pr: 0.71 },
  { name: 'water', pr: 7 },
  { name: 'olive oil', pr: 1000 },
  { name: 'glycerin', pr: 12000 },
  { name: 'honey', pr: 30000 },
];

let extendedRange = false; // Range button
let dimensionless = false; // Dimensionless button
let prSnap = false;        // Pr slider snaps to substances (button)
let measuredSpeed = null;  // RMS flow speed, read back from the GPU

// other globals
let solver = null;
let app;
let stage;
let divergenceRms = null;

// ui
// Controls (see addControl): each has value(), and value(v) to set it.
let buoyancySlider;
let viscositySlider;
let thermalDiffSlider;
let rayleighSlider;
let prandtlSlider;
let plateWidthSlider;
let freeStreamSlider;
let speedSlider;
let ui = {}; // other elements the controls update
let pauseButton;
let resetButton;
let tracersButton;
let labelsButton;
let mouseToolButton;
let statusText;
let side = {}; // side panel elements that change while running

// initial values
let paused = false;
let tracersEnabled = false;
let labelsEnabled = true;

// Color map: five colors, editable with the swatches under the color bar.
// Remembered in this browser between visits.
const DEFAULT_PALETTE = {
  maxCold: [220, 245, 255],
  cold: [40, 120, 205],
  middle: [8, 12, 28],
  hot: [25, 145, 145],
  maxHot: [235, 205, 90],
};
const PALETTE_STOPS = ['maxCold', 'cold', 'middle', 'hot', 'maxHot'];
const PALETTE_LABELS = {
  maxCold: 'Max cold', cold: 'Cold', middle: 'Middle (ambient)', hot: 'Hot', maxHot: 'Max hot',
};
let palette = loadPalette();
let paletteSwatches = {};

// Mouse brush
const MOUSE_TOOLS = ['heat', 'cool'];
const BRUSH_RADIUS = 0.045; // in domain heights
let mouseTool = 'heat';
let brushActive = false;
let pointerOverFluid = false; // p5 starts the mouse at (0, 0), so track it
let simTime = 0;

function setup() {
  app = createDiv('');
  app.addClass('app');

  // Report bar across the top of the page; the whole bar is the link
  const reportBar = createA('report.html', '');
  reportBar.addClass('report-bar');
  reportBar.parent(app);
  createSpan('See report').addClass('report-heading').parent(reportBar);
  createSpan('How it works: physics, code, checks →').addClass('report-link').parent(reportBar);

  const top = createDiv('');
  top.addClass('top');
  top.parent(app);

  stage = createDiv('');
  stage.addClass('stage');
  stage.parent(top);

  try {
    solver = new FluidSolver({
      nx: NX,
      ny: NY,
      res: RES,
      width: SIM_W,
      height: SIM_H,
      parent: stage.elt,
    });
  } catch (error) {
    console.error(error);
    const message = createDiv('Could not start the GPU simulation: ' + error.message);
    message.addClass('error');
    message.parent(stage);
  }

  createCanvas(SIM_W, SIM_H);
  const p5Canvas = drawingContext.canvas;
  p5Canvas.classList.add('ui-canvas');
  stage.elt.appendChild(p5Canvas);
  p5Canvas.addEventListener('pointerenter', () => { pointerOverFluid = true; });
  p5Canvas.addEventListener('pointerleave', () => { pointerOverFluid = false; });

  buildSidePanel(top);
  buildControls();
  applyLayout();
  resetSimulation();
}

function draw() {
  clear();
  if (!solver) return;

  const params = simulationParams();
  if (brushActive) {
    solver.applyBrush(currentBrush(), params);
  }
  if (!paused) {
    solver.step(params);
    simTime += params.dt;
  }
  solver.render(params);

  if (frameCount % 30 === 0) {
    divergenceRms = solver.measureDivergence(params);
    measuredSpeed = solver.measureSpeed();
  }

  drawPlates();
  if (labelsEnabled) {
    drawPlateLabels();
  }
  drawBrushCursor();
  updateSidePanel();
  updateFlowNumbers();
  updateStatusText();
}

// ---- Layout: fit the simulation to the window ----

// The simulation keeps its 3:2 shape. In a wide window it sits beside the
// side panel; in a narrow one it takes the full width and the panel goes
// below. Its height is also limited so the first controls stay in view.
function simulationSize() {
  const pad = 16; // side gutter, matching .app in style.css
  const wide = windowWidth >= WIDE_LAYOUT_MIN;
  const availableW = windowWidth - 2 * pad - (wide ? SIDE_W + pad : 0);
  const availableH = Math.max(240, windowHeight - 210); // room for the report bar and first controls
  // A multiple of 3 keeps the 3:2 shape exact, so drawn plates and the brush
  // line up with the simulation image vertically as well as horizontally.
  const w = 3 * Math.floor(Math.min(availableW, availableH * 1.5, 1600) / 3);
  return { w, h: (w / 3) * 2, wide };
}

function applyLayout() {
  const { w, h, wide } = simulationSize();
  SIM_W = w;
  SIM_H = h;
  CELL_PX = SIM_W / NX;
  stage.style('width', w + 'px');
  stage.style('height', h + 'px');
  app.elt.classList.toggle('wide', wide);
  app.elt.classList.toggle('narrow', !wide);
  if (solver) solver.resize(w, h);
  resizeCanvas(w, h);
}

function windowResized() {
  applyLayout();
}

// ---- Mouse brush: paint hot or cold fluid ----

function mouseInFluid() {
  return pointerOverFluid && mouseX >= 0 && mouseX < SIM_W && mouseY >= 0 && mouseY < SIM_H;
}

// The brush in solver units: position in velocity-grid cells (y up).
function currentBrush() {
  return {
    mode: mouseTool,
    x: mouseX / CELL_PX - 0.5,
    y: (SIM_H - mouseY) / CELL_PX - 0.5,
    radius: BRUSH_RADIUS * NY,
  };
}

function drawBrushCursor() {
  if (!mouseInFluid()) return;
  const colors = { heat: [255, 190, 90], cool: [120, 190, 255] };
  const [r, g, b] = colors[mouseTool];
  noFill();
  stroke(r, g, b, brushActive ? 230 : 140);
  strokeWeight(brushActive ? 2 : 1.5);
  circle(mouseX, mouseY, 2 * BRUSH_RADIUS * SIM_H);
}

// The Mouse button takes the color the brush paints: the color bar's max
// hot or max cold, with dark or light text, whichever reads better.
function refreshMouseButton() {
  if (!mouseToolButton) return;
  const [r, g, b] = mouseTool === 'heat' ? palette.maxHot : palette.maxCold;
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 140;
  const el = mouseToolButton.elt;
  el.style.background = `rgb(${r}, ${g}, ${b})`;
  el.style.borderColor = `rgb(${r}, ${g}, ${b})`;
  el.style.color = light ? '#111' : '#fff';
  el.title = 'Mouse paints ' + (mouseTool === 'heat' ? 'warm' : 'cold') + ' fluid; click (or press M) to switch';
  el.setAttribute('aria-label', 'Mouse tool: ' + mouseTool);
}

function cycleMouseTool() {
  mouseTool = MOUSE_TOOLS[(MOUSE_TOOLS.indexOf(mouseTool) + 1) % MOUSE_TOOLS.length];
  refreshMouseButton();
}

function simulationParams() {
  return {
    dt: 0.08 * speedSlider.value(),
    ...fluidProperties(),
    freeStream: freeStreamSlider.value(),
    hotT: hotPlateTemperature,
    coldT: coldPlateTemperature,
    plates: getPlateCells(),
    showTracers: tracersEnabled,
    palette,
  };
}

// ---- Controls under the simulation ----

function buildControls() {
  const controlPanel = createDiv('');
  controlPanel.addClass('controls');
  controlPanel.parent(app);

  const blocks = createDiv('');
  blocks.addClass('control-blocks');
  blocks.parent(controlPanel);

  // First column: Fluid, then Meta controls
  const leftStack = createDiv('');
  leftStack.addClass('block-stack');
  leftStack.parent(blocks);

  // Fluid: real properties, or the two dimensionless numbers
  const fluid = addBlock(leftStack, 'Fluid');
  ui.dimensionlessButton = addButton(fluid.buttons, 'Dimensionless: OFF', () => setDimensionless(!dimensionless));
  ui.rangeButton = addButton(fluid.buttons, '', () => setExtendedRange(!extendedRange));
  ui.rangeButton.addClass('range-button');
  refreshRangeButton();
  ui.realControls = createDiv('');
  ui.realControls.addClass('control-list');
  ui.realControls.parent(fluid.body);
  buoyancySlider = addControl(ui.realControls, 'buoyancy', DEFAULTS.buoyancy, formatNumber,
    'How strongly warm fluid rises and cool fluid sinks');
  viscositySlider = addControl(ui.realControls, 'viscosity', DEFAULTS.viscosity, formatNumber,
    'Higher = thicker fluid: smoother, slower motion, fewer small swirls');
  // Default 0.0003: with viscosity 0.00035 that is a Prandtl number near 1
  // (air is 0.7, water 7). The original sketch used 0.0008.
  thermalDiffSlider = addControl(ui.realControls, 'heat', DEFAULTS.heat, formatNumber,
    'Higher = heat spreads faster, so hot and cold blur together sooner');
  ui.dimlessControls = createDiv('');
  ui.dimlessControls.addClass('control-list');
  ui.dimlessControls.parent(fluid.body);
  ui.dimlessControls.elt.hidden = true;
  rayleighSlider = addControl(ui.dimlessControls, 'rayleigh', 1.6e7, formatNumber,
    'Higher = more vigorous convection');
  prandtlSlider = addControl(ui.dimlessControls, 'prandtl', 1.17, formatNumber,
    'Sets which kind of fluid it behaves like');
  prandtlSlider.onChange = () => { if (prSnap) snapPrandtl(); };
  const prExtras = createDiv('');
  prExtras.addClass('pr-extras');
  prExtras.parent(ui.dimlessControls);
  ui.substance = createSpan('');
  ui.substance.addClass('substance');
  ui.substance.parent(prExtras);
  ui.snapButton = createButton('');
  ui.snapButton.addClass('small-button');
  ui.snapButton.parent(prExtras);
  ui.snapButton.mousePressed(() => {
    prSnap = !prSnap;
    if (prSnap) snapPrandtl();
    refreshSnapButton();
  });
  refreshSnapButton();
  ui.fluidNote = createDiv('');
  ui.fluidNote.addClass('block-note');
  ui.fluidNote.parent(fluid.body);

  // Meta controls: running the simulation and what is drawn over it
  const meta = addBlock(leftStack, 'Meta controls');
  statusText = createSpan('');
  statusText.addClass('status');
  statusText.parent(meta.buttons);
  const row = createDiv('');
  row.addClass('control-row');
  row.addClass('meta-buttons');
  row.parent(meta.body);
  pauseButton = addButton(row, 'Pause', () => {
    paused = !paused;
    pauseButton.html(paused ? 'Run' : 'Pause');
  });
  pauseButton.addClass('pause-button');
  resetButton = addButton(row, 'Restart', resetSimulation);
  mouseToolButton = addButton(row, 'Mouse', cycleMouseTool);
  mouseToolButton.addClass('mouse-button');
  refreshMouseButton();
  labelsButton = addButton(row, 'Labels: ON', () => {
    labelsEnabled = !labelsEnabled;
    labelsButton.html(labelsEnabled ? 'Labels: ON' : 'Labels: OFF');
    // The colors still apply with labels off; only the color bar section hides.
    side.fluidTemperature.elt.hidden = !labelsEnabled;
  });
  tracersButton = addButton(row, 'Tracers: OFF', () => {
    tracersEnabled = !tracersEnabled;
    tracersButton.html(tracersEnabled ? 'Tracers: ON' : 'Tracers: OFF');
  });
  const metaList = createDiv('');
  metaList.addClass('control-list');
  metaList.parent(meta.body);
  speedSlider = addControl(metaList, 'speed', DEFAULTS.speed, (v) => nf(v, 1, 2) + '×');

  // Setup and Combinations share the second column
  const stack = createDiv('');
  stack.addClass('block-stack');
  stack.parent(blocks);
  const setupBlock = addBlock(stack, 'Setup');
  const setupList = createDiv('');
  setupList.addClass('control-list');
  setupList.parent(setupBlock.body);
  plateWidthSlider = addControl(setupList, 'plateWidth', DEFAULTS.plateWidth, (v) => nf(v, 1, 2),
    'Width of both plates, as a share of the domain');
  freeStreamSlider = addControl(setupList, 'freeStream', DEFAULTS.freeStream, (v) => nf(v, 1, 3),
    'A wind blowing in from the left edge');

  // Combinations: a random interesting one, the defaults, or copy the current
  const combos = addBlock(stack, 'Combinations');
  const comboButtons = createDiv('');
  comboButtons.addClass('combo-buttons');
  comboButtons.parent(combos.body);
  addButton(comboButtons, 'Surprise me', applyRandomPreset);
  addButton(comboButtons, 'All defaults', applyDefaults);
  addButton(comboButtons, 'Copy settings', copySettings);
  ui.presetLabel = createDiv('');
  ui.presetLabel.addClass('preset-label');
  ui.presetLabel.parent(combos.body);
  ui.settingsText = createElement('textarea');
  ui.settingsText.addClass('settings-text');
  ui.settingsText.attribute('readonly', '');
  ui.settingsText.attribute('rows', '3');
  ui.settingsText.attribute('aria-label', 'Current settings');
  ui.settingsText.parent(combos.body);
  ui.settingsText.elt.hidden = true;
  createDiv('Like a combination? Copy settings, then paste the text to Claude with a name, and it can be added to Surprise me.')
    .addClass('block-note').parent(combos.body);

  // Flow numbers, below the controls: what the settings mean
  const numbers = addBlock(controlPanel, 'Flow numbers');
  numbers.block.addClass('numbers-panel');
  ui.accuracy = createSpan('');
  ui.accuracy.addClass('accuracy-chip');
  ui.accuracy.parent(numbers.buttons);
  const tiles = createDiv('');
  tiles.addClass('number-tiles');
  tiles.parent(numbers.body);
  ui.tiles = {
    ra: addTile(tiles, {
      symbol: 'Ra', name: 'Rayleigh number',
      layman: 'How hard heat pushes the fluid to turn over, compared with how quickly friction and heat spreading calm it down.',
      num: 'buoyancy', den: 'viscous diffusion × thermal diffusion',
    }),
    pr: addTile(tiles, {
      symbol: 'Pr', name: 'Prandtl number',
      layman: 'Whether the fluid spreads motion faster than heat (syrups, oils) or heat faster than motion (liquid metals).',
      num: 'momentum', den: 'thermal', tail: 'diffusivity',
    }),
    re: addTile(tiles, {
      symbol: 'Re', name: 'Reynolds number', tag: 'measured',
      layman: 'How much the moving fluid carries on under its own momentum instead of being slowed by its own stickiness.',
      num: 'inertial', den: 'viscous', tail: 'forces',
    }),
    ri: addTile(tiles, {
      symbol: 'Ri', name: 'Richardson number',
      layman: 'Whether temperature-driven rising and sinking or the push of the free stream wins.',
      num: 'buoyancy', den: 'inertia of the free stream',
    }),
  };
  ui.accuracyDetail = createDiv('');
  ui.accuracyDetail.addClass('accuracy-detail');
  ui.accuracyDetail.parent(numbers.body);

  const descriptions = createDiv('');
  descriptions.addClass('descriptions');
  descriptions.parent(controlPanel);
  for (const line of [
    'Drag in the fluid to paint with the Mouse button\'s color: warm or cold fluid. Click it (or press M) to switch.',
    'Tracers are specks carried along by the fluid; each streak shows where one just moved.',
    'Dimensionless: ON sets the flow by its Rayleigh and Prandtl numbers instead of the fluid\'s properties.',
  ]) {
    createDiv(line).parent(descriptions);
  }
  refreshFluidNote();
}

// A titled block of controls: returns { body, buttons }.
function addBlock(parentElement, title) {
  const block = createDiv('');
  block.addClass('control-block');
  block.parent(parentElement);
  const head = createDiv('');
  head.addClass('block-head');
  head.parent(block);
  createElement('h3', title).parent(head);
  const buttons = createDiv('');
  buttons.addClass('block-buttons');
  buttons.parent(head);
  const body = createDiv('');
  body.addClass('block-body');
  body.parent(block);
  return { block, body, buttons };
}

// A labeled slider with a live value, over RANGES[key]. Log ranges move in
// orders of magnitude. value() reads it, value(v) sets it.
function addControl(parentElement, key, start, format, hint) {
  const r = RANGES[key];
  const row = createDiv('');
  row.addClass('control');
  row.parent(parentElement);
  const name = createElement('label', r.label);
  name.attribute('for', 'control-' + key);
  name.addClass('control-name');
  name.parent(row);
  const slider = createSlider(0, 1, 0.5, 0);
  slider.id('control-' + key);
  slider.addClass('control-slider');
  slider.parent(row);
  const readout = createSpan('');
  readout.addClass('control-value');
  readout.parent(row);
  if (hint) createDiv(hint).addClass('control-hint').parent(row);
  const toSlider = (v) => (r.log ? Math.log10(v) : v);
  const fromSlider = (x) => (r.log ? 10 ** x : x);
  const control = {
    key,
    label: r.label,
    onChange: null,
    range() {
      return extendedRange ? r.extended : r.accurate;
    },
    accurateRange() {
      return r.accurate;
    },
    value(v) {
      if (v === undefined) return fromSlider(Number(slider.elt.value));
      const [lo, hi] = this.range();
      slider.elt.value = toSlider(Math.min(hi, Math.max(lo, v)));
      this.refresh();
      return v;
    },
    applyRange() {
      const keep = this.value();
      const [lo, hi] = this.range();
      slider.elt.min = toSlider(lo);
      slider.elt.max = toSlider(hi);
      slider.elt.step = r.log ? 'any' : String(r.step);
      this.value(keep);
    },
    refresh() {
      readout.html(format(this.value()));
    },
  };
  slider.elt.addEventListener('input', () => {
    if (control.onChange) control.onChange();
    control.refresh();
    showPreset(null);
  });
  const [lo, hi] = r.accurate;
  slider.elt.min = toSlider(lo);
  slider.elt.max = toSlider(hi);
  slider.elt.step = r.log ? 'any' : String(r.step);
  control.value(start);
  return control;
}

function addButton(parentElement, label, onPress) {
  const button = createButton(label);
  button.addClass('control-button');
  button.parent(parentElement);
  button.mousePressed(onPress);
  return button;
}

// A number tile: name and value first, then what it predicts, a plain
// definition, and the ratio drawn as a fraction. A word shared by top and
// bottom (diffusivity, forces) sits to the right of the fraction.
function addTile(parentElement, t) {
  const tile = createDiv('');
  tile.addClass('number-tile');
  tile.parent(parentElement);
  const head = createDiv('');
  head.addClass('tile-head');
  head.parent(tile);
  createSpan(t.name + ' (' + t.symbol + ')').addClass('tile-name').parent(head);
  if (t.tag) createSpan(t.tag).addClass('tile-tag').parent(head);
  const value = createDiv('');
  value.addClass('tile-value');
  value.parent(tile);
  const note = createDiv('');
  note.addClass('tile-note');
  note.parent(tile);
  createP(t.layman).addClass('tile-layman').parent(tile);
  const ratio = createDiv(
    '<span class="ratio-symbol">' + t.symbol + ' =</span>' +
    '<span class="frac"><span>' + t.num + '</span><span>' + t.den + '</span></span>' +
    (t.tail ? '<span class="frac-tail">' + t.tail + '</span>' : '')
  );
  ratio.addClass('tile-ratio');
  ratio.parent(tile);
  return { value, note };
}

// ---- Fluid properties: real or dimensionless ----

// The gap between the plate faces, in domain heights (0.79).
const PLATE_GAP = (COLD_PLATE_ROWS[0] - HOT_PLATE_ROWS[1]) / BASE_NY;

// Viscosity, thermal diffusion and buoyancy: from their sliders, or
// (dimensionless) from Ra and Pr, using Ra = B*dT*L^3 / (nu*kappa) and
// Pr = nu / kappa.
function fluidProperties() {
  if (!dimensionless) {
    return {
      viscosity: viscositySlider.value(),
      thermalDiffusion: thermalDiffSlider.value(),
      buoyancy: buoyancySlider.value(),
    };
  }
  return propertiesFromRaPr(rayleighSlider.value(), prandtlSlider.value(), buoyancySlider.value(),
    hotPlateTemperature - coldPlateTemperature, 0.08 * speedSlider.value());
}

// nu and kappa for a given Ra and Pr. Low Ra at full buoyancy would need
// viscosity or heat diffusion too strong to solve in one time step; then
// buoyancy is lowered instead, which gives the same flow, only slower
// (exactly what low Ra means in a box this size).
function propertiesFromRaPr(ra, pr, buoyancy, deltaT, dt) {
  const drive = buoyancy * deltaT * PLATE_GAP ** 3;
  let kappa = Math.sqrt(drive / (ra * pr));
  let viscosity = pr * kappa;
  // the largest diffusivities the capped solves handle fully (80% margin)
  const cfg = FLUID_DEFAULTS;
  const hT = 1 / (NY * cfg.temperatureScale);
  const hV = 1 / NY;
  const kappaMax = 0.8 * (cfg.maxSweepsTemperature / cfg.sweepsPerSqrtAlpha) ** 2 * hT * hT / dt;
  const viscosityMax = 0.8 * (cfg.maxSweepsVelocity / cfg.sweepsPerSqrtAlpha) ** 2 * hV * hV / dt;
  // both scale with sqrt(buoyancy), so buoyancy scales with the square
  const f = Math.min(1, (kappaMax / kappa) ** 2, (viscosityMax / viscosity) ** 2);
  kappa *= Math.sqrt(f);
  viscosity *= Math.sqrt(f);
  return { viscosity, thermalDiffusion: kappa, buoyancy: buoyancy * f };
}

function rayleighAndPrandtl() {
  const { viscosity, thermalDiffusion, buoyancy } = fluidProperties();
  const drive = buoyancy * (hotPlateTemperature - coldPlateTemperature) * PLATE_GAP ** 3;
  return { ra: drive / (viscosity * thermalDiffusion), pr: viscosity / thermalDiffusion };
}

// Switching keeps the flow the same: the new controls start at the values
// the old ones produced (clamped to their ranges).
function setDimensionless(on) {
  if (on === dimensionless) return;
  if (on) {
    const { ra, pr } = rayleighAndPrandtl();
    rayleighSlider.value(ra);
    prandtlSlider.value(pr);
  } else {
    const { viscosity, thermalDiffusion, buoyancy } = fluidProperties();
    viscositySlider.value(viscosity);
    thermalDiffSlider.value(thermalDiffusion);
    buoyancySlider.value(buoyancy);
  }
  dimensionless = on;
  ui.realControls.elt.hidden = on;
  ui.dimlessControls.elt.hidden = !on;
  ui.dimensionlessButton.html(on ? 'Dimensionless: ON' : 'Dimensionless: OFF');
  refreshFluidNote();
}

function setExtendedRange(on) {
  extendedRange = on;
  for (const c of allControls()) c.applyRange();
  const [lo, hi] = extendedRange ? RANGES.plateT.extended : RANGES.plateT.accurate;
  setPlateRange(side.hotPlate, lo, hi);
  setPlateRange(side.coldPlate, -hi, -lo);
  hotPlateTemperature = side.hotPlate.value();
  coldPlateTemperature = side.coldPlate.value();
  if (prSnap) snapPrandtl();
  refreshRangeButton();
}

// Light green: reasonable limits. Light red: extreme limits, past where the
// simulation can be trusted.
function refreshRangeButton() {
  ui.rangeButton.html(extendedRange ? 'Extreme min/max' : 'Reasonable min/max');
  ui.rangeButton.elt.classList.toggle('extreme', extendedRange);
  ui.rangeButton.attribute('title', extendedRange
    ? 'Sliders go past the reasonable range; click for reasonable limits'
    : 'Sliders stay where the simulation can be trusted; click to allow extremes');
}

function allControls() {
  return [buoyancySlider, viscositySlider, thermalDiffSlider, rayleighSlider, prandtlSlider,
    plateWidthSlider, freeStreamSlider, speedSlider];
}

function refreshFluidNote() {
  ui.fluidNote.html(dimensionless
    ? 'Ra and Pr set the flow; viscosity and thermal diffusion follow. At low Ra the flow is slower, just as it would be in a real box.'
    : '');
  ui.fluidNote.elt.hidden = !dimensionless;
}

// ---- Combinations: presets, defaults, copying ----

// Applies a combination: Ra and Pr (or viscosity and heat), plus any setup
// values it lists; everything else goes to its default. A combination
// outside the reasonable limits switches on the extreme limits.
// A combination that lists its buoyancy (one copied from the page) is
// reproduced exactly. One without (a built-in preset) may get a lower
// buoyancy so its diffusion stays fully solvable (see propertiesFromRaPr).
function applySettings(combo) {
  const v = { ...DEFAULTS, ...combo };
  const exact = combo.buoyancy !== undefined;
  if (!extendedRange && comboIsExtreme(v)) setExtendedRange(true);
  if (combo.dimensionless !== undefined) setDimensionless(combo.dimensionless);
  buoyancySlider.value(v.buoyancy);
  setPlateTemperatures(v.hotT, v.coldT);
  plateWidthSlider.value(v.plateWidth);
  freeStreamSlider.value(v.freeStream);
  speedSlider.value(v.speed);
  if (v.ra !== undefined && v.pr !== undefined) {
    rayleighSlider.value(v.ra);
    prandtlSlider.value(v.pr);
    const deltaT = hotPlateTemperature - coldPlateTemperature;
    const props = propertiesFromRaPr(v.ra, v.pr, v.buoyancy, deltaT, 0.08 * v.speed);
    if (exact && props.buoyancy < v.buoyancy * 0.999) {
      // Reproducing it needs more diffusion than one step fully solves,
      // which only real-properties mode allows: set the properties directly.
      setDimensionless(false);
      const kappa = Math.sqrt(v.buoyancy * deltaT * PLATE_GAP ** 3 / (v.ra * v.pr));
      props.viscosity = v.pr * kappa;
      props.thermalDiffusion = kappa;
      props.buoyancy = v.buoyancy;
    }
    viscositySlider.value(props.viscosity);
    thermalDiffSlider.value(props.thermalDiffusion);
    buoyancySlider.value(props.buoyancy);
  } else {
    viscositySlider.value(v.viscosity);
    thermalDiffSlider.value(v.heat);
    const { ra, pr } = rayleighAndPrandtl();
    rayleighSlider.value(ra);
    prandtlSlider.value(pr);
  }
  for (const c of allControls()) c.refresh();
  resetSimulation();
}

function comboIsExtreme(v) {
  const outside = (key, x) => x !== undefined && (x < RANGES[key].accurate[0] * 0.999 || x > RANGES[key].accurate[1] * 1.001);
  return outside('rayleigh', v.ra) || outside('prandtl', v.pr) || outside('buoyancy', v.buoyancy) ||
    outside('plateWidth', v.plateWidth) || outside('freeStream', v.freeStream) || outside('speed', v.speed) ||
    outside('plateT', v.hotT) || outside('plateT', -v.coldT);
}

function setPlateTemperatures(hot, cold) {
  side.hotPlate.slider.elt.value = hot;
  side.coldPlate.slider.elt.value = cold;
  hotPlateTemperature = side.hotPlate.value();
  coldPlateTemperature = side.coldPlate.value();
}

function applyRandomPreset() {
  const choices = PRESETS.filter((p) => p !== lastPreset);
  const preset = choices[Math.floor(Math.random() * choices.length)];
  applySettings(preset);
  lastPreset = preset;
  showPreset(preset);
}

function applyDefaults() {
  setExtendedRange(false);
  setDimensionless(false);
  prSnap = false;
  refreshSnapButton();
  applySettings({});
  lastPreset = null;
  showPreset({ name: 'Defaults', about: 'every control back where it started' });
}

// Names the combination just applied; cleared as soon as a control moves.
function showPreset(preset) {
  if (!ui.presetLabel) return;
  ui.presetLabel.html(preset ? '<b>' + preset.name + '</b>: ' + preset.about : '');
}

// The current combination as one line of text, for pasting to Claude.
function currentSettings() {
  const { ra, pr } = rayleighAndPrandtl();
  const r3 = (x) => Number(x.toPrecision(3));
  return {
    ra: r3(ra),
    pr: r3(pr),
    buoyancy: r3(fluidProperties().buoyancy),
    hotT: r3(hotPlateTemperature),
    coldT: r3(coldPlateTemperature),
    plateWidth: r3(plateWidthSlider.value()),
    freeStream: r3(freeStreamSlider.value()),
    speed: r3(speedSlider.value()),
    dimensionless,
  };
}

// Copies the settings, and also shows them selected in a box, in case the
// browser doesn't allow copying.
function copySettings() {
  const text = JSON.stringify(currentSettings());
  ui.settingsText.elt.hidden = false;
  ui.settingsText.elt.value = text;
  ui.settingsText.elt.select();
  const done = (message) => ui.presetLabel.html(message);
  try {
    navigator.clipboard.writeText(text).then(
      () => done('Copied. Paste it to Claude with a name for this combination.'),
      () => done('Select the text below and copy it.')
    );
  } catch (error) {
    done('Select the text below and copy it.');
  }
}

// ---- Prandtl number and substances ----

function substanceLabel(pr) {
  const near = SUBSTANCES.find((s) => Math.abs(Math.log10(pr / s.pr)) < 0.03);
  if (near) return '≈ ' + near.name + ' (' + formatNumber(near.pr) + ')';
  if (pr < SUBSTANCES[0].pr) return 'below ' + SUBSTANCES[0].name + ' (' + formatNumber(SUBSTANCES[0].pr) + ')';
  const last = SUBSTANCES[SUBSTANCES.length - 1];
  if (pr > last.pr) return 'above ' + last.name + ' (' + formatNumber(last.pr) + ')';
  const i = SUBSTANCES.findIndex((s) => s.pr > pr);
  const a = SUBSTANCES[i - 1];
  const b = SUBSTANCES[i];
  return 'between ' + a.name + ' (' + formatNumber(a.pr) + ') and ' + b.name + ' (' + formatNumber(b.pr) + ')';
}

// Moves the Pr slider to the nearest substance inside the current range.
function snapPrandtl() {
  const [lo, hi] = prandtlSlider.range();
  const choices = SUBSTANCES.filter((s) => s.pr >= lo && s.pr <= hi);
  if (!choices.length) return;
  const pr = prandtlSlider.value();
  let best = choices[0];
  for (const s of choices) {
    if (Math.abs(Math.log10(pr / s.pr)) < Math.abs(Math.log10(pr / best.pr))) best = s;
  }
  prandtlSlider.value(best.pr);
}

function refreshSnapButton() {
  ui.snapButton.html(prSnap ? 'Snap to substances: ON' : 'Snap to substances: OFF');
}

// ---- Flow numbers and accuracy ----

function formatNumber(v) {
  if (!Number.isFinite(v)) return '∞';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-2) {
    const e = Math.floor(Math.log10(a));
    const m = v / 10 ** e;
    const sup = String(e).replace(/-/g, '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
    return (Math.abs(m - 1) < 0.05 ? '' : m.toFixed(1) + ' × ') + '10' + sup;
  }
  if (a >= 100) return Math.round(v).toLocaleString('en-US');
  if (a >= 10) return v.toFixed(1);
  return v.toPrecision(3).replace(/\.?0+$/, '');
}

function flowNumbers() {
  const p = simulationParams();
  const deltaT = p.hotT - p.coldT;
  const { ra, pr } = rayleighAndPrandtl();
  const re = measuredSpeed === null ? null : measuredSpeed * PLATE_GAP / p.viscosity;
  const u = p.freeStream;
  const ri = u > 1e-8 ? p.buoyancy * deltaT * PLATE_GAP / (u * u) : Infinity; // p.buoyancy is the effective one
  return { ra, pr, re, ri, u };
}

function updateFlowNumbers() {
  const n = flowNumbers();
  const t = ui.tiles;
  setIfChanged('ra', formatNumber(n.ra), (v) => t.ra.value.html(v));
  setIfChanged('raNote', raNote(n.ra), (v) => t.ra.note.html(v));
  setIfChanged('pr', formatNumber(n.pr), (v) => t.pr.value.html(v));
  setIfChanged('prNote', substanceLabel(n.pr), (v) => t.pr.note.html(v));
  setIfChanged('substance', formatNumber(n.pr) + substanceLabel(n.pr), () => {
    ui.substance.html('Pr ' + formatNumber(n.pr) + ': ' + substanceLabel(n.pr));
  });
  setIfChanged('re', n.re === null ? '…' : formatNumber(n.re), (v) => t.re.value.html(v));
  setIfChanged('reNote', reNote(n.re), (v) => t.re.note.html(v));
  setIfChanged('ri', formatNumber(n.ri), (v) => t.ri.value.html(v));
  setIfChanged('riNote', riNote(n.ri, n.u), (v) => t.ri.note.html(v));

  const issues = accuracyIssues(n);
  setIfChanged('accuracy', issues.join('|'), () => {
    ui.accuracy.html(issues.length ? 'Outside reasonable range' : 'Within reasonable range');
    ui.accuracy.elt.classList.toggle('warn', issues.length > 0);
    ui.accuracyDetail.html(issues.length
      ? 'Treat what you see as approximate: ' + issues.join('; ') + '.'
      : 'All settings are inside the range where the simulation has been checked.');
  });
}

// Regime bands for convection between two wide horizontal plates; with
// finite plates and open edges they are approximate.
function raNote(ra) {
  if (ra < 1708) return 'too weak to convect (approx.)';
  if (ra < 5e4) return 'steady rolls (approx.)';
  if (ra < 1e6) return 'unsteady plumes (approx.)';
  return 'turbulent plumes and rolls (approx.)';
}

function reNote(re) {
  if (re === null) return 'measuring the flow…';
  if (re < 1) return 'creeping: viscosity dominates';
  if (re < 100) return 'smooth, orderly flow';
  if (re < 2000) return 'unsteady, swirling flow';
  return 'vigorous, turbulent-like flow';
}

function riNote(ri, u) {
  if (u <= 1e-8) return 'no free stream: buoyancy drives everything';
  if (ri > 10) return 'buoyancy dominates (natural convection)';
  if (ri > 0.1) return 'buoyancy and stream compete (mixed convection)';
  return 'the stream dominates (forced convection)';
}

// Why the current settings are outside the accurate range, if they are.
function accuracyIssues(n) {
  const issues = [];
  if (n.ra > RA_RESOLVED) {
    issues.push('Ra is above ' + formatNumber(RA_RESOLVED) + ': the thin layers on the plates are thinner than a grid cell');
  }
  const d = solver ? solver.diffusionAccuracy() : {};
  if (d.viscosityCapped) issues.push('viscosity is too strong for one time step, so it is only partly solved');
  if (d.heatCapped) issues.push('thermal diffusion is too strong for one time step, so it is only partly solved');
  // (Ra has its own, more specific message above.)
  const visible = dimensionless
    ? [prandtlSlider]
    : [buoyancySlider, viscositySlider, thermalDiffSlider];
  for (const c of [...visible, plateWidthSlider, freeStreamSlider, speedSlider]) {
    const [lo, hi] = c.accurateRange();
    const v = c.value();
    if (v < lo * 0.999 || v > hi * 1.001) issues.push(c.label.toLowerCase() + ' is outside its reasonable range');
  }
  const [tLo, tHi] = RANGES.plateT.accurate;
  for (const t of [hotPlateTemperature, -coldPlateTemperature]) {
    if (t < tLo * 0.999 || t > tHi * 1.001) {
      issues.push('a plate temperature is outside its reasonable range');
      break;
    }
  }
  return issues;
}

// ---- Side panel (HTML) ----

function buildSidePanel(parentElement) {
  const panel = createDiv('');
  panel.addClass('side-panel');
  panel.parent(parentElement);

  const section = (title) => {
    const s = createDiv('');
    s.addClass('panel-section');
    s.parent(panel);
    createElement('h3', title).parent(s);
    return s;
  };

  // Free stream: an arrow whose length shows U∞.
  const freeStream = section('FREE STREAM');
  side.freeStreamValue = createDiv('');
  side.freeStreamValue.addClass('centered');
  side.freeStreamValue.parent(freeStream);
  const arrowTrack = createDiv('');
  arrowTrack.addClass('arrow-track');
  arrowTrack.parent(freeStream);
  side.freeStreamArrow = createDiv('');
  side.freeStreamArrow.addClass('arrow');
  side.freeStreamArrow.parent(arrowTrack);
  side.freeStreamNote = createDiv('');
  side.freeStreamNote.addClass('note centered');
  side.freeStreamNote.parent(freeStream);

  // Plate temperatures
  const plates = section('PLATE TEMPERATURES');
  const [tLo, tHi] = RANGES.plateT.accurate;
  side.hotPlate = addPlateSlider(plates, 'HOT', tLo, tHi, hotPlateTemperature, (v) => {
    hotPlateTemperature = v;
  });
  side.coldPlate = addPlateSlider(plates, 'COLD', -tHi, -tLo, coldPlateTemperature, (v) => {
    coldPlateTemperature = v;
  });
  createDiv('Ambient = ' + nf(AMBIENT_T, 1, 2)).addClass('note').parent(plates);

  // Fluid temperature color bar, with a color picker under each palette color.
  side.fluidTemperature = section('FLUID TEMPERATURE');
  const bar = createDiv('');
  bar.addClass('color-bar');
  bar.parent(side.fluidTemperature);
  side.colorBar = bar;
  side.ambientTick = createDiv('');
  side.ambientTick.addClass('ambient-tick');
  side.ambientTick.parent(bar);
  const swatchRow = createDiv('');
  swatchRow.addClass('swatch-row');
  swatchRow.parent(side.fluidTemperature);
  for (const name of PALETTE_STOPS) {
    const swatch = createButton('');
    swatch.addClass('palette-swatch');
    swatch.attribute('title', PALETTE_LABELS[name] + ' color');
    swatch.attribute('aria-label', PALETTE_LABELS[name] + ' color');
    swatch.parent(swatchRow);
    swatch.style('background', rgbToHex(palette[name]));
    swatch.mousePressed(() => openColorPopover(name, swatch.elt));
    paletteSwatches[name] = swatch;
  }
  const barLabels = createDiv('');
  barLabels.addClass('bar-labels');
  barLabels.parent(side.fluidTemperature);
  createSpan('cold plate').parent(barLabels);
  createSpan('ambient').parent(barLabels);
  createSpan('hot plate').parent(barLabels);

  const paletteButtons = createDiv('');
  paletteButtons.addClass('palette-buttons');
  paletteButtons.parent(side.fluidTemperature);
  // Sets cold and hot to halfway between their neighbors, so each half of
  // the color bar becomes one even blend from the end color to the middle.
  const average = createButton('Average mids');
  average.addClass('small-button');
  average.attribute('title', 'Set cold and hot to the average of their neighbors');
  average.parent(paletteButtons);
  average.mousePressed(() => {
    const mean = (a, b) => a.map((v, i) => Math.round((v + b[i]) / 2));
    palette.cold = mean(palette.maxCold, palette.middle);
    palette.hot = mean(palette.middle, palette.maxHot);
    syncPaletteSwatches();
  });
  const reset = createButton('↺');
  reset.addClass('small-button');
  reset.attribute('title', 'Reset colors');
  reset.parent(paletteButtons);
  reset.mousePressed(() => {
    palette = structuredClone(DEFAULT_PALETTE);
    syncPaletteSwatches();
  });

  // Solver diagnostics
  const diagnostics = createDiv('');
  diagnostics.addClass('panel-section diagnostics');
  diagnostics.parent(panel);
  createDiv('Grid ' + NX + ' × ' + NY + '  (GPU)').parent(diagnostics);
  side.divergence = createDiv('');
  side.divergence.parent(diagnostics);
}

// A labeled range slider for a plate temperature.
function addPlateSlider(parentElement, name, minValue, maxValue, startValue, onChange) {
  const label = createDiv('');
  label.addClass('plate-label');
  label.parent(parentElement);
  const slider = createSlider(minValue, maxValue, startValue, 0.01);
  slider.addClass('plate-slider');
  slider.attribute('aria-label', name + ' plate temperature');
  slider.parent(parentElement);
  slider.input(() => {
    onChange(slider.value());
    showPreset(null);
  });
  const ends = createDiv('');
  ends.addClass('range-ends');
  ends.parent(parentElement);
  const lo = createSpan('');
  lo.parent(ends);
  const hi = createSpan('');
  hi.parent(ends);
  const plate = { name, label, slider, lo, hi, value: () => slider.value() };
  setPlateRange(plate, minValue, maxValue);
  return plate;
}

function setPlateRange(plate, minValue, maxValue) {
  plate.slider.elt.min = minValue;
  plate.slider.elt.max = maxValue;
  plate.slider.elt.step = String(Math.min(0.01, (maxValue - minValue) / 500));
  plate.slider.elt.value = Math.min(maxValue, Math.max(minValue, Number(plate.slider.elt.value)));
  plate.lo.html(nf(minValue, 1, 2));
  plate.hi.html(nf(maxValue, 1, 2));
}

// Updates the side panel text and color bar. Each element is only touched
// when its content changes.
let sidePanelCache = {};
function setIfChanged(key, value, apply) {
  if (sidePanelCache[key] === value) return;
  sidePanelCache[key] = value;
  apply(value);
}

function updateSidePanel() {
  const u = freeStreamSlider.value();
  setIfChanged('u', u, () => {
    side.freeStreamValue.html('U∞ = ' + nf(u, 1, 3));
    side.freeStreamArrow.style('width', (100 * u / freeStreamSlider.range()[1]) + '%');
    side.freeStreamArrow.elt.classList.toggle('off', u <= 1e-8);
    side.freeStreamNote.html(u > 1e-8 ? 'inlet →<br>left boundary' : 'natural only<br>left boundary');
  });
  setIfChanged('hot', hotPlateTemperature, (v) => side.hotPlate.label.html('HOT  ' + nf(v, 1, 2)));
  setIfChanged('cold', coldPlateTemperature, (v) => side.coldPlate.label.html('COLD  ' + nf(v, 1, 2)));

  const barKey = JSON.stringify([palette, coldPlateTemperature, hotPlateTemperature]);
  setIfChanged('bar', barKey, () => {
    drawColorBar();
    refreshMouseButton();
  });

  const div = divergenceRms === null ? '–' : nf(divergenceRms, 1, 4);
  setIfChanged('div', div, () => side.divergence.html('Divergence RMS ' + div));
}

// The color map is piecewise linear, so a CSS gradient with the same stops
// draws it exactly. Swatches and the ambient tick sit at their temperatures.
function drawColorBar() {
  const lo = coldPlateTemperature;
  const hi = hotPlateTemperature;
  const percent = (t) => (100 * (t - lo) / (hi - lo)).toFixed(2) + '%';
  const stops = colorMapStops(lo, hi).map(([t, [r, g, b]]) => `rgb(${r}, ${g}, ${b}) ${percent(t)}`);
  side.colorBar.style('background', `linear-gradient(to right, ${stops.join(', ')})`);
  side.ambientTick.style('left', percent(AMBIENT_T));
  const temps = paletteTemperatures(lo, hi);
  for (const name of PALETTE_STOPS) {
    paletteSwatches[name].style('left', percent(temps[name]));
  }
}

// Temperature of each palette color (matches thermal() in the display
// shader: cold and hot sit halfway along their halves).
function paletteTemperatures(coldT, hotT) {
  return {
    maxCold: coldT,
    cold: (coldT + AMBIENT_T) / 2,
    middle: AMBIENT_T,
    hot: (AMBIENT_T + hotT) / 2,
    maxHot: hotT,
  };
}

// The display shader's color map, as [temperature, RGB] stops.
function colorMapStops(coldT, hotT) {
  const temps = paletteTemperatures(coldT, hotT);
  return PALETTE_STOPS.map((name) => [temps[name], palette[name]]);
}

function syncPaletteSwatches() {
  for (const name of PALETTE_STOPS) paletteSwatches[name].style('background', rgbToHex(palette[name]));
  savePalette();
}

// ---- Color picker popover ----
// The browser's own color picker opens wherever the browser decides, which
// can be off screen. This one is part of the page and always places itself
// inside the window: below the swatch if it fits, otherwise above, and
// shifted sideways to stay in view.

let colorPopover = null;

function openColorPopover(name, anchor) {
  closeColorPopover();
  const popover = document.createElement('div');
  popover.className = 'color-popover';
  popover.innerHTML = `
    <div class="popover-title">${PALETTE_LABELS[name]}</div>
    <canvas class="sv-square" width="180" height="120"></canvas>
    <input class="hue-slider" type="range" min="0" max="360" step="1">
    <div class="popover-row">
      <span class="popover-preview"></span>
      <input class="hex-input" type="text" maxlength="7" spellcheck="false">
      <button class="small-button popover-done">Done</button>
    </div>`;
  document.body.appendChild(popover);

  const square = popover.querySelector('.sv-square');
  const hueSlider = popover.querySelector('.hue-slider');
  const hexInput = popover.querySelector('.hex-input');
  const preview = popover.querySelector('.popover-preview');
  let [h, sat, val] = rgbToHsv(palette[name]);

  const drawSquare = () => {
    const ctx = square.getContext('2d');
    const w = square.width;
    const hgt = square.height;
    ctx.fillStyle = `hsl(${h}, 100%, 50%)`;
    ctx.fillRect(0, 0, w, hgt);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, hgt);
    const black = ctx.createLinearGradient(0, 0, 0, hgt);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, hgt);
    // marker at the current saturation/brightness
    ctx.beginPath();
    ctx.arc(sat * w, (1 - val) * hgt, 5, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = val > 0.5 ? '#000' : '#fff';
    ctx.stroke();
  };

  // Writes the current color everywhere it shows. fromHex: the hex field is
  // being typed in, so leave its text alone.
  const apply = (fromHex = false) => {
    palette[name] = hsvToRgb(h, sat, val);
    const hex = rgbToHex(palette[name]);
    paletteSwatches[name].style('background', hex);
    preview.style.background = hex;
    if (!fromHex) hexInput.value = hex;
    hueSlider.value = h;
    drawSquare();
    savePalette();
  };

  const pickFromSquare = (event) => {
    const r = square.getBoundingClientRect();
    sat = constrain((event.clientX - r.left) / r.width, 0, 1);
    val = constrain(1 - (event.clientY - r.top) / r.height, 0, 1);
    apply();
  };
  square.addEventListener('pointerdown', (event) => {
    square.setPointerCapture(event.pointerId);
    pickFromSquare(event);
  });
  square.addEventListener('pointermove', (event) => {
    if (square.hasPointerCapture(event.pointerId)) pickFromSquare(event);
  });
  hueSlider.addEventListener('input', () => {
    h = Number(hueSlider.value);
    apply();
  });
  hexInput.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) {
      [h, sat, val] = rgbToHsv(hexToRgb(hexInput.value));
      apply(true);
    }
  });
  popover.querySelector('.popover-done').addEventListener('click', closeColorPopover);

  colorPopover = { element: popover, anchor };
  apply();
  placeColorPopover();
  // Close on a click outside it or on Escape (added after this click ends).
  setTimeout(() => {
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
  });
}

// Below the swatch if it fits, otherwise above; always inside the window.
function placeColorPopover() {
  if (!colorPopover) return;
  const { element, anchor } = colorPopover;
  const margin = 8;
  const a = anchor.getBoundingClientRect();
  const w = element.offsetWidth;
  const h = element.offsetHeight;
  let top = a.bottom + 6;
  if (top + h > window.innerHeight - margin) top = a.top - 6 - h;
  top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));
  let left = a.left + a.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
  element.style.top = top + 'px';
  element.style.left = left + 'px';
}

function closeColorPopover() {
  if (!colorPopover) return;
  colorPopover.element.remove();
  colorPopover = null;
  document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  document.removeEventListener('keydown', closeOnEscape, true);
}

function closeOnOutsidePointer(event) {
  if (colorPopover && !colorPopover.element.contains(event.target) && event.target !== colorPopover.anchor) {
    closeColorPopover();
  }
}

function closeOnEscape(event) {
  if (event.key === 'Escape') closeColorPopover();
}

// The popover is fixed to the window, so keep it next to its swatch when the
// page scrolls or the window resizes.
window.addEventListener('scroll', () => placeColorPopover(), true);
window.addEventListener('resize', () => placeColorPopover());

function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function loadPalette() {
  try {
    const saved = JSON.parse(localStorage.getItem('convection-palette'));
    if (saved && PALETTE_STOPS.every((name) => Array.isArray(saved[name]))) return saved;
  } catch (error) {
    // Storage unavailable or corrupt: fall back to the defaults.
  }
  return structuredClone(DEFAULT_PALETTE);
}

function savePalette() {
  try {
    localStorage.setItem('convection-palette', JSON.stringify(palette));
  } catch (error) {
    // Storage unavailable: the colors just won't be remembered.
  }
}

// ---- Simulation ----

function resetSimulation() {
  simTime = 0;
  divergenceRms = null;
  measuredSpeed = null;
  if (solver) {
    solver.reset(simulationParams());
  }
}

// Plate extents in solver cells (x end-exclusive, y counted up from the bottom).
// Centered exactly: the same number of cells on each side.
function getPlateCells() {
  const widthFraction = plateWidthSlider ? plateWidthSlider.value() : 0.52;
  const halfWidth = floor(0.5 * widthFraction * NX);
  const center = NX / 2; // NX is even, so this is the boundary between two cells
  return {
    i0: max(2, center - halfWidth),
    i1: min(NX - 2, center + halfWidth),
    hotJ0: HOT_PLATE_ROWS[0] * RES,
    hotJ1: HOT_PLATE_ROWS[1] * RES,
    coldJ0: COLD_PLATE_ROWS[0] * RES,
    coldJ1: COLD_PLATE_ROWS[1] * RES,
  };
}

// ---- Overlay on the simulation ----

function drawPlates() {
  const plate = getPlateCells();
  const x = plate.i0 * CELL_PX;
  const w = (plate.i1 - plate.i0) * CELL_PX;
  // Solver rows count up from the bottom; the screen counts down from the top.
  const screenY = (j) => SIM_H - j * CELL_PX;

  // Hot plate, with an edge line on the side facing the fluid gap.
  const hotTop = screenY(plate.hotJ1);
  noStroke();
  fill(255, 247, 225);
  rect(x, hotTop, w, screenY(plate.hotJ0) - hotTop);
  stroke(20, 20, 24);
  strokeWeight(2);
  line(x, hotTop, x + w, hotTop);

  // Cold plate.
  const coldTop = screenY(plate.coldJ1);
  const coldBottom = screenY(plate.coldJ0);
  noStroke();
  fill(225, 245, 255);
  rect(x, coldTop, w, coldBottom - coldTop);
  stroke(20, 20, 24);
  strokeWeight(2);
  line(x, coldBottom, x + w, coldBottom);
}

// Plate labels with their temperatures.
function drawPlateLabels() {
  const plate = getPlateCells();
  const centerX = (plate.i0 + plate.i1) / 2 * CELL_PX;
  const bandMiddle = (j0, j1) => SIM_H - (j0 + j1) / 2 * CELL_PX;

  noStroke();
  textAlign(CENTER, CENTER);
  textStyle(BOLD);
  textSize(constrain(SIM_H / 48, 9, 13));
  fill(110, 70, 20);
  text('HOT PLATE  ' + nf(hotPlateTemperature, 1, 2), centerX, bandMiddle(plate.hotJ0, plate.hotJ1));
  fill(20, 60, 110);
  text('COLD PLATE  ' + nf(coldPlateTemperature, 1, 2), centerX, bandMiddle(plate.coldJ0, plate.coldJ1));
}

// ---- Input ----

function mousePressed() {
  if (mouseInFluid()) {
    brushActive = true;
  }
}

function mouseDragged() {
  if (brushActive) return false; // don't scroll or select the page while painting
}

function mouseReleased() {
  brushActive = false;
}

function updateStatusText() {
  statusText.html(round(frameRate()) + ' fps' + (paused ? ' | paused' : ''));
}

function constrainInt(text, lo, hi, fallback) {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function keyPressed() {
  // Typing a hex color shouldn't pause, reset or switch tools.
  const focused = document.activeElement;
  if (focused && focused.tagName === 'INPUT' && focused.type === 'text') return;

  if (key === ' ') {
    paused = !paused;
    pauseButton.html(paused ? 'Run' : 'Pause');
    return false;
  }

  if (key === 'r' || key === 'R') {
    resetSimulation();
  }

  if (key === 'm' || key === 'M') {
    cycleMouseTool();
  }
}
