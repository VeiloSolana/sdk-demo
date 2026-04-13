import type { WalletContextState } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { relayerClient } from "./veilo";

/**
 * Sign the relayer's challenge with the connected wallet, then register or
 * restore. Returns a JWT that the relayer client uses to authorize
 * `queryEncryptedNotes` calls.
 *
 * Tutorial note: we try `restore` first (existing account) and fall back to
 * `register` with an auto-generated username. A real app would prompt.
 */
export async function authenticate(
  wallet: WalletContextState,
  shieldedPublicKey: bigint,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signMessage) {
    throw new Error("Wallet missing signMessage capability");
  }
  const walletPub = wallet.publicKey.toBase58();

  const { challenge } = await relayerClient.getChallenge(walletPub);
  const sigBytes = await wallet.signMessage(new TextEncoder().encode(challenge));
  const signature = bs58.encode(sigBytes);

  try {
    const res = await relayerClient.restore({
      walletPublicKey: walletPub,
      challenge,
      signature,
    });
    relayerClient.setAuthToken(res.token);
    return res.token;
  } catch {
    // New wallet — register a fresh account.
    const res = await relayerClient.register({
      username: `tutorial-${walletPub.slice(0, 6)}`,
      walletPublicKey: walletPub,
      challenge,
      signature,
      veiloPublicKey: shieldedPublicKey.toString(),
    });
    relayerClient.setAuthToken(res.token);
    return res.token;
  }
}
