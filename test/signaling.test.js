import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../server.js';

let server;
let url;
let roomCounter = 0;
const sockets = [];

before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${server.address().port}/ws`;
});

after(() => {
  sockets.forEach((ws) => ws.terminate());
  server.close();
});

const newRoom = () => `sala-de-teste-${String(++roomCounter).padStart(4, '0')}`;

async function connect() {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  const closed = new Promise((resolve) => ws.once('close', resolve));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    send: (message) => ws.send(JSON.stringify(message)),
    next: () => (inbox.length
      ? Promise.resolve(inbox.shift())
      : new Promise((resolve) => waiters.push(resolve))),
    closed: () => closed,
  };
}

async function join(room, clientId) {
  const client = await connect();
  client.send({ type: 'join', room, clientId });
  return { client, joined: await client.next() };
}

test('quem entra primeiro espera, e o segundo encontra o primeiro', async () => {
  const room = newRoom();
  const first = await join(room, 'cliente-a');
  assert.equal(first.joined.peerId, null);
  assert.ok(first.joined.iceServers.length > 0);

  const second = await join(room, 'cliente-b');
  assert.equal(second.joined.peerId, 'cliente-a');
  assert.deepEqual(await first.client.next(), { type: 'peer-joined', peerId: 'cliente-b' });
});

test('repassa sinais só para o outro membro da sala', async () => {
  const room = newRoom();
  const a = await join(room, 'cliente-a');
  const b = await join(room, 'cliente-b');
  await a.client.next();
  const outsider = await join(newRoom(), 'cliente-c');

  a.client.send({ type: 'signal', data: { hello: 1 } });
  assert.deepEqual(await b.client.next(), { type: 'signal', from: 'cliente-a', data: { hello: 1 } });

  outsider.client.send({ type: 'signal', data: { hello: 2 } });
  b.client.send({ type: 'signal', data: { hello: 3 } });
  assert.deepEqual(await a.client.next(), { type: 'signal', from: 'cliente-b', data: { hello: 3 } });
});

test('recusa a terceira pessoa', async () => {
  const room = newRoom();
  await join(room, 'cliente-a');
  await join(room, 'cliente-b');
  const third = await join(room, 'cliente-c');
  assert.equal(third.joined.type, 'full');
  await third.client.closed();
});

test('avisa quando o outro sai e libera a vaga', async () => {
  const room = newRoom();
  const a = await join(room, 'cliente-a');
  const b = await join(room, 'cliente-b');
  await a.client.next();

  b.client.ws.close();
  assert.deepEqual(await a.client.next(), { type: 'peer-left', peerId: 'cliente-b' });

  const c = await join(room, 'cliente-c');
  assert.equal(c.joined.type, 'joined');
  assert.equal(c.joined.peerId, 'cliente-a');
});

test('reconectar com o mesmo id assume a vaga sem avisar saída', async () => {
  const room = newRoom();
  const a = await join(room, 'cliente-a');
  const b = await join(room, 'cliente-b');
  await a.client.next();

  const closing = b.client.closed();
  const returned = await join(room, 'cliente-b');
  await closing;
  assert.equal(returned.joined.peerId, 'cliente-a');
  assert.deepEqual(await a.client.next(), { type: 'peer-joined', peerId: 'cliente-b' });

  a.client.send({ type: 'signal', data: { hello: 1 } });
  assert.deepEqual(await returned.client.next(), { type: 'signal', from: 'cliente-a', data: { hello: 1 } });
});

test('fecha a conexão com sala inválida ou JSON quebrado', async () => {
  const invalid = await connect();
  const closing = invalid.closed();
  invalid.send({ type: 'join', room: '../etc', clientId: 'cliente-a' });
  assert.equal(await closing, 1008);

  const broken = await connect();
  const brokenClosing = broken.closed();
  broken.ws.send('{não é json');
  assert.equal(await brokenClosing, 1003);
});

test('só serve os arquivos da lista', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
});
