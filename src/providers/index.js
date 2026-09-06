// Registry of remote-store providers, keyed by the name used in the URL and in the
// "<provider>_course_<courseId>" directory naming scheme.

const studip = require("./studip");
const iserv = require("./iserv");

const providers = {
  [studip.name]: studip,
  [iserv.name]: iserv,
};

function getProvider(name) {
  return providers[name] || null;
}

module.exports = { providers, getProvider };
