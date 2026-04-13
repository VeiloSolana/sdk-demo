const KEY = "veilo-tutorial:shielded-keypair";

export interface StoredKeypair {
  privateKey: string; // bigint as decimal string
  publicKey: string;
}

// BN254 scalar field modulus — shielded keys must live below this.
const BN254_FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randomFieldElement(): bigint {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n % BN254_FR;
}

/**
 * Tutorial-only: persist the shielded keypair in localStorage so the recipient
 * keeps the same tip-jar address across reloads. NEVER do this in production —
 * a real app should use a password-derived key or the user's wallet signature
 * to seed the shielded keypair.
 *
 * The shielded key is just a random field element — not tied to the Solana
 * wallet keypair. Veilo's protocol expects a BN254 scalar, not an ed25519 key.
 */
export function loadOrCreateKeypair(): {
  privateKey: bigint;
  publicKey: bigint;
} {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const stored = JSON.parse(raw) as StoredKeypair;
    return {
      privateKey: BigInt(stored.privateKey),
      publicKey: BigInt(stored.publicKey),
    };
  }
  const privateKey = randomFieldElement();
  const publicKey = randomFieldElement();
  const stored: StoredKeypair = {
    privateKey: privateKey.toString(),
    publicKey: publicKey.toString(),
  };
  localStorage.setItem(KEY, JSON.stringify(stored));
  return { privateKey, publicKey };
}

export function resetKeypair(): void {
  localStorage.removeItem(KEY);
}
