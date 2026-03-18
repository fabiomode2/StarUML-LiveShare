const client = require("./client.js");
const server = require("./server.js");
const CONNECT_TIMEOUT = 500;

let am_i_hosting = false;
let am_i_connected = false;

async function startSession(name, type, remoteServer) {
  if (remoteServer) {
    am_i_hosting = false;
    am_i_connected = await client.connectToServer(remoteServer, name, -1);
  } else {
    am_i_hosting = server.startServer(server.defaultPort);
    am_i_connected = await client.connectToServer(
      server.getServerAddress(),
      name,
    );
  }

  return am_i_connected;
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

  console.log(`Generando enlace. Base: ${baseUrl}`);

  if (!baseUrl) return "";

  const roomId = client.getCurrentRoom();
  console.log(`Generando enlace. Room ID: ${roomId}`);

  if (roomId) {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set("room", roomId);
    console.log(`Generando enlace. Enlace final: ${urlObj.toString()}`);

    return urlObj.toString();
  }

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
