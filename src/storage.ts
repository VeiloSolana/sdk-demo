const KEY = "veilo-tutorial:shielded-keypair";

/**
 * Load the veilo public key persisted from a previous registration.
 * Returns null if the user has never registered (or has reset).
 */
export function loadStoredPublicKey(): string | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as { veiloPublicKey?: string };
    return stored.veiloPublicKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist the relayer-assigned veilo public key so the tip-jar address
 * survives page reloads.
 */
export function saveVeiloPublicKey(veiloPublicKey: string): void {
  localStorage.setItem(KEY, JSON.stringify({ veiloPublicKey }));
}

export function resetKeypair(): void {
  localStorage.removeItem(KEY);
}
