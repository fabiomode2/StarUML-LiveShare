const client = require("./client.js");
const server = require("./server.js");
const CONNECT_TIMEOUT = 500;

let am_i_hosting = false;
let am_i_connected = false;

let userPanel = null;
let updateMenuStatesFn = null;

function resetSessionState() {
  if (userPanel) userPanel.hide();
  if (updateMenuStatesFn) updateMenuStatesFn({
    ls_ss: true,
    ls_js: true,
    ls_es: false,
    ls_cs: false,
    ls_sd: false,
  }, null, null);
  am_i_connected = false;
  am_i_hosting = false;
}

function setUserPanel(panel) {
  userPanel = panel;
}

function setUpdateMenuStates(fn) {
  updateMenuStatesFn = fn;
}

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

  if (am_i_connected) {
    client.onDisconnect(handleClientDisconnect);
    if (userPanel) userPanel.show();
    if (updateMenuStatesFn) updateMenuStatesFn({
      ls_ss: false,
      ls_js: false,
      ls_es: true,
      ls_cs: true,
      ls_sd: true,
    }, null, null);
  }

  return am_i_connected;
}

async function joinSession(name, url) {
  const urlObj = new URL(url);
  const roomId = urlObj.searchParams.get("room");
  const serverUrl = urlObj.origin;

  am_i_hosting = false;
  am_i_connected = await client.connectToServer(serverUrl, name, roomId || -1);

  if (am_i_connected) {
    client.onDisconnect(handleClientDisconnect);
    if (userPanel) userPanel.show();
    if (updateMenuStatesFn) updateMenuStatesFn({
      ls_ss: false,
      ls_js: false,
      ls_es: true,
      ls_cs: true,
      ls_sd: true,
    }, null, null);
  }

  return am_i_connected;
}

function handleClientDisconnect() {
  resetSessionState();
}

function endSession() {
  if (am_i_connected) {
    client.disconnect();
  }

  if (am_i_hosting) {
    server.stopServer();
  }

  resetSessionState();
}

function getSessionLink() {
  let baseUrl = am_i_hosting
    ? server.getServerAddress()
    : client.getConnectedAddress();

  console.log(`[LS] Generating link. base: ${baseUrl}`);

  if (!baseUrl) return "";

  const roomId = client.getCurrentRoom();
  console.log(`[LS] Generating link. room id: ${roomId}`);

  if (roomId !== null && roomId !== undefined) {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set("room", roomId);
    console.log(`[LS] Generating link. final link: ${urlObj.toString()}`);

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
  setUserPanel: setUserPanel,
  setUpdateMenuStates: setUpdateMenuStates,
};
