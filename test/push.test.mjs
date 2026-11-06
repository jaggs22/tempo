import { encryptPayload, decryptPayload, b64u, unb64u, vapidAuth, generateVapidKeys } from '../src/push.js';
import assert from 'node:assert/strict';
// RFC 8291 Appendix A
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const body = await encryptPayload(V.plaintext, V.uaPublic, V.auth, { salt: unb64u(V.salt), asKeys: { publicKey: V.asPublic, privateKey: V.asPrivate } });
const vectorMatch = b64u(body) === V.body;
console.log('RFC 8291 vector match:', vectorMatch);
// Round trip with fresh random keys, independent of the vector
const r = await decryptPayload(await encryptPayload('{"title":"Lecdem on Sunday"}', V.uaPublic, V.auth), V.uaPrivate, V.uaPublic, V.auth);
assert.equal(r, '{"title":"Lecdem on Sunday"}'); console.log('round trip ok');
// Vector decrypts too
assert.equal(await decryptPayload(unb64u(V.body), V.uaPrivate, V.uaPublic, V.auth), V.plaintext); console.log('vector decrypts ok');
const k = await generateVapidKeys(); const h = await vapidAuth('https://fcm.googleapis.com/fcm/send/x', { ...k, subject: 'mailto:a@b.c' });
assert.match(h, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/); console.log('vapid header ok');
assert.ok(vectorMatch, 'vector mismatch');
