// Dibujo de la guía de captura: superposición de realidad aumentada sobre el vídeo y esfera
// de cobertura que muestra las zonas que aún faltan por fotografiar.
import { dirFromHP } from './math3d.js';

const ACCENT = '#ffd23f', OK = '#35d07f', MISSING = 'rgba(255,96,64,';

/** Crea un proyector mundo -> pantalla para la pose y el encuadre actuales. */
export function makeProjector(R, K, view) {
  return (d) => {
    const z = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];
    const x = R[0] * d[0] + R[3] * d[1] + R[6] * d[2];
    const y = R[1] * d[0] + R[4] * d[1] + R[7] * d[2];
    if (z > -0.08) return { behind: true, cx: x, cy: y };
    const u = K.cx + K.f * x / -z, v = K.cy - K.f * y / -z;
    return { x: view.offX + (u + 0.5) * view.scale, y: view.offY + (v + 0.5) * view.scale, cx: x, cy: y, depth: -z };
  };
}

/** Cómo encaja el vídeo en pantalla con object-fit: cover. */
export function coverView(cssW, cssH, vw, vh) {
  const scale = Math.max(cssW / vw, cssH / vh);
  return { scale, offX: (cssW - vw * scale) / 2, offY: (cssH - vh * scale) / 2 };
}

/**
 * Superposición sobre el vídeo.
 * state: {coverage, targets:[{h,p,done}], next (índice), hold (0..1), started}
 */
export function drawOverlay(ctx, cssW, cssH, R, K, state) {
  ctx.clearRect(0, 0, cssW, cssH);
  const view = coverView(cssW, cssH, K.w, K.h);
  const project = makeProjector(R, K, view);
  const inside = (p, m = 0) => !p.behind && p.x >= -m && p.y >= -m && p.x <= cssW + m && p.y <= cssH + m;

  // Zonas sin cubrir: velo rojizo (celdas de 6°) que desaparece al fotografiar
  const cov = state.coverage;
  if (cov && state.started) {
    const nx = cov.nLon / 2, ny = cov.nLat / 2;
    const verts = cov._verts ??= (() => {
      const v = [];
      for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++) v.push(dirFromHP(-Math.PI + i * 2 * cov.step, Math.PI / 2 - j * 2 * cov.step));
      }
      return v;
    })();
    const pts = verts.map(project);
    ctx.beginPath();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = 2 * j * cov.nLon + 2 * i;
        if (cov.cells[c] && cov.cells[c + 1] && cov.cells[c + cov.nLon] && cov.cells[c + cov.nLon + 1]) continue;
        const a = pts[j * (nx + 1) + i], b = pts[j * (nx + 1) + i + 1];
        const d = pts[(j + 1) * (nx + 1) + i], e = pts[(j + 1) * (nx + 1) + i + 1];
        if (a.behind || b.behind || d.behind || e.behind) continue;
        if (!(inside(a) || inside(b) || inside(d) || inside(e))) continue;
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.lineTo(d.x, d.y); ctx.closePath();
      }
    }
    ctx.fillStyle = MISSING + '0.3)';
    ctx.fill();
  }

  // Horizonte
  ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1;
  ctx.beginPath();
  let pen = false;
  for (let a = 0; a <= 360; a += 3) {
    const p = project(dirFromHP(a * Math.PI / 180, 0));
    if (inside(p, 200)) { if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); pen = true; } else pen = false;
  }
  ctx.stroke();

  // Puntos guía
  const cxs = cssW / 2, cys = cssH / 2;
  if (state.targets) {
    state.targets.forEach((t, i) => {
      const p = project(dirFromHP(t.h, t.p));
      if (!inside(p, 30)) return;
      if (t.done) {
        ctx.fillStyle = OK; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill();
      } else {
        const isNext = i === state.next;
        ctx.lineWidth = isNext ? 4 : 2;
        ctx.strokeStyle = isNext ? ACCENT : 'rgba(255,255,255,.85)';
        ctx.beginPath(); ctx.arc(p.x, p.y, isNext ? 20 : 13, 0, 7); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill();
      }
    });
  }

  // Retículo central con anillo de progreso mientras se mantiene quieto
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.beginPath(); ctx.arc(cxs, cys, 28, 0, 7); ctx.stroke();
  if (state.hold > 0) {
    ctx.strokeStyle = OK; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cxs, cys, 28, -Math.PI / 2, -Math.PI / 2 + state.hold * 2 * Math.PI); ctx.stroke();
  }

  // Flecha hacia el siguiente punto si queda fuera de la pantalla
  const nt = state.targets?.[state.next];
  if (nt) {
    const p = project(dirFromHP(nt.h, nt.p));
    if (!inside(p, -40)) {
      let vx = p.cx, vy = -p.cy;
      const n = Math.hypot(vx, vy) || 1; vx /= n; vy /= n;
      const rad = Math.min(cssW, cssH) * 0.3;
      const ax = cxs + vx * rad, ay = cys + vy * rad;
      ctx.save();
      ctx.translate(ax, ay); ctx.rotate(Math.atan2(vy, vx));
      ctx.fillStyle = ACCENT; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(-12, -16); ctx.lineTo(-4, 0); ctx.lineTo(-12, 16); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }
}

