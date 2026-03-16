const client = require("./client.js");
const server = require("./server.js");
const CONNECT_TIMEOUT = 500;

let am_i_hosting = false;
let am_i_connected = false;

async function startSession(name, type, server) {
  if (server) am_i_hosting = client.connectToServer(server, name, -1);
  else am_i_hosting = server.startServer(server.defaultPort);
  am_i_connected = await client.connectToServer(
    server.getServerAddress(),
    name,
  );

  return am_i_connected && am_i_hosting;
}

async function joinSession(name, url) {
  const urlObj = new URL(url);
  const roomId = urlObj.searchParams.get("room");
  const serverUrl = urlObj.origin;

  am_i_hosting = false;
  am_i_connected = await client.connectToServer(serverUrl, name, roomId || -1);

  return am_i_connected;
}

function endSession() {
  if (am_i_connected) {
    client.disconnect();
    am_i_connected = false;
  }

  if (am_i_hosting) {
    server.stopServer();
    am_i_hosting = false;
  }
}

function getSessionLink() {
  let baseUrl = am_i_hosting
    ? server.getServerAddress()
    : client.getConnectedAddress();
  if (!baseUrl) return "";

  // Si soy el host, mi ID de socket suele ser el ID de la sala inicial
  // pero lo ideal es que el servidor te confirme el room_id exacto.
  // Por ahora, si la URL no tiene la sala, podrías concatenarla.
  return baseUrl;
}

function syncDoc() {
  if (!am_i_connected) return;
  client.requestDocument();
}

module.exports = {
  startSession: startSession,
  joinSession: joinSession,
  endSession: endSession,
  getSessionLink: getSessionLink,
  syncDoc: syncDoc,
};
