/*
 * Ambient type declarations for optional dependencies that are imported
 * dynamically but are not installed at port time.
 */

declare module "qrcode-terminal" {
  const qrcodeTerminal: {
    generate(
      text: string,
      options?: { small?: boolean },
      callback?: (qr: string) => void,
    ): void;
  };
  export default qrcodeTerminal;
}

declare module "silk-wasm" {
  export function decode(
    input: Uint8Array,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>;
}
