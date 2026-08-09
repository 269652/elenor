import { describe, expect, it } from 'vitest';
import { generateRoomCode, isPlausibleRoomCode, normalizeRoomCode, peerIdToRoomCode, roomCodeToPeerId } from '../protocol';

describe('generateRoomCode', () => {
  it('produces a 5-character code from the unambiguous alphabet only (no 0/O/1/I/L)', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(5);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    }
  });

  it('is not the same code every call (sanity check it is actually randomized)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateRoomCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('normalizeRoomCode / isPlausibleRoomCode', () => {
  it('normalizes casing and surrounding whitespace', () => {
    expect(normalizeRoomCode('  abcde  ')).toBe('ABCDE');
    expect(normalizeRoomCode('AbCdE')).toBe('ABCDE');
  });

  it('accepts a well-formed code regardless of input casing/whitespace', () => {
    expect(isPlausibleRoomCode('ABCDE')).toBe(true);
    expect(isPlausibleRoomCode('abcde')).toBe(true);
    expect(isPlausibleRoomCode('  aBcDe  ')).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(isPlausibleRoomCode('ABCD')).toBe(false);
    expect(isPlausibleRoomCode('ABCDEF')).toBe(false);
    expect(isPlausibleRoomCode('')).toBe(false);
  });

  it('rejects characters outside the room-code alphabet, including the excluded ambiguous ones', () => {
    expect(isPlausibleRoomCode('ABCD0')).toBe(false); // 0 excluded
    expect(isPlausibleRoomCode('ABCDO')).toBe(false); // O excluded
    expect(isPlausibleRoomCode('ABCD1')).toBe(false); // 1 excluded
    expect(isPlausibleRoomCode('ABCDI')).toBe(false); // I excluded
    expect(isPlausibleRoomCode('ABCDL')).toBe(false); // L excluded
    expect(isPlausibleRoomCode('AB-DE')).toBe(false); // punctuation
  });

  it('every generated code is itself plausible (round-trip sanity)', () => {
    for (let i = 0; i < 50; i++) expect(isPlausibleRoomCode(generateRoomCode())).toBe(true);
  });
});

describe('roomCodeToPeerId / peerIdToRoomCode', () => {
  it('round-trips a code through the peer-id prefix', () => {
    const code = generateRoomCode();
    expect(peerIdToRoomCode(roomCodeToPeerId(code))).toBe(code);
  });

  it('normalizes casing when converting to a peer id', () => {
    expect(roomCodeToPeerId('abcde')).toBe(roomCodeToPeerId('ABCDE'));
  });

  it('returns null for a peer id that is not one of ours — the public PeerJS broker is a shared namespace', () => {
    expect(peerIdToRoomCode('some-unrelated-apps-peer-id')).toBeNull();
    expect(peerIdToRoomCode('')).toBeNull();
  });
});
