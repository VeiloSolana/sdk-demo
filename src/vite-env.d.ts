/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_VEILO_RELAYER_URL?: string;
  readonly VITE_VEILO_API_KEY?: string;
  readonly VITE_VEILO_RELAYER_PUBKEY?: string;
  readonly VITE_USDC_MINT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
