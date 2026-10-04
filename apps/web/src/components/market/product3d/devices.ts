// The non-phone builders, one per kind. Millimetres, front facing +z, roughly centred on the origin (build.ts fits and centres).
// Generic silhouettes: no logos, no wordmarks, no real screen artwork (a screen is a calm dark gradient). The market accent is a thin line.
import type { Ctx } from './build.ts';
import type { Kind } from './specs.ts';
import { rbox, plate, ring, gradientPanel, mergeBoxes, ribbon, sheet } from './geo.ts';

const PI = Math.PI;
/** A screen: very dark at the bottom, a hint of the accent at the top. */
function screen(c: Ctx, w: number, h: number, r: number, x: number, y: number, z: number, parent?: any) {
  const { T } = c, base = new T.Color('#080b10'), top = new T.Color('#16202c').lerp(c.m.accent.color, 0.03);
  return c.add(gradientPanel(T, w, h, r, base, top), c.m.screen, x, y, z, parent);
}
const cyl = (T: any, r: number, h: number, axis: 'x' | 'y' | 'z' = 'y', seg = 28) => {
  const g = new T.CylinderGeometry(r, r, h, seg); if (axis === 'x') g.rotateZ(PI / 2); else if (axis === 'z') g.rotateX(PI / 2); return g;
};

function earbuds(c: Ctx) {
  const { T, add, m } = c, body = m.paint('#f1f2f3', 0.28);
  add(rbox(T, 60, 30, 22, 10, 3.4), body, 0, -6, 0);                                                     // pill-shaped lower case, y -21 .. 9
  const well = add(plate(T, 52, 16, 6, 0.2), m.dark); well.rotation.x = -PI / 2; well.position.set(0, 9.05, 0);   // the open top
  const hinge = new T.Group(); hinge.position.set(0, 9, -11); hinge.rotation.x = -1.95; c.root.add(hinge);       // lid, swung open backwards
  add(rbox(T, 60, 18, 22, 10, 3.4), body, 0, 9, 11, hinge);
  add(cyl(T, 2.8, 30, 'x', 16), m.metal('#aeb2b9', 0.3), 0, 9, -11);                                     // visible hinge barrel
  const head = c.keep(new T.SphereGeometry(6.2, 28, 18)), stem = c.keep(new T.CapsuleGeometry(2.4, 15, 4, 12)), tip = c.keep(new T.SphereGeometry(3.7, 18, 12)), cut = c.keep(new T.CircleGeometry(8.4, 24));
  const once = (g: any, mat: any, x: number, y: number, z: number, parent: any = c.root) => { const o = new c.T.Mesh(g, mat); o.position.set(x, y, z); parent.add(o); return o; };
  for (const sx of [-1, 1]) {
    const hole = once(cut, m.paint('#050607', 0.5), sx * 13.4, 9.15, 1); hole.rotation.x = -PI / 2; hole.scale.set(1, 1.05, 1);   // empty charging cutout
    // the bud lies on the floor in front of the case: round head with a soft tip toward the middle, stem pointing outward
    const bud = new c.T.Group(); bud.position.set(sx * 17, -21 + 6.2, 31); bud.rotation.y = sx * 0.3; c.root.add(bud);
    once(head, body, 0, 0, 0, bud); once(tip, m.soft('#dfe1e4'), -sx * 4.6, 0.4, 0, bud);
    const st = once(stem, body, sx * 13, -1.2, 0, bud); st.rotation.z = PI / 2;
  }
  add(new T.CircleGeometry(1.4, 16), m.accent, 0, 1, 11.05);                                              // status light
  const seam = add(ring(T, 60.8, 22.8, 10.2, 1.1, 0.9), m.accent); seam.rotation.x = -PI / 2; seam.position.set(0, 6.9, 0); // accent lid line round the case rim
}

