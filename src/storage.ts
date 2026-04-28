const KEY = "veilo-tutorial:shielded-keypair";

interface StoredKeypair {
  privateKey: string; // BigInt decimal string
  publicKey: string;  // BigInt decimal string
}

export function loadStoredKeypair(): StoredKeypair | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredKeypair>;
    if (stored.privateKey && stored.publicKey) return stored as StoredKeypair;
    return null;
  } catch {
    return null;
  }
}

export function loadStoredPublicKey(): string | null {
  return loadStoredKeypair()?.publicKey ?? null;
}

export function loadStoredPrivateKey(): string | null {
  return loadStoredKeypair()?.privateKey ?? null;
}

export function saveKeypair(keypair: StoredKeypair): void {
  localStorage.setItem(KEY, JSON.stringify(keypair));
}

export function resetKeypair(): void {
  localStorage.removeItem(KEY);
}