/**
 * Esfera de cobertura. Se dibuja el hemisferio centrado en la dirección a la que apunta la
 * cámara (back = false) o el opuesto (back = true), visto desde dentro: verde = cubierto,
 * rojo = pendiente.
 */
export function drawGlobe(canvas, R, coverage, { back = false, K = null, targets = null, next = -1 } = {}) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const img = canvas._img?.width === size ? canvas._img : (canvas._img = ctx.createImageData(size, size));
  const data = img.data;
  const c = (size - 1) / 2, rad = size / 2 - 1.5;
  const { nLon, nLat, step, cells } = coverage;
  for (let y = 0; y < size; y++) {
    const ny = -(y - c) / rad;
    for (let x = 0; x < size; x++) {
      const nx = (x - c) / rad;
      const rr = nx * nx + ny * ny;
      const o = (y * size + x) * 4;
      if (rr > 1) { data[o + 3] = 0; continue; }
      const nz = Math.sqrt(1 - rr);
      const cxm = back ? -nx : nx, czm = back ? nz : -nz;
      const dx = R[0] * cxm + R[1] * ny + R[2] * czm;
      const dy = R[3] * cxm + R[4] * ny + R[5] * czm;
      const dz = R[6] * cxm + R[7] * ny + R[8] * czm;
      const lon = (Math.atan2(dx, dy) + Math.PI) / step;
      const lat = (Math.PI / 2 - Math.asin(dz > 1 ? 1 : dz < -1 ? -1 : dz)) / step;
      let i = lon | 0, j = lat | 0;
      if (i >= nLon) i = nLon - 1;
      if (j >= nLat) j = nLat - 1;
      const covered = cells[j * nLon + i];
      // retícula cada 30° y ecuador resaltado
      const gl = (lon * step * 6 / Math.PI) % 1, gp = (lat * step * 6 / Math.PI) % 1;
      const grid = gl < 0.035 || gl > 0.965 || gp < 0.035 || gp > 0.965;
      const shade = 0.55 + 0.45 * nz;
      let r, g, b;
      if (covered) { r = 40; g = 200; b = 120; } else { r = 215; g = 70; b = 50; }
      if (grid) { r = r * 0.6 + 100; g = g * 0.6 + 100; b = b * 0.6 + 100; }
      data[o] = r * shade; data[o + 1] = g * shade; data[o + 2] = b * shade;
      data[o + 3] = rr > 0.97 ? 255 * (1 - rr) / 0.03 : 235;
    }
  }
  ctx.putImageData(img, 0, 0);

  const toDisc = (d) => {
    const x = R[0] * d[0] + R[3] * d[1] + R[6] * d[2];
    const y = R[1] * d[0] + R[4] * d[1] + R[7] * d[2];
    const z = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];
    if (back ? z < 0.02 : z > -0.02) return null;
    return [c + (back ? -x : x) * rad, c - y * rad];
  };
  if (targets) {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.done) continue;
      const p = toDisc(dirFromHP(t.h, t.p));
      if (!p) continue;
      ctx.fillStyle = i === next ? ACCENT : '#fff';
      ctx.beginPath(); ctx.arc(p[0], p[1], size * (i === next ? 0.035 : 0.02), 0, 7); ctx.fill();
    }
  }
  if (K && !back) {
    // contorno del encuadre actual
    const hw = Math.sin(Math.atan(K.w / 2 / K.f)) * rad, hh = Math.sin(Math.atan(K.h / 2 / K.f)) * rad;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, size / 90);
    ctx.strokeRect(c - hw, c - hh, 2 * hw, 2 * hh);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = Math.max(1, size / 120);
  ctx.beginPath(); ctx.arc(c, c, rad, 0, 7); ctx.stroke();
}