function headphones(c: Ctx) {
  const { T, add, m } = c, shell = m.paint('#23262b', 0.4), metal = m.metal('#b9bec6', 0.3), pad = m.soft('#17191c');
  const band = add(new T.TorusGeometry(78, 4.6, 10, 48, PI), shell, 0, 4, 0); band.scale.z = 2.4;           // headband (top half circle)
  const cush = add(new T.TorusGeometry(73.5, 5.4, 10, 24, 1.5), pad, 0, 4, 0); cush.scale.z = 2.6; cush.rotation.z = PI / 2 - 0.75; // padded underside
  const prof = [[0, -13], [31, -13], [37, -9], [38, 0], [37, 9], [31, 13], [0, 13]].map(([r, y]) => new T.Vector2(r, y));
  for (const sx of [-1, 1]) {
    add(cyl(T, 2.6, 26), metal, sx * 78, -9, 0);                                                          // slider
    add(cyl(T, 5.2, 12, 'z'), metal, sx * 80, -23, 0);                                                    // slim folding hinge
    add(new T.BoxGeometry(5, 26, 7), metal, sx * 83.5, -37, 0);                                           // fork arm to the cup
    const cup = add(new T.LatheGeometry(prof, 40), shell, sx * 90, -48, 0); cup.rotation.z = PI / 2; cup.scale.set(1, 1, 0.82); // oval ear cup, axis along x
    const padM = add(new T.TorusGeometry(26, 8.5, 10, 32), pad, sx * 76, -48, 0); padM.rotation.y = PI / 2; padM.scale.z = 0.82;  // ear pad
    const acc = add(new T.TorusGeometry(24, 0.9, 6, 40), m.accent, sx * 103.3, -48, 0); acc.rotation.y = PI / 2; acc.scale.z = 0.82; // accent ring
  }
}

function handheld(c: Ctx) {
  const { T, add, m } = c, body = m.paint('#1b1d22', 0.4), ctrl = m.paint('#2b2f37', 0.35), cap = m.paint('#0e0f12', 0.3), btn = m.paint('#8c919a', 0.3);
  add(rbox(T, 196, 112, 12, 7, 2), body);                                                               // tablet
  add(plate(T, 184, 100, 3, 0.2), m.glass, 0, 0, 5.9); screen(c, 178, 94, 2.5, 0, 0, 6.15);
  for (const sx of [-1, 1]) {
    const x = sx * 118, sy = sx < 0 ? 24 : -22;
    add(rbox(T, 40, 114, 17, 17, 4), ctrl, x, 0, 0);                                                     // side controller
    add(new T.BoxGeometry(1.2, 100, 1), m.accent, sx * 98.4, 0, 8.7);                                    // lit rail where it clicks on
    add(cyl(T, 9, 2, 'z', 20), cap, x, sy, 8.5); add(cyl(T, 7, 4, 'z', 20), btn, x, sy, 10.5);           // thumbstick
  }
  add(cyl(T, 3.4, 2.6, 'z', 16), btn, 118, 36, 9); add(cyl(T, 3.4, 2.6, 'z', 16), btn, 118, 20, 9);       // right controller: face buttons
  add(cyl(T, 3.4, 2.6, 'z', 16), btn, 110, 28, 9); add(cyl(T, 3.4, 2.6, 'z', 16), btn, 126, 28, 9);
  add(new T.BoxGeometry(18, 6, 2), btn, -118, -26, 9.2); add(new T.BoxGeometry(6, 18, 2), btn, -118, -26, 9.2);   // left controller: plus pad
}

function vr(c: Ctx) {
  const { T, add, m } = c, shell = m.paint('#e9ebed', 0.32), strap = m.soft('#4a4f58');
  add(rbox(T, 172, 90, 62, 34, 9), shell);                                                              // visor block
  add(plate(T, 150, 64, 26, 0.6), m.glass, 0, 0, 31);                                                    // dark front visor
  for (const x of [-46, -18, 18, 46]) add(cyl(T, 5.5, 1.2, 'z', 18), m.paint('#2b3038', 0.2), x, x === -46 || x === 46 ? 6 : -6, 31.8);  // tracking cameras
  add(rbox(T, 146, 78, 16, 32, 4), m.soft('#16181b'), 0, 0, -36);                                         // face pad
  add(ring(T, 150, 64, 26, 0.8, 0.5), m.accent, 0, 0, 31.4);                                              // accent line round the visor
  add(ribbon(T, [[-86, 0, -8], [-84, 0, -52], [-58, 0, -108], [0, 0, -132], [58, 0, -108], [84, 0, -52], [86, 0, -8]], 24, 4.5, [0, 1, 0]), strap);  // head strap
  add(ribbon(T, [[0, 45, -4], [0, 56, -40], [0, 42, -100], [0, 8, -128]], 24, 4.5, [1, 0, 0]), strap);  // top strap
  add(rbox(T, 56, 40, 12, 10, 3), m.paint('#2c3037', 0.4), 0, 0, -133);                                  // rear fit pad
}

