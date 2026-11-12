import notImplemented from "../support/notImplemented.js";

// The audit trail page is not built yet (rows are written by the services). The route is not
// registered; these handlers answer 501 if someone wires it up before it exists.
export default {
  index: notImplemented,
  show: notImplemented,
  store: notImplemented,
  update: notImplemented,
  replace: notImplemented,
  destroy: notImplemented,
  create: notImplemented,
  edit: notImplemented,
};
