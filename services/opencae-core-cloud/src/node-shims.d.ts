declare module "node:http" {
  export type IncomingMessage = {
    method?: string;
    url?: string;
    setEncoding(encoding: string): void;
    on(event: "data", callback: (chunk: string) => void): void;
    on(event: "end", callback: () => void): void;
    on(event: "error", callback: (error: Error) => void): void;
  };

  export type ServerResponse = {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body: string): void;
  };

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  ): {
    listen(port: number, callback?: () => void): void;
    listen(port: number, host: string, callback?: () => void): void;
  };
}

declare module "node:child_process" {
  export function execFile(
    command: string,
    args: string[],
    options: { timeout?: number },
    callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
  ): void;
}

declare module "node:fs/promises" {
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string | Uint8Array, encoding?: "utf8"): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function join(...parts: string[]): string;
}

type Buffer = Uint8Array;

declare const Buffer: {
  from(value: string, encoding: "base64"): Uint8Array;
  from(value: Uint8Array): { toString(encoding: "utf8"): string };
};

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
};
