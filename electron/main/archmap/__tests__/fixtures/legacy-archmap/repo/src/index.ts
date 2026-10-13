import { add } from './math';
import { greet } from './greet';
export function main(): string { return greet(String(add(1, 2))); }
