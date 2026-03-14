const client = require("./client.js");
const server = require("./server.js");
const CONNECT_TIMEOUT = 500;

let am_i_hosting = false;
let am_i_connected = false;

async function startSession(name, type, relay) {
  //  TODO: TYPE AND RELAY. RIGHT NOW ONLY LANs WORK
  am_i_hosting = server.startServer(server.defaultPort);
  am_i_connected = await client.connectToServer(
    server.getServerAddress(),
    name,
  );

  return am_i_connected && am_i_hosting;
}

async function joinSession(name, url) {
  am_i_hosting = false;
  am_i_connected = await client.connectToServer(url, name);

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
  if (am_i_hosting) return server.getServerAddress();
  if (am_i_hosting) return client.getConnectedAddress();
}

module.exports = {
  startSession: startSession,
  joinSession: joinSession,
  endSession: endSession,
  getSessionLink: getSessionLink,
};
