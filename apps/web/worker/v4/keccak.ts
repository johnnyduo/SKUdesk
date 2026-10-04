// Keccak-256 (the Ethereum variant: original Keccak padding 0x01, not SHA3's 0x06) over bytes, BigInt lanes.
// Small and dependency-free: the Worker hashes at most two 64-128 byte inputs per pool config, so speed is moot.
// Checked against viem's keccak256 in worker/test/v4pool.test.ts.
const MASK64 = (1n << 64n) - 1n;
const RATE = 136; // bytes, for a 256-bit output
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// rotation offsets r[x + 5y]
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

const rotl = (v: bigint, n: number): bigint => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64);

function permute(a: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) a[x + y] = b[x + y] ^ ((b[((x + 1) % 5) + y] ^ MASK64) & b[((x + 2) % 5) + y]);
    }
    a[0] ^= RC[round];
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.floor(data.length / RATE + 1) * RATE);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      a[i] ^= lane;
    }
    permute(a);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = a[i];
    for (let k = 0; k < 8; k++) { out[i * 8 + k] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '0x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

export const keccak256Hex = (hex: string): string => bytesToHex(keccak256(hexToBytes(hex)));
