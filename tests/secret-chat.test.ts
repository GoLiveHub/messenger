import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateKeyPair,
  exportPublicKey,
  deriveSharedKey,
  setupSecretSession,
  ratchetStep,
  chainKeyToAes,
  encryptSecret,
  decryptSecret,
} from '../src/crypto/e2e';

// Simulates two clients running the real secret-chat protocol. Because the
// static-ECDH root key is symmetric and the KDF-chain roles are assigned
// deterministically by user id, both clients must derive a session in which
// A's send chain equals B's receive chain and vice versa, regardless of who
// sends first or how many messages flow in each direction.
test('secret chat: two sides exchange >=2 messages in each direction', async () => {
  const alice = await generateKeyPair();
  const bob = await generateKeyPair();
  const alicePub = await exportPublicKey(alice.publicKey);
  const bobPub = await exportPublicKey(bob.publicKey);

  const aliceRoot = await deriveSharedKey(alice.privateKey, bobPub);
  const bobRoot = await deriveSharedKey(bob.privateKey, alicePub);

  const aliceSession = await setupSecretSession(aliceRoot, 1, 2);
  const bobSession = await setupSecretSession(bobRoot, 2, 1);

  // Helper that encrypts one message on a sender using its live session.
  const send = async (
    session: { sendKey: Uint8Array },
    plain: string,
  ): Promise<{ cipher: string; iv: string; nextSendKey: Uint8Array }> => {
    const { chainKey: nextSendKey, messageKey } = await ratchetStep(session.sendKey);
    const enc = await encryptSecret(messageKey, plain);
    return { cipher: enc.cipher, iv: enc.iv, nextSendKey };
  };

  // Helper that decrypts one received message, advancing the receiver chain.
  const recv = async (
    session: { recvKey: Uint8Array },
    cipher: string,
    iv: string,
  ): Promise<{ plain: string; nextRecvKey: Uint8Array }> => {
    const recvAes = await chainKeyToAes(session.recvKey);
    const { chainKey: nextRecvKey } = await ratchetStep(session.recvKey);
    const plain = await decryptSecret(recvAes, cipher, iv);
    return { plain, nextRecvKey };
  };

  // Alice sends 2 messages to Bob.
  const a1 = await send(aliceSession, 'Alice 1');
  const a2 = await send({ sendKey: a1.nextSendKey }, 'Alice 2');

  // Bob receives both in order, verifying his receive chain lines up with
  // Alice's send chain.
  const b1 = await recv(bobSession, a1.cipher, a1.iv);
  assert.equal(b1.plain, 'Alice 1');
  const b2 = await recv({ recvKey: b1.nextRecvKey }, a2.cipher, a2.iv);
  assert.equal(b2.plain, 'Alice 2');

  // Bob replies with 2 messages to Alice.
  const bobMsg1 = await send(bobSession, 'Bob 1');
  const bobMsg2 = await send({ sendKey: bobMsg1.nextSendKey }, 'Bob 2');

  // Alice (lower id) receives on the chain Bob sends on.
  const aliceGot1 = await recv(aliceSession, bobMsg1.cipher, bobMsg1.iv);
  assert.equal(aliceGot1.plain, 'Bob 1');
  const aliceGot2 = await recv({ recvKey: aliceGot1.nextRecvKey }, bobMsg2.cipher, bobMsg2.iv);
  assert.equal(aliceGot2.plain, 'Bob 2');

  // Cross-check: a third message from Alice must still decrypt (chains stay in
  // sync after going back and forth).
  const a3 = await send({ sendKey: a2.nextSendKey }, 'Alice 3');
  const b3 = await recv({ recvKey: b2.nextRecvKey }, a3.cipher, a3.iv);
  assert.equal(b3.plain, 'Alice 3');
});
