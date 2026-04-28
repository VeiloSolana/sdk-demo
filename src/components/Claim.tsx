import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { loadStoredPrivateKey, resetKeypair } from "../storage";
import { authenticate } from "../auth";
import { relayerClient, ensureVeiloKeypair, bigIntToBytesBE, getVeiloNaclPublicKey, decryptNoteBlob } from "../veilo";
import { TOKENS, TokenId, fromBaseUnits } from "../tokens";
import AddressCard from "./AddressCard";

interface ClaimReceipt { txSignature?: string; withdrew: string; change: string }

export default function Claim() {
  const wallet = useWallet();
  const [veiloPublicKey, setVeiloPublicKey] = useState<string | null>(null);
  const [veiloPrivateKey, setVeiloPrivateKey] = useState<string | null>(null);
  const [tipJarAddress, setTipJarAddress] = useState<string | null>(null);
  const [tokenId, setTokenId] = useState<TokenId>("SOL");
  const [noteCount, setNoteCount] = useState<number | null>(null);
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ClaimReceipt | null>(null);

  // Generate (or load) the local veilo keypair and authenticate with the
  // relayer the moment a wallet is connected.
  useEffect(() => {
    if (!wallet.publicKey || authed) return;
    (async () => {
      try {
        const kp = await ensureVeiloKeypair();
        setVeiloPublicKey(kp.publicKey);
        setVeiloPrivateKey(kp.privateKey);
        const naclPubKey = getVeiloNaclPublicKey(BigInt(kp.privateKey));
        setTipJarAddress(`${kp.publicKey}|${naclPubKey}|${wallet.publicKey!.toBase58()}`);
        await authenticate(wallet);
        setAuthed(true);
      } catch (e: any) {
        setError(`Auth failed: ${e.message ?? e}`);
      }
    })();
  }, [wallet.publicKey, authed, wallet]);

  // Once authenticated, count encrypted notes addressed to this tip-jar key.
  useEffect(() => {
    if (!authed || !veiloPublicKey) return;
    (async () => {
      try {
        const res = await relayerClient.queryEncryptedNotes({
          walletPublicKey: wallet.publicKey?.toBase58(),
        });
        const myUnspent = res.notes.filter((n) => {
          if (n.spent || !veiloPrivateKey) return false;
          try {
            const blob = decryptNoteBlob(n.ephemeralPublicKey, n.encryptedBlob, BigInt(veiloPrivateKey)) as any;
            return blob.recipientVeiloPublicKey === veiloPublicKey;
          } catch {
            return false;
          }
        });
        setNoteCount(myUnspent.length);
      } catch (e: any) {
        setError(`Query failed: ${e.message ?? e}`);
      }
    })();
  }, [authed, veiloPublicKey, wallet.publicKey]);

  async function handleClaim() {
    setError(null);
    setReceipt(null);
    if (!wallet.publicKey || !veiloPublicKey) return;
    setBusy(true);
    try {
      const token = TOKENS[tokenId];
      const myVpk = veiloPublicKey;

      const notesRes = await relayerClient.queryEncryptedNotes({
        walletPublicKey: wallet.publicKey.toBase58(),
      });

      // Filter to notes deposited for our tip-jar address and decrypt blobs.
      const storedPrivKey = loadStoredPrivateKey()!;
      const privKeyBigInt = BigInt(storedPrivKey);
      const privKeyBytes = bigIntToBytesBE(privKeyBigInt);
      const privateKeyHex = Array.from(privKeyBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      type DecryptedBlob = { commitment: string; blinding: string; amount: string; leafIndex: number; recipientVeiloPublicKey: string };
      const unspent: Array<{ note: typeof notesRes.notes[0]; blob: DecryptedBlob }> = [];
      for (const n of notesRes.notes) {
        if (n.spent) continue;
        try {
          const blob = decryptNoteBlob(n.ephemeralPublicKey, n.encryptedBlob, privKeyBigInt) as DecryptedBlob;
          if (blob.recipientVeiloPublicKey === myVpk) unspent.push({ note: n, blob });
        } catch {
          // Note not for us or old format — skip.
        }
      }
      if (unspent.length === 0)
        throw new Error("No unspent notes for this tip-jar address");

      // Build the TransactNote array the relayer expects. The nullifier field
      // is required by the type but the relayer recomputes it from
      // (commitment, leafIndex, privateKey) — a dummy value is safe here.
      const transactNotes = unspent.slice(0, 2).map(({ note, blob }) => ({
        commitment: blob.commitment,
        privateKey: privateKeyHex,
        publicKey: myVpk,
        blinding: blob.blinding,
        amount: blob.amount,
        nullifier: "00".repeat(32),
        leafIndex: blob.leafIndex,
        noteId: note.noteId,
      }));

      const res = await relayerClient.submitWithdraw({
        notes: transactNotes,
        recipient: wallet.publicKey.toBase58(),
        amount: "0", // 0 = withdraw full note value
        userPublicKey: myVpk,
        mintAddress: token.mint.toBase58(),
      });

      if (!res.data) throw new Error(res.message);
      setReceipt({
        txSignature: res.data.txSignature,
        withdrew: fromBaseUnits(BigInt(res.data.withdrawAmount), token.decimals),
        change: fromBaseUnits(BigInt(res.data.changeAmount), token.decimals),
      });
    } catch (e: any) {
      console.error(e);
      setError(e.message ?? "Claim failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <AddressCard label="Your tip-jar address (share this)" address={tipJarAddress ?? "…"} />

      <div className="row">
        <label>Token to claim</label>
        <select value={tokenId} onChange={(e) => setTokenId(e.target.value as TokenId)}>
          <option value="SOL">SOL</option>
          <option value="USDC">USDC</option>
        </select>
      </div>

      <div className="kv">
        <span>Relayer auth</span>
        <span className="mono">{authed ? "✓ signed in" : "…"}</span>
      </div>
      <div className="kv">
        <span>Unspent notes</span>
        <span className="mono">{noteCount ?? "—"}</span>
      </div>

      <button
        className="primary"
        onClick={handleClaim}
        disabled={busy || !authed || !wallet.publicKey}
        style={{ marginTop: 14 }}
      >
        {busy ? "Claiming…" : "Claim to my wallet"}
      </button>

      <button
        className="primary"
        style={{ background: "transparent", color: "#ff9" }}
        onClick={() => {
          resetKeypair();
          window.location.reload();
        }}
      >
        Reset tip-jar identity
      </button>

      {error && <div className="status err">{error}</div>}
      {receipt && (
        <div className="status">
          <div className="kv"><span>Withdrew</span><span>{receipt.withdrew} {tokenId}</span></div>
          <div className="kv"><span>Change (back to pool)</span><span>{receipt.change} {tokenId}</span></div>
          {receipt.txSignature && (
            <div className="kv"><span>Tx</span><span className="mono">{receipt.txSignature.slice(0, 18)}…</span></div>
          )}
        </div>
      )}
    </div>
  );
}