function console_(c: Ctx) {
  const { T, add, m } = c, white = m.paint('#f1f2f4', 0.28), core = m.paint('#2a2e35', 0.4), black = m.paint('#07080a', 0.4), grey = m.paint('#9aa0a8', 0.35);
  white.side = T.DoubleSide;
  const HH = 195, B = 30;                                                                                // half height, core half width
  // two curved faceplates ("wings"): flare outward toward the top and the foot, long S-curve seen from the side, rounded ends
  const wing = (sx: number) => add(sheet(T, 28, 56, (u, v) => {
    const s = v * 2 - 1, y = s * HH, round = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(s), 16)));
    const centre = 9 * Math.sin(Math.PI * s), half = (116 - 16 * s * s) * round;                       // S-curve of the depth axis, a little narrower at the top
    const x = sx * (B + 4 + 20 * Math.pow(Math.abs(s), 2.2) + 3 * Math.cos(u * Math.PI)); // flare at both ends, soft bow across the depth
    return [x, y, centre + (u * 2 - 1) * half];
  }, sx * 7), white);
  wing(1); wing(-1);
  add(rbox(T, 2 * B + 6, 2 * HH - 14, 196, 14, 3), core);                                               // darker core between the wings
  const fz = 99;                                                                                         // front face of the core
  add(new T.BoxGeometry(46, 2.6, 1.2), black, 0, 78, fz);                                                // horizontal disc-slot line
  add(cyl(T, 4.2, 1.6, 'z', 20), grey, 0, 30, fz);                                                       // power button
  add(new T.BoxGeometry(7, 3.2, 1.4), black, -9, -30, fz); add(new T.BoxGeometry(7, 3.2, 1.4), black, 9, -30, fz);   // USB ports
  add(cyl(T, 76, 6, 'y', 56), m.paint('#3a3f47', 0.45), 0, -HH - 12, 0);                                 // short stand foot
  const ringM = add(new T.TorusGeometry(70, 2.4, 8, 64), m.paint('#14161a', 0.5), 0, -HH - 6.5, 0); ringM.rotation.x = PI / 2;   // thin dark base ring
  const glow = add(new T.TorusGeometry(77, 1.1, 6, 64), m.accent, 0, -HH - 8.5, 0); glow.rotation.x = PI / 2;                    // lit edge of the foot
  // a generic gamepad leaning against the stand so "game" reads at a glance: two grips, touch pad, d-pad, two sticks, four buttons
  const pad = new T.Group(); pad.position.set(142, -HH - 14 + 66, 76); pad.rotation.set(-1.05, -0.4, 0); pad.scale.setScalar(1.3); c.root.add(pad);
  const pw = m.paint('#f1f2f4', 0.3), pd = m.paint('#1a1c20', 0.4), pg = m.paint('#8f959d', 0.35);
  add(rbox(T, 104, 60, 24, 24, 5), pw, 0, 6, 0, pad);                                                    // body
  for (const sx of [-1, 1]) { const g = add(rbox(T, 42, 76, 24, 20, 5), pw, sx * 46, -26, -1, pad); g.rotation.z = sx * 0.22; }   // grips
  add(plate(T, 40, 20, 8, 1), pd, 0, 16, 11.2, pad);                                                     // touch pad
  add(new T.BoxGeometry(44, 2.2, 1.2), m.accent, 0, 33, 12.2, pad);                                      // light bar
  add(new T.BoxGeometry(17, 5.5, 2), pg, -42, 10, 12.5, pad); add(new T.BoxGeometry(5.5, 17, 2), pg, -42, 10, 12.5, pad);   // d-pad
  for (const [dx, dy] of [[0, 8], [0, -8], [-8, 0], [8, 0]]) add(cyl(T, 4.2, 2.4, 'z', 16), pg, 42 + dx, 10 + dy, 12.4, pad);   // four buttons
  add(cyl(T, 9, 5, 'z', 20), pd, -20, -14, 12, pad); add(cyl(T, 9, 5, 'z', 20), pd, 20, -14, 12, pad);  // sticks
}

function laptop(c: Ctx) {
  const { T, add, m } = c, alu = m.metal('#c8cbd0', 0.36), W = 300, D = 212, TH = 9;
  const base = add(rbox(T, W, D, TH, 12, 3), alu); base.rotation.x = -PI / 2;                              // base, lying flat (y -4.5 .. 4.5)
  const deck = add(plate(T, 266, 70, 5, 0.3), m.dark); deck.rotation.x = -PI / 2; deck.position.set(0, 4.55, -60);  // keyboard recess
  const keys: number[][] = []; for (let r = 0; r < 4; r++) for (let k = 0; k < 14; k++) keys.push([(k - 6.5) * 18.2, 5.2, -84 + r * 17.5, 16, 1.4, 15.5]);
  add(mergeBoxes(T, keys), m.paint('#23262b', 0.5));                                                    // keys (one merged mesh)
  const pad = add(plate(T, 108, 70, 5, 0.2), m.paint('#b4b8be', 0.3)); pad.rotation.x = -PI / 2; pad.position.set(0, 4.6, 52);              // trackpad
  const hinge = new T.Group(); hinge.position.set(0, TH / 2 + 1, -D / 2 + 5); hinge.rotation.x = -0.35; c.root.add(hinge);                  // lid open ~110 degrees
  add(cyl(T, 3.6, 270, 'x'), m.metal('#8b9098', 0.4), 0, 0, 0, hinge);                                   // hinge barrel
  add(rbox(T, W, 204, 5.5, 10, 2), alu, 0, 104, 0, hinge);                                              // lid
  add(plate(T, 292, 195, 4, 0.3), m.glass, 0, 104, 2.65, hinge);                                         // bezel
  screen(c, 284, 188, 2.5, 0, 104, 3.0, hinge);
  add(ring(T, 284, 188, 2.5, 0.8, 0.4), m.accent, 0, 104, 3.05, hinge);                                  // accent line round the display
}

