let rendered_mouses = {};
const LERP_SPEED = 0.1;

function LERP(start, dest, speed) {
  return start + speed * (dest - start);
}

function updateMousePosition({ id, x, y, diagram }) {}

module.exports = {
  updateMousePosition: updateMousePosition,
};
