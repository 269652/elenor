import { customAlphabet } from 'nanoid';

// Base32-ish, ambiguous characters (0/O, 1/I/L) excluded, per docs/architecture.md §8.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const generate = customAlphabet(ALPHABET, 6);

export function generateRoomCode(): string {
  return generate();
}
