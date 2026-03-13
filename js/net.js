const client = require("./client.js");
const server = require("./server.js");

let am_i_hosting = false;
let am_i_connected = false;

function startSession(name, type, relay) {
  //  TODO: TYPE AND RELAY. RIGHT NOW ONLY LANs WORK
  am_i_hosting = server.startServer(server.defaultPort);
  am_i_connected = client.connectToServer(server.getServerAddress(), name);

  console.log(`hosting?: ${am_i_hosting}, connected?: ${am_i_connected}`);
  return am_i_connected && am_i_hosting;
}

function joinSession(name, url) {
  am_i_hosting = false;
  am_i_connected = client.connectToServer(url, name);

  return am_i_connected;
}

function endSession() {
  if (am_i_connected) {
    client.disconnect();
  }

  if (am_i_hosting) {
    server.stopServer();
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
