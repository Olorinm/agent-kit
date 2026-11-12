// Optional VPC bridge to an existing egress proxy. It adds no authentication.
// Bind/publish only on a private interface and restrict sources in the firewall.
import net from 'node:net';

function port(name) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}`);
  return value;
}
const host = process.env.UPSTREAM_HOST;
const bind = process.env.LISTEN_HOST;
if (!host || !bind) throw new Error('UPSTREAM_HOST and LISTEN_HOST are required');
const upstreamPort = port('UPSTREAM_PORT');
const listenPort = port('LISTEN_PORT');
const sockets = new Set();
const server = net.createServer(client => {
  const upstream = net.connect(upstreamPort, host);
  sockets.add(client);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => { sockets.delete(client); upstream.destroy(); });
  upstream.on('close', () => client.destroy());
});
server.listen(listenPort, bind);
process.on('SIGTERM', () => {
  server.close();
  for (const socket of sockets) socket.destroy();
});
