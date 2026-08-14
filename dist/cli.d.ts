#!/usr/bin/env node
/** Run the plugin-owned Linux control CLI. */
declare function run(argv: readonly string[]): Promise<number>;

export { run };
