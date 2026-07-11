declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    match(actual: string, expected: RegExp, message?: string): void
    ok(value: unknown, message?: string): void
  }
  export default assert
}

declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void
}

declare module "node:fs/promises" {
  export function mkdtemp(prefix: string): Promise<string>
}

declare module "node:os" {
  export function tmpdir(): string
}