function tablet(c: Ctx) {
  const { T, add, m } = c, alu = m.metal('#c9ccd1', 0.34), W = 246, H = 177, TH = 6;
  add(rbox(T, W, H, TH, 14, 1.6), alu);                                                                 // thin slab
  add(plate(T, W - 3, H - 3, 12, 0.3), m.glass, 0, 0, TH / 2 - 0.12);                                    // front glass
  screen(c, W - 24, H - 24, 4, 0, 0, TH / 2 + 0.22);
  add(ring(T, W - 24, H - 24, 4, 0.8, 0.3), m.accent, 0, 0, TH / 2 + 0.26);
  add(new T.CircleGeometry(1.6, 14), m.paint('#262b33', 0.2), 0, H / 2 - 6, TH / 2 + 0.25);              // front camera
  const R = 6.2;                                                                                        // rear camera dot on the back (visible while it turns)
  add(cyl(T, R, 1.2, 'z'), m.metal('#aeb2b9', 0.3), -W / 2 + 18, H / 2 - 18, -TH / 2 - 0.5); add(cyl(T, R * 0.7, 0.4, 'z'), m.glass, -W / 2 + 18, H / 2 - 18, -TH / 2 - 1.1);
  add(new T.BoxGeometry(14, 1.2, 2.4), alu, W / 2 - 40, H / 2 + 0.1, 0);                                  // top button
}

function watch(c: Ctx) {
  const { T, add, m } = c, W = 44, H = 50, TH = 11.5, caseM = m.metal('#8f949c', 0.3);
  add(rbox(T, W, H, TH, 12, 3), caseM);                                                                   // rounded-square case
  add(plate(T, W - 3, H - 3, 9.5, 0.3), m.glass, 0, 0, TH / 2 - 0.1);                                      // glass
  screen(c, W - 7, H - 7, 6, 0, 0, TH / 2 + 0.22);
  add(ring(T, W - 7, H - 7, 6, 0.7, 0.3), m.accent, 0, 0, TH / 2 + 0.26);
  const hand = (len: number, ang: number) => { const g = new T.BoxGeometry(1.6, len, 0.5); g.translate(0, len / 2, 0); add(g, m.paint('#f3f4f6', 0.3), 0, 0, TH / 2 + 0.6).rotation.z = ang; };
  hand(11, -0.35); hand(15, 1.1);                                                                         // hour and minute hands
  add(cyl(T, 1.6, 0.6, 'z', 12), m.paint('#f3f4f6', 0.3), 0, 0, TH / 2 + 0.7);
  add(cyl(T, 4.4, 4.5, 'x'), caseM, W / 2 + 1.5, 9, 0);                                                    // digital crown
  add(new T.BoxGeometry(2, 11, 3.4), caseM, W / 2 + 0.3, -8, 0);                                          // side button
  const loop = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => { const a = (i / 12) * PI * 2; return [0, 54 * Math.sin(a), -30 + 32 * Math.cos(a)]; });
  add(ribbon(T, loop, 24, 3.6, [1, 0, 0], true, 72), m.soft('#8a9099'));                                   // sport band loop
}

function generic(c: Ctx) {
  const { T, add, m } = c;
  add(rbox(T, 110, 80, 34, 18, 6), m.paint('#c9ccd1', 0.4));
  add(plate(T, 96, 66, 12, 0.3), m.glass, 0, 0, 17.05); screen(c, 90, 60, 8, 0, 0, 17.4);
  add(ring(T, 90, 60, 8, 0.8, 0.3), m.accent, 0, 0, 17.45);
}

export const DEVICES: Record<Exclude<Kind, 'phone' | 'case'>, (c: Ctx) => void> = { earbuds, headphones, handheld, vr, console: console_, laptop, tablet, watch, generic };
