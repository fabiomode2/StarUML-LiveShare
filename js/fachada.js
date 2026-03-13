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

// Función privada de ayuda para evitar repetir carga de archivos
function _createDialog(templateName) {
  const dialogHTML = fs.readFileSync(
    path.join(__dirname, templateName),
    "utf8",
  );
  return app.dialogs.showModalDialogUsingTemplate(dialogHTML);
}
async function showSSDialog() {
  return new Promise((resolve, reject) => {
    const dialog = _createDialog("../html/ss_dialog.html");
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

      console.log("Sesión Creada:", data);
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
    const dialog = _createDialog("../html/js_dialog.html");
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

module.exports = {
  showSS: showSSDialog,
  showJS: showJSDialog,
  INFO: INFO,
  WARN: WARN,
  ERR: ERR,
};
