//! WIP...
// Similar to Laravel's Route::resource and Route::apiResource.
import asyncHandler from "../app/http/middleware/asyncHandler.js";

export class RouteBuilder {
  #router;

  constructor(router) {
    this.#router = router;
  }

  /**
   * Registers the REST handlers of a controller object. Routes are registered in table order, so
   * literal paths (`/create`) always come before `/:id`.
   * Options: `include` and `exclude` (handler names), `middleware` (run before each handler).
   */
  resource(uri, controllerObject, options = {}) {
    const routes = {
      index: { method: "get", uri },
      create: { method: "get", uri: `${uri}/create` },
      store: { method: "post", uri },
      show: { method: "get", uri: `${uri}/:id` },
      edit: { method: "get", uri: `${uri}/:id/edit` },
      update: { method: "patch", uri: `${uri}/:id` },
      replace: { method: "put", uri: `${uri}/:id` },
      destroy: { method: "delete", uri: `${uri}/:id` },
    };

    this.#assignHandlers(uri, routes, controllerObject, options, "resource");
  }

  /** Like `resource` without the HTML form routes (`create`, `edit`). */
  apiResource(uri, controllerObject, options = {}) {
    const routes = {
      index: { method: "get", uri },
      store: { method: "post", uri },
      show: { method: "get", uri: `${uri}/:id` },
      update: { method: "patch", uri: `${uri}/:id` },
      replace: { method: "put", uri: `${uri}/:id` },
      destroy: { method: "delete", uri: `${uri}/:id` },
    };

    this.#assignHandlers(uri, routes, controllerObject, options, "apiResource");
  }

  #assignHandlers(
    uri,
    routes,
    controllerObject,
    { include = [], exclude = [], middleware = [] },
    type,
  ) {
    const validHandlers = new Set(Object.keys(routes));

    for (const handler of [...include, ...exclude]) {
      if (!validHandlers.has(handler)) {
        throw new Error(`${handler} is invalid RouteBuilder resource method parameter`);
      }
    }

    const selectedHandlers = include.length > 0 ? new Set(include) : new Set(validHandlers);

    for (const handler of exclude) {
      selectedHandlers.delete(handler);
    }

    for (const [handler, route] of Object.entries(routes)) {
      if (!selectedHandlers.has(handler)) {
        continue;
      }

      const controllerHandler = controllerObject[handler];

      if (typeof controllerHandler !== "function") {
        throw new TypeError(`Controller method "${handler}" is required for ${type} "${uri}"`);
      }

      this.#router[route.method](
        route.uri,
        ...middleware.map(asyncHandler),
        asyncHandler(controllerHandler),
      );
    }
  }
}
