declare const process: {
  argv: string[]
  cwd(): string
  execPath: string
  exitCode?: number
  env: Record<string, string | undefined>
  pid: number
}

declare module "node:child_process" {
  export function execFile(
    file: string,
    args: readonly string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void
}

declare module "node:fs/promises" {
  export function appendFile(
    path: string,
    data: string,
    options?: { encoding?: "utf8"; mode?: number },
  ): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>
  export function readFile(path: string, encoding: "utf8"): Promise<string>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function writeFile(
    path: string,
    data: string,
    options?: { encoding?: "utf8"; mode?: number },
  ): Promise<void>
}

declare module "node:fs" {
  export function appendFileSync(path: string, data: string): void
  export function readFileSync(path: string, encoding: "utf8"): string
}

declare module "node:path" {
  export function dirname(path: string): string
  export function isAbsolute(path: string): boolean
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
}
