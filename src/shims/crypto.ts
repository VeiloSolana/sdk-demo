// Minimal browser shim for the Node `crypto` module.
// veilo-sdk-core calls `randomBytes` internally; the default Vite browser
// resolution of `crypto` is an empty module, which is why it explodes at
// runtime with "randomBytes is not a function".

export function randomBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  crypto.getRandomValues(buf);
  return buf;
}

export default { randomBytes };
