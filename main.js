import {
  ShaderMount,
  ditheringFragmentShader,
  imageDitheringFragmentShader,
  DitheringShapes,
  DitheringTypes,
  ShaderFitOptions,
  getShaderColorFromString as rgba,
} from 'https://cdn.jsdelivr.net/npm/@paper-design/shaders@0.0.81/+esm';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const sizing = (fit = 'none', scale = 1) => ({
  u_fit: ShaderFitOptions[fit],
  u_scale: scale,
  u_rotation: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_offsetX: 0,
  u_offsetY: 0,
  u_worldWidth: 0,
  u_worldHeight: 0,
});

// ---------- scale ----------
// styles.css sizes everything off one unit, --u. Measure it so the dither grids
// grow with the layout instead of staying a fixed number of screen pixels.
const probe = document.createElement('div');
probe.className = 'u-probe';
document.body.append(probe);
const unit = () => probe.getBoundingClientRect().width / 1000 || 1;

const scaled = []; // [mount, base pixel size]
function track(mount, px) {
  scaled.push([mount, px]);
  mount.setUniforms({ u_pxSize: px * unit() });
}
window.addEventListener('resize', () => {
  const u = unit();
  for (const [mount, px] of scaled) mount.setUniforms({ u_pxSize: px * u });
});

// ---------- page field: dim blue noise, barely above the void ----------
try {
  const field = new ShaderMount(
    document.getElementById('bg-dither'),
    ditheringFragmentShader,
    {
      u_colorBack: rgba('#08080a'),
      u_colorFront: rgba('#14384f'),
      u_shape: DitheringShapes.warp,
      u_type: DitheringTypes['4x4'],
      u_pxSize: 3,
      ...sizing('none', 0.55),
    },
    undefined,
    reduceMotion ? 0 : 0.25,
  );
  track(field, 3);
} catch (err) {
  console.warn('Background dither unavailable', err);
}

// ---------- portrait ----------
// The image shader has no clock, so the motion is baked: a loop of frames with a
// light band sweeping down the artwork, swapped in as the texture. The shader
// keeps each pixel's hue and quantises only its brightness, so the palette holds.
const FRAMES = 40;
const FPS = 12;
const FRAME_SIZE = 512; // the source is 2000px; 40 full-size frames would be ~640MB decoded

const avatar = document.getElementById('avatar');
const img = avatar?.querySelector('img');

function toImage(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('toBlob failed'));
      const out = new Image();
      out.onload = () => resolve(out);
      out.onerror = reject;
      // Blob URLs are unique, which the shader's texture cache keys on.
      out.src = URL.createObjectURL(blob);
    }, 'image/png');
  });
}

// Band: a hotter copy of the artwork masked to a soft horizontal strip.
// Brightening never lifts pure black, so the background stays dark.
function drawFrame(ctx, hot, src, t) {
  const { width: w, height: h } = ctx.canvas;
  ctx.drawImage(src, 0, 0, w, h);
  if (t < 0) return; // still frame, no band

  const y = (-0.25 + t * 1.5) * h;
  const band = hot.createLinearGradient(0, y - h * 0.14, 0, y + h * 0.14);
  band.addColorStop(0, 'rgba(0,0,0,0)');
  band.addColorStop(0.5, 'rgba(0,0,0,1)');
  band.addColorStop(1, 'rgba(0,0,0,0)');
  hot.globalCompositeOperation = 'source-over';
  hot.filter = 'brightness(1.9) contrast(1.15)';
  hot.clearRect(0, 0, w, h);
  hot.drawImage(src, 0, 0, w, h);
  hot.filter = 'none';
  hot.globalCompositeOperation = 'destination-in';
  hot.fillStyle = band;
  hot.fillRect(0, 0, w, h);
  ctx.drawImage(hot.canvas, 0, 0);
}

// The artwork's ground is near-black (#0a0911), not black, so the dither lifts it
// into a faint square of purple dots. Crush those pixels to true black first:
// black stays black through a 4×4 Bayer dither, and the blend hides it.
function crushedSource(src) {
  const ctx = makeCtx();
  ctx.drawImage(src, 0, 0, FRAME_SIZE, FRAME_SIZE);
  const data = ctx.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.max(px[i], px[i + 1], px[i + 2]) < 28) px[i] = px[i + 1] = px[i + 2] = 0;
  }
  ctx.putImageData(data, 0, 0);
  return ctx.canvas;
}

const makeCtx = () => {
  const c = document.createElement('canvas');
  c.width = c.height = FRAME_SIZE;
  return c.getContext('2d', { willReadFrequently: true });
};

async function buildFrames(src, count) {
  const ctx = makeCtx();
  const hot = makeCtx();
  const frames = [];
  for (let i = 0; i < count; i++) {
    drawFrame(ctx, hot, src, count === 1 ? -1 : i / count);
    frames.push(await toImage(ctx.canvas));
  }
  return frames;
}

async function mountAvatar() {
  let mount;
  let frames;
  try {
    const src = crushedSource(img);
    frames = await buildFrames(src, reduceMotion ? 1 : FRAMES);
    mount = new ShaderMount(
      avatar,
      imageDitheringFragmentShader,
      {
        u_image: frames[0],
        u_colorBack: rgba('#08080a'),
        u_colorFront: rgba('#f7f0e0'),
        u_colorHighlight: rgba('#f7f0e0'),
        u_type: DitheringTypes['4x4'],
        u_pxSize: 2,
        u_colorSteps: 4,
        u_originalColors: true,
        u_inverted: false,
        ...sizing('cover'),
      },
      undefined,
      0,
    );
    track(mount, 2);
    avatar.classList.add('is-live');
  } catch (err) {
    console.warn('Portrait shader unavailable', err);
    return;
  }

  if (frames.length < 2) return;

  let i = 0;
  let last = 0;
  const tick = (now) => {
    if (now - last >= 1000 / FPS) {
      last = now;
      i = (i + 1) % frames.length;
      mount.setUniforms({ u_image: frames[i] });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

if (avatar && img) {
  if (img.complete && img.naturalWidth) mountAvatar();
  else img.addEventListener('load', mountAvatar, { once: true });
}
