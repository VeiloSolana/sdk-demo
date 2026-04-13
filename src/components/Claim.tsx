import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { loadOrCreateKeypair, resetKeypair } from "../storage";
import { authenticate } from "../auth";
import { relayerClient } from "../veilo";
import { TOKENS, TokenId, fromBaseUnits } from "../tokens";
import AddressCard from "./AddressCard";

interface ClaimReceipt { txSignature?: string; withdrew: string; change: string }

export default function Claim() {
  const wallet = useWallet();
  const [kp] = useState(() => loadOrCreateKeypair());
  const [tokenId, setTokenId] = useState<TokenId>("SOL");
  const [noteCount, setNoteCount] = useState<number | null>(null);
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ClaimReceipt | null>(null);

  // Authenticate with the relayer the moment a wallet is connected.
  useEffect(() => {
    if (!wallet.publicKey || authed) return;
    (async () => {
      try {
        await authenticate(wallet, kp.publicKey);
        setAuthed(true);
      } catch (e: any) {
        setError(`Auth failed: ${e.message ?? e}`);
      }
    })();
  }, [wallet.publicKey, authed, wallet, kp.publicKey]);

  // Once authenticated, pull the recipient's encrypted notes. In a real app
  // you would decrypt + filter them client-side with the shielded privkey;
  // for the tutorial we just surface the count as a "balance" proxy.
  useEffect(() => {
    if (!authed) return;
    (async () => {
      try {
        const res = await relayerClient.queryEncryptedNotes({
          walletPublicKey: wallet.publicKey?.toBase58(),
        });
        setNoteCount(res.notes.filter((n) => !n.spent).length);
      } catch (e: any) {
        setError(`Query failed: ${e.message ?? e}`);
      }
    })();
  }, [authed, wallet.publicKey]);

  async function handleClaim() {
    setError(null);
    setReceipt(null);
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      const token = TOKENS[tokenId];
      const notes = await relayerClient.queryEncryptedNotes({
        walletPublicKey: wallet.publicKey.toBase58(),
      });
      const unspent = notes.notes.filter((n) => !n.spent);
      if (unspent.length === 0) throw new Error("No unspent notes for this wallet");

      // The relayer does the proving server-side. Client only supplies the
      // note secrets encrypted under the relayer's NaCl public key — see
      // VeiloRelayerClient.submitWithdraw in the SDK.
      const res = await relayerClient.submitWithdraw({
        // NOTE: the tutorial hands over the commitment + nullifier material
        // straight from the decrypted blobs. In production you would decrypt
        // with the shielded privkey here before sending.
        notes: unspent.slice(0, 2).map((n) => JSON.parse(n.encryptedBlob)),
        recipient: wallet.publicKey.toBase58(),
        amount: "0", // 0 = withdraw full note value
        userPublicKey: kp.publicKey.toString(),
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
      <AddressCard label="Your tip-jar address (share this)" address={kp.publicKey.toString()} />

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
