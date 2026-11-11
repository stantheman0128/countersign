import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize, derToRaw, fromB64u, hashPayload, rawToDer, toB64u } from "../core/index.js";

test("canonical form ignores key order and whitespace", async () => {
  const a = { b: 1, a: { y: [1, 2, { k: "v" }], x: null }, c: "中文" };
  const b = JSON.parse(' { "c": "中文", "a": { "x": null, "y": [1, 2, { "k": "v" }] }, "b": 1 } ');
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize(a), '{"a":{"x":null,"y":[1,2,{"k":"v"}]},"b":1,"c":"中文"}');
  assert.equal(toB64u(await hashPayload(a)), toB64u(await hashPayload(b)));
});

test("canonical form refuses anything that could be formatted two ways", () => {
  assert.throws(() => canonicalize({ amount: 12.5 }), /safe integers/);
  assert.throws(() => canonicalize({ amount: Number.NaN }), /safe integers/);
  assert.throws(() => canonicalize({ f() {} }), /unsupported/);
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
});

test("base64url round-trips every byte value and rejects other alphabets", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromB64u(toB64u(all)), all);
  assert.equal(toB64u(Uint8Array.of(251, 255)), "-_8");
  assert.throws(() => fromB64u("a+b/"), /base64url/);
});

test("DER and raw ECDSA signatures convert both ways, including the awkward cases", () => {
  const cases = [
    new Uint8Array(64).fill(0x7f), // no padding needed
    new Uint8Array(64).fill(0xff), // high bit set: DER adds a leading zero to both integers
    Uint8Array.from({ length: 64 }, (_, i) => (i % 32 === 0 ? 0 : 0x80 + i)), // leading zero byte in r and s
    Uint8Array.from({ length: 64 }, (_, i) => (i === 31 || i === 63 ? 1 : 0)), // tiny integers
  ];
  for (const raw of cases) assert.deepEqual(derToRaw(rawToDer(raw)), raw);
  assert.throws(() => derToRaw(Uint8Array.of(0x31, 0x00)), /sequence/);
});
