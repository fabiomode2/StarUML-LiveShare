const fachada = require("./js/fachada.js");
const server = require("./js/server.js");

async function startSession() {
  app.toast.info("Start session");
  console.log(app);
  console.log(app.diagrams.getZoomLevel());

  const data = await fachada.showSS();

  console.log("await resuelto");
  if (!data) return;

  server.startServer(server.defaultPort);

  app.menu.updateStates(
    // hide start-session and join-session, show end-session and copy-session-link
    {
      ls_ss: false,
      ls_js: false,
      ls_es: true,
      ls_cs: true,
    },
    null,
    null,
  );
}

async function joinSession() {
  app.toast.info("Join session");

  const data = await fachada.showJS();
  if (!data) return;

  server.connectToServer(data.address, data.name);

  app.menu.updateStates(
    // hide start-session and join-session, show end-session and copy-session-link
    {
      ls_ss: true,
      ls_js: true,
      ls_es: true,
      ls_cs: true,
    },
    null,
    null,
  );
}

async function endSession() {
  server.stopServer();

  app.menu.updateStates(
    {
      ls_ss: true,
      ls_js: true,
      ls_es: false,
      ls_cs: false,
    },
    null,
    null,
  );
}

async function copySessionLink() {
  navigator.clipboard
    .writeText(server.getSessionLink())
    .then(() => {
      fachada.INFO("Session link copied!");
    })
    .catch((err) => {
      console.error("Error copying with navigator:", err);
      fachada.ERR("Could copy. the link is: " + server.getSessionLink());
    });
}

function init() {
  app.commands.register("liveshare:ss", startSession);
  app.commands.register("liveshare:js", joinSession);
  app.commands.register("liveshare:cs", copySessionLink);
  app.commands.register("liveshare:es", endSession);
}
exports.init = init;
