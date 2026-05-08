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
  };
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
};
