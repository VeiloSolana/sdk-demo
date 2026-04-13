# Private Tip Jar — a `veilo-sdk-core` tutorial

Build a single-page React app where anyone can drop SOL or USDC into a
**shielded pool** anonymously, and the recipient later claims the funds through
the Veilo relayer. By the end you will have touched every core primitive the
SDK exposes: shielded keypairs, commitments, the Merkle tree, deposits,
encrypted notes, nullifiers, and withdrawals.

> This repo is the finished tutorial project. You can read it top-to-bottom as
> an article, or clone it and run it.

---

## What you'll build

A 2-tab dapp:

- **Tip** — connect Phantom, pick SOL or USDC, paste the recipient's shielded
  pubkey, click _Send tip_. The client proves a zero-knowledge deposit and
  saves an encrypted note for the recipient through the relayer.
- **Claim** — the recipient generates their shielded identity once, signs a
  challenge to authenticate with the relayer, sees their unspent notes, and
  clicks _Claim_ to withdraw to their Solana wallet. The on-chain withdrawal
  is submitted by the relayer — not by the recipient — so nothing links the
  original depositor to the payout.

## Prerequisites

- Node 18+
- [Phantom](https://phantom.app/) (switch to **devnet**)
- Some devnet SOL from the [Solana faucet](https://faucet.solana.com/)
- Some devnet USDC from [Circle's USDC faucet](https://faucet.circle.com/)
- Relayer credentials — you need `VITE_VEILO_API_KEY` and
  `VITE_VEILO_RELAYER_PUBKEY`. Grab them from whoever runs your relayer.
- Proving keys (see below).

---

## 1. Project setup

```bash
npm create vite@latest veilo-tip-jar -- --template react-ts
cd veilo-tip-jar
npm install veilo-sdk-core@^0.3.1 snarkjs \
  @solana/web3.js @solana/wallet-adapter-react \
  @solana/wallet-adapter-react-ui @solana/wallet-adapter-wallets \
  @solana/wallet-adapter-base bs58 buffer
```

> Pin to **`veilo-sdk-core@^0.3.1`** or later. Earlier versions emit witness


Copy `.env.example` to `.env` and fill in your relayer credentials.

### Proving keys

The deposit flow builds a Groth16 proof client-side. You need two files
under `public/circuits/transaction/`:

```
public/circuits/transaction/transaction_js/transaction.wasm   (~10 MB — witness generator)
public/circuits/transaction/transaction_final.zkey            (~100 MB — proving key)
```

Copy them from the `zk-circuits` / `privacy-program` repo's compiled output.
They are not committed here because of size.

### Vite config (important — browser polyfills)

`veilo-sdk-core` is authored for Node and assumes `crypto.randomBytes` plus a
real dynamic `import("snarkjs")`. Neither works in a vanilla Vite browser
build, so `vite.config.ts` wires up three shims:

```ts
// vite.config.ts
resolve: {
  alias: {
    buffer: "buffer",
    // Web-Crypto-backed shim for Node's `crypto.randomBytes`
    crypto: path.resolve(__dirname, "src/shims/crypto.ts"),
  },
},
optimizeDeps: {
  include: ["veilo-sdk-core", "@coral-xyz/anchor", "snarkjs"],
  esbuildOptions: {
    target: "es2022",
    // Rewrite veilo-sdk-core's `Function('return import("snarkjs")')()`
    // trick to a plain `import("snarkjs")` so Vite can actually resolve it.
    plugins: [/* see vite.config.ts in this repo */],
  },
},
```

The `crypto` shim is a 10-line file (`src/shims/crypto.ts`) that exposes
`randomBytes(size)` backed by `crypto.getRandomValues`. Without these three
pieces, the app explodes on first deposit with one of:
`randomBytes is not a function`, or
`snarkjs is required for proof generation`.

---

## 2. Wallet adapter scaffold

`src/main.tsx` wires Solana wallet-adapter around the app so we get a
`useWallet()` hook anywhere downstream, and bootstraps Poseidon once before
anything Veilo-related runs:

```tsx
import { initPoseidon } from "veilo-sdk-core";

await initPoseidon();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ConnectionProvider endpoint={endpoint}>
    <WalletProvider wallets={[new PhantomWalletAdapter()]} autoConnect>
      <WalletModalProvider>
        <App />
      </WalletModalProvider>
    </WalletProvider>
  </ConnectionProvider>,
);
```

The top-level `await initPoseidon()` is mandatory. Every Merkle/commitment/
nullifier helper in the SDK hashes with Poseidon, and the underlying wasm
table has to be loaded first — otherwise `loadTreeForMint` throws
`Poseidon not initialized` on the first deposit.

---

## 3. Bootstrapping the SDK (`src/veilo.ts`)

One module owns every long-lived Veilo object so we don't rebuild them on
every render. Note the **namespace import**: `veilo-sdk-core` declares
`"type": "commonjs"` but ships both CJS and ESM, and Vite's dep-optimizer
occasionally drops a named import through as `undefined`. Pulling everything
through a namespace side-steps that:

```ts
import * as Veilo from "veilo-sdk-core";
// @ts-expect-error snarkjs ships no types
import * as snarkjs from "snarkjs";

const {
  createVeiloProgram,
  formatInputsForSnarkjs,
  MerkleTree,
  VeiloRelayerClient,
} = Veilo;

export const connection = new Connection(import.meta.env.VITE_RPC_URL!);

export const relayerClient = new VeiloRelayerClient({
  relayerUrl: import.meta.env.VITE_VEILO_RELAYER_URL!,
  apiKey: import.meta.env.VITE_VEILO_API_KEY!,
  relayerPublicKey: import.meta.env.VITE_VEILO_RELAYER_PUBKEY!,
});

const WASM_PATH = "/circuits/transaction/transaction_js/transaction.wasm";
const ZKEY_PATH = "/circuits/transaction/transaction_final.zkey";

// Custom proof builder. Uses the SDK's `formatInputsForSnarkjs` to build the
// witness object, then hands it to snarkjs directly. This keeps the prove
// call visible in app code and avoids the SDK's bundler-hostile
// `createTransactionProver` helper, which hides its dynamic `import("snarkjs")`
// behind `Function(...)` and confuses Vite.
export const proofBuilder = async (inputs: unknown) => {
  const formatted = formatInputsForSnarkjs(inputs as any);
  const { proof } = await snarkjs.groth16.fullProve(formatted, WASM_PATH, ZKEY_PATH);
  return proof;
};

export function getProgram(wallet: WalletContextState) {
  return createVeiloProgram(connection, wallet as any, { commitment: "confirmed" });
}
```

Three things worth slowing down on:

1. **`createVeiloProgram`** — wraps Anchor with the bundled Veilo IDL and
   program ID. You never touch those constants directly.
2. **`formatInputsForSnarkjs`** — converts the SDK's strongly-typed
   `TransactionCircuitInputs` into the untyped `Record<string, any>` shape
   snarkjs wants (everything as decimal strings). As of
   `veilo-sdk-core@0.3.1` its output keys line up exactly with the signal
   names in `transaction.circom`.
3. **`VeiloRelayerClient`** — an HTTP wrapper around the relayer. It also
   NaCl-encrypts outbound `submitWithdraw` payloads to the relayer's public
   key, which is why we need `VITE_VEILO_RELAYER_PUBKEY`.

### Merkle tree reconstruction

Every deposit inserts a new leaf into a sparse Merkle tree of depth 22. The
client needs a local copy of that tree to produce valid proofs. We rebuild it
from the relayer on demand:

```ts
export async function loadTreeForMint(mintAddress: string): Promise<MerkleTree> {
  const tree = new MerkleTree(22);
  const res = await relayerClient.getMerkleTree(mintAddress);
  if (!res.success) return tree;
  for (const leaf of [...res.data.leaves].sort((a, b) => a.index - b.index)) {
    tree.insert(commitmentToBytes(leaf.commitment));
  }
  return tree;
}
```

The `commitmentToBytes` helper tries hex (with or without `0x`), then base64,
then base58 — different relayer builds emit commitments in different
encodings. All three must decode to exactly 32 bytes or `MerkleTree.insert`
will reject them.

---

## 4. Concept break — how does any of this actually work?

If you've never used a shielded pool before, here's the 90-second model:

- **Shielded keypair** — a Poseidon-derived `(privateKey, publicKey)` pair.
  The public key is your "tip-jar address"; the private key lets you spend.
  Totally separate from your Solana wallet keypair.
- **UTXO / note** — `{ amount, pubkey, blinding }` hashed into a
  **commitment**. That commitment gets inserted into the on-chain Merkle
  tree when you deposit.
- **Nullifier** — derived from `(privateKey, leafIndex, blinding)`. It's
  revealed when you spend, so the pool can mark the note spent, but it
  can't be linked back to the commitment without the private key.
- **Merkle tree** — holds every commitment ever deposited. Your ZK proof
  shows "I know a private key that unlocks a commitment in this tree" —
  without saying _which one_.
- **Relayer** — submits your withdrawal transaction so your recipient
  wallet never has to touch the pool directly. If the recipient self-submitted,
  the network would see recipient-wallet → pool, and that alone would
  correlate them with the original deposit.

Everything below is just ergonomics around those five concepts.

---

## 5. Authenticating with the relayer (`src/auth.ts`)

To query your own notes (`queryEncryptedNotes`) you need a JWT. The relayer
issues one if you sign a challenge with your Solana wallet:

```ts
const { challenge } = await relayerClient.getChallenge(walletPub);
const signature = bs58.encode(
  await wallet.signMessage(new TextEncoder().encode(challenge)),
);

try {
  const { token } = await relayerClient.restore({ walletPublicKey, challenge, signature });
  relayerClient.setAuthToken(token);
} catch {
  const { token } = await relayerClient.register({
    username: `tutorial-${walletPub.slice(0, 6)}`,
    walletPublicKey, challenge, signature,
    veiloPublicKey: shieldedPublicKey.toString(),
  });
  relayerClient.setAuthToken(token);
}
```

The tutorial tries `restore` first (returning wallet) and falls back to
`register` (new wallet). A production app would ask the user to pick a
username.

---

## 6. The Tip flow (`src/components/TipJar.tsx`)

```ts
import { deposit } from "veilo-sdk-core";

const tree = await loadTreeForMint(token.mint.toBase58());

const result = await deposit({
  program,
  depositor: wallet as any,
  amount: toBaseUnits(amount, token.decimals),
  mintAddress: token.mint,
  recipientPubkey: BigInt(recipient), // from the Claim tab
  tree,
  proofBuilder,
});
```

That single `deposit()` call:

1. Creates a fresh output UTXO owned by the recipient's shielded pubkey.
2. Builds the transaction circuit inputs (nullifiers, commitments, root).
3. Runs `proofBuilder` — ~15–30s on a modern laptop the first time
   (witness generation + Groth16 prove).
4. Submits the Anchor transaction to the privacy-pool program with your
   connected wallet as signer.
5. Returns `{ outputUTXOs, leafIndices, root }`.

The receipt panel surfaces the commitment, leaf index, and new Merkle root so
you can watch the tree grow in real time.

---

## 7. The Claim flow (`src/components/Claim.tsx`)

On mount, we load (or generate) the shielded keypair from `localStorage`:

```ts
const [kp] = useState(() => loadOrCreateKeypair());
```

`loadOrCreateKeypair` lives in `src/storage.ts` and generates a random
BN254 field element using the browser's Web Crypto (`crypto.getRandomValues`)
rather than calling the SDK's `generateKeypair` — the SDK helper imports
Node's `crypto.randomBytes` at module-load time, which doesn't exist in the
browser. **Never do this in production.** A real app should derive the
shielded key from a wallet signature or a password, so losing
`localStorage` isn't the same as losing funds.

then authenticate with the relayer and fetch encrypted notes:

```ts
const res = await relayerClient.queryEncryptedNotes({
  walletPublicKey: wallet.publicKey?.toBase58(),
});
```

The _Claim_ button sends a `submitWithdraw` to the relayer. Unlike deposit,
**withdraw is proven server-side** — the client just hands over the decrypted
note secrets (amount, blinding, private key, leaf index) NaCl-encrypted to the
relayer's public key:

```ts
const res = await relayerClient.submitWithdraw({
  notes: unspent.slice(0, 2).map((n) => JSON.parse(n.encryptedBlob)),
  recipient: wallet.publicKey.toBase58(),
  amount: "0", // "0" = withdraw the entire note balance
  userPublicKey: kp.publicKey.toString(),
  mintAddress: token.mint.toBase58(),
});
```

The response includes the withdraw amount, the change note (rejoined to the
pool), and a Solana tx signature — the recipient wallet balance goes up,
without any transaction linking back to the depositor.

---

## 8. Running it end-to-end

```bash
cp .env.example .env   # fill in relayer creds
npm run dev
```

1. Open <http://localhost:5173>, connect Phantom (devnet).
2. Go to **Claim** — your shielded tip-jar address appears. Copy it.
3. Switch to **Tip** (or open a second browser profile for a different
   Solana wallet). Pick SOL, enter `0.1`, paste the pubkey, hit _Send tip_.
   Watch the commitment + leaf index render.
4. Back on **Claim**, hit _Claim to my wallet_. The relayer returns a tx
   signature and your wallet balance increases.
5. Repeat with USDC to verify the token toggle.

## 9. Where to go next

- **Private transfers** — `relayerClient.submitPrivateTransfer(...)` routes
  funds between two shielded identities without ever touching the base layer.
- **Real key custody** — replace `loadOrCreateKeypair` with a keypair derived
  from a wallet signature or password, so losing `localStorage` isn't the
  same as losing funds.
- **Mainnet** — switch `VITE_RPC_URL`, the USDC mint, and relayer creds.

---

## Repo tour

```
src/
├── main.tsx          # Wallet-adapter providers + initPoseidon()
├── App.tsx           # Tab switcher
├── veilo.ts          # SDK bootstrap (program, prover, relayer, tree)
├── auth.ts           # Challenge → sign → JWT
├── storage.ts        # localStorage shielded keypair (Web-Crypto random)
├── tokens.ts         # SOL / USDC mint + decimals config
├── shims/
│   └── crypto.ts     # Web-Crypto-backed `randomBytes` for Node-crypto callers
└── components/
    ├── TipJar.tsx    # Deposit flow
    ├── Claim.tsx     # Withdraw flow
    ├── AddressCard.tsx
    └── WarningBanner.tsx
```

Each file is under ~120 lines and maps to exactly one concept from the
article above. Start at `veilo.ts` and follow the imports.
