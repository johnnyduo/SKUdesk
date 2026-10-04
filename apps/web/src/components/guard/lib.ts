// Small formatting helpers shared by the guard pages. No data lives here.
export const pctClean = (bps: number | string) => {
  const v = Number(bps) / 100;
  return (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2).replace(/0+$/, '')) + '%';
};
export const secs = (ms: number) => (ms / 1000).toFixed(1) + ' s';
