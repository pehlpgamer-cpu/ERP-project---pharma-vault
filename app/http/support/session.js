// Promise wrappers for the callback API of express-session.

function promisify(req, method) {
  return new Promise((resolve, reject) => {
    req.session[method]((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/** New session id (prevents session fixation); the old session data is discarded. */
export function regenerateSession(req) {
  return promisify(req, "regenerate");
}

export function saveSession(req) {
  return promisify(req, "save");
}

export function destroySession(req) {
  return promisify(req, "destroy");
}
