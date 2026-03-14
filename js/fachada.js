const fs = require("fs");
const path = require("path");

function INFO(mensaje) {
  app.toast.info(mensaje);
}

function WARN(mensaje) {
  app.toast.warning(mensaje);
}

function ERR(mensaje) {
  app.toast.error(mensaje);
}

function _createDialog(templateName) {
  const dialogHTML = fs.readFileSync(
    path.join(__dirname, templateName),
    "utf8",
  );
  return app.dialogs.showModalDialogUsingTemplate(dialogHTML);
}
async function showSSDialog() {
  return new Promise((resolve, reject) => {
    const htmlPath = path.join("html", "ss_dialog.html");
    const dialog = _createDialog(htmlPath);
    const $el = dialog.getElement();

    $el.on("click", "#ok-btn", () => {
      const data = {
        name: $el.find("#name").val(),
        type: $el.find("#type").val(),
        network: $el.find("#network").val(),
      };

      if (data.name == "") {
        ERR("Username cant be null.");
        return null;
      }

      dialog.close();

      resolve(data);
    });

    $el.on("click", "#cancel-btn", () => {
      dialog.close();
      resolve(null);
    });
  });
}

async function showJSDialog() {
  return new Promise((resolve, reject) => {
    const htmlPath = path.join("html", "js_dialog.html");

    const dialog = _createDialog(htmlPath);
    const $el = dialog.getElement();

    $el.on("click", "#ok-btn", () => {
      const data = {
        name: $el.find("#name").val(),
        address: $el.find("#address").val(),
      };

      if (data.name === "") {
        ERR("Username can't be null.");
        return;
      }

      if (!data.address.startsWith("http")) {
        data.address = "http://" + data.address;
      }

      dialog.close();
      resolve(data);
    });

    $el.on("click", "#cancel-btn", () => {
      dialog.close();
      resolve(null);
    });
  });
}

let originalHandlers = {};

function changeKeyBindings(host) {
  const forbidden = [
    "project:new",
    "project:open",
    // "project:save",
    // "project:save-as",
    "project:import-fragment",
    "project:close",
    "project:open-recent",
  ];

  forbidden.forEach((cmdId) => {
    if (app.commands.commands[cmdId] && !originalHandlers[cmdId]) {
      originalHandlers[cmdId] = app.commands.commands[cmdId];
    }

    if (host == false) {
      //disable for clients
      app.commands.commands[cmdId] = () => {
        WARN("Only host can manage files.");
        console.log(`[LiveShare] Blocking: ${cmdId}`);
      };
    } else {
      //enable for host
      app.commands.commands[cmdId] = originalHandlers[cmdId];
    }
  });
}

function changeHostOptions(state) {
  const menuStates = {
    "file.new": state,
    "file.open": state,
    // "file.save": state,
    // "file.save-as": state,
    "file.import": state,
    "file.export-diagram-to-png": state,
    "file.export-diagram-to-svg": state,
    "file.export-diagram-to-pdf": state,
    "file.close": state,
    "file.open-recent": state,
    "file.new-from-template": state,
  };

  try {
    // updateStates(visible, enabled, checked)
    app.menu.updateStates(null, menuStates, null);
  } catch (e) {
    console.error("[LiveShare] Error updating menu states:", e);
  }
}

function restoreHostOptions() {
  for (let cmdId in originalHandlers) {
    app.commands.commands[cmdId] = originalHandlers[cmdId];
  }
  originalHandlers = {};

  // Ponemos los menús otra vez en true
  app.menu.updateStates(null, null, null); // Un update vacío suele refrescar al estado original
}

function disableHostOptions() {
  changeHostOptions(false);
  changeKeyBindings(false);
}

function enableHostOptions() {
  changeHostOptions(true);
  changeKeyBindings(true);
}

function showLoadingOverlay() {
  let overlay = document.createElement("div");
  overlay.id = "my-extension-loading";

  overlay.style.position = "fixed";
  overlay.style.top = "0";
  overlay.style.left = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.background = "rgba(0,0,0,0.4)";
  overlay.style.zIndex = "99999";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";

  overlay.innerHTML = `
    <div style="
      background:white;
      padding:20px;
      border-radius:8px;
      font-size:18px;
    ">
      Loading...
    </div>
  `;

  document.body.appendChild(overlay);
}

function hideLoadingOverlay() {
  const overlay = document.getElementById("my-extension-loading");
  if (overlay) {
    overlay.remove();
  }
}

module.exports = {
  showSS: showSSDialog,
  showJS: showJSDialog,
  disableHostOptions: disableHostOptions,
  enableHostOptions: enableHostOptions,
  showLoadingOverlay: showLoadingOverlay,
  hideLoadingOverlay: hideLoadingOverlay,
  INFO: INFO,
  WARN: WARN,
  ERR: ERR,
};
