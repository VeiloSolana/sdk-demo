import type { WalletContextState } from "@solana/wallet-adapter-react";
import { relayerClient, ensureVeiloKeypair } from "./veilo";

const RELAYER_URL = (
  import.meta.env.VITE_VEILO_RELAYER_URL ?? "https://relayer-server.onrender.com"
).replace(/\/+$/, "");

const API_KEY = import.meta.env.VITE_VEILO_API_KEY ?? "";

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${RELAYER_URL}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * Authenticate with the relayer. For existing accounts, issues a
 * challenge-signature round-trip (restore). For new accounts, registers
 * directly — the relayer generates and stores the veilo keypair.
 *
 * Returns the JWT auth token and the user's veilo public key.
 */
export async function authenticate(
  wallet: WalletContextState,
): Promise<{ token: string; veiloPublicKey: string }> {
  if (!wallet.publicKey || !wallet.signMessage) {
    throw new Error("Wallet missing signMessage capability");
  }
  const publicKey = wallet.publicKey.toBase58();

  // Try challenge-based restore for existing accounts.
  const challengeData = await post("/auth/challenge", { publicKey });
  if (challengeData.challenge) {
    // Server extracts the challenge via: message.match(/Challenge: ([a-f0-9]+)/)
    const message = `Challenge: ${challengeData.challenge}`;

    const sigBytes = await wallet.signMessage(
      new TextEncoder().encode(message),
    );

    // Server's verifySignature uses tweetnacl-util.decodeBase64 — must be base64.
    const signature = btoa(String.fromCharCode(...sigBytes));

    const restoreData = await post("/auth/restore", {
      publicKey,
      signature,
      message,
    });
    if (!restoreData.token) {
      throw new Error(restoreData.error || "Restore failed");
    }
    relayerClient.setAuthToken(restoreData.token);
    const { publicKey: vkLocal } = await ensureVeiloKeypair();
    return {
      token: restoreData.token,
      veiloPublicKey: vkLocal,
    };
  }

  // No account found — register a fresh one. The relayer generates and stores
  // a server-side keypair, but we use our locally-generated one instead so
  // the private key never leaves the browser.
  const regData = await post("/auth/register", {
    username: `tutorial-${publicKey.slice(0, 6)}`,
    publicKey,
  });
  if (!regData.token) {
    throw new Error(regData.error || "Registration failed");
  }
  relayerClient.setAuthToken(regData.token);
  const { publicKey: vkLocal } = await ensureVeiloKeypair();
  return {
    token: regData.token,
    veiloPublicKey: vkLocal,
  };
}
