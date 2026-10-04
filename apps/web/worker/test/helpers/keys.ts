// Throwaway RSA key pair for JWT tests. Generated per test run; never written to disk.
export async function throwawayServiceAccount(): Promise<{ saJson: string; publicKey: CryptoKey; pem: string }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  let bin = '';
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const body = btoa(bin).replace(/.{64}/g, '$&\n');
  const pem = '-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----\n';
  const saJson = JSON.stringify({ type: 'service_account', client_email: 'robinize-test@example-project.iam.gserviceaccount.com', private_key: pem });
  return { saJson, publicKey: pair.publicKey, pem };
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
