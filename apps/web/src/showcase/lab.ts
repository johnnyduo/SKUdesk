import { createTile, TILE_W, TILE_H } from './tile.ts';

const SPECS = [
  { src: '/img/cases/iphone-16-pro_clear_mag_1.svg', rank: 1 },
  { src: '/img/cases/galaxy-s25_black_mag_1.svg', rank: 2 },
  { src: '/img/cases/iphone-16-pro-max_clear_mag_1.svg', rank: 3 },
  { src: '/img/cases/iphone-16_clear_plain_1.svg', rank: 4 },
  { src: '/img/cases/pixel-9_navy_mag_1.svg', rank: 5 },
];
const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'tile';

if (mode === 'tile') {
  const i = Number(q.get('i') ?? 0);
  const src = q.get('src');
  const spec = q.get('broken') ? { src: '/img/cases/does-not-exist.svg', rank: i + 1 } : src ? { src, rank: Number(q.get('rank') ?? 1) } : SPECS[i];
  const t = createTile(spec, () => {});
  t.canvas.style.cssText = `width:${TILE_W / 2}px;height:${TILE_H / 2}px;display:block`;
  document.body.append(t.canvas);
  setTimeout(() => { document.documentElement.dataset.ready = '1'; }, 600);
}

if (mode === 'ring') {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.style.cssText = 'width:1100px;height:700px;position:relative;background:radial-gradient(circle at 70% 20%,#10202a,#080908 60%)';
  document.body.append(host);
  let handle: any;
  const tiles = SPECS.map((s) => createTile(s, () => handle?.markDirty()));
  import('./ring-scene.ts').then(async ({ mountRing }) => {
    handle = await mountRing(host, { tiles: tiles.map((t) => t.canvas), maxDpr: 1 });
    handle.setRing(Number(q.get('pos') ?? 0));
    setTimeout(() => { handle.markDirty(); handle.render(); document.documentElement.dataset.ready = '1'; }, 800);
  });
}
